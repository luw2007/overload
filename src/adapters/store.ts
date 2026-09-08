import {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import type {ChannelEvent,ChannelAddress,SessionReference} from './types';
export function ensureAdapterSchema(db:Database):void{db.exec(`
CREATE TABLE IF NOT EXISTS channel_inbound(instance_id TEXT NOT NULL,event_id TEXT NOT NULL,payload TEXT NOT NULL,received_at INTEGER NOT NULL,PRIMARY KEY(instance_id,event_id));
CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,binding_key TEXT UNIQUE NOT NULL,address TEXT NOT NULL,owner_id TEXT NOT NULL,session_reference TEXT,work_id TEXT,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS conversation_turns(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,sequence INTEGER NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,output TEXT,reason TEXT,created_at INTEGER NOT NULL,UNIQUE(conversation_id,sequence));
CREATE TABLE IF NOT EXISTS channel_deliveries(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,business_key TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',message_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,reason TEXT);
CREATE TABLE IF NOT EXISTS runtime_ownership(session_id TEXT PRIMARY KEY,owner_token TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS channel_runtime_events(event_id TEXT NOT NULL,session_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(session_id,event_id));
CREATE TABLE IF NOT EXISTS runtime_decisions(item_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,turn_id TEXT NOT NULL,request_id TEXT NOT NULL,receipt_id TEXT,dispatch_state TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS channel_card_bindings(item_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,message_id TEXT,last_revision INTEGER NOT NULL DEFAULT 0,last_state TEXT);
`);}
export type Conversation={id:string;binding_key:string;address:string;owner_id:string;session_reference:string|null;work_id:string|null;created_at:number};
export type StoredTurn={id:string;conversation_id:string;sequence:number;text:string;state:string;output:string|null;reason:string|null;created_at:number};
export function acceptMessage(db:Database,event:Extract<ChannelEvent,{kind:'message'}>,ownerId:string):{duplicate:boolean;conversationId:string|null;turnId:string|null}{return db.transaction(()=>{
 if(!event.eventId||!event.text.trim()||event.text.length>100000||!event.address.chatId||!ownerId)throw new Error('invalid_channel_message');
 const inserted=db.run('INSERT OR IGNORE INTO channel_inbound VALUES(?,?,?,?)',[event.identity.instanceId,event.eventId,JSON.stringify(event),event.receivedAt]);if(!inserted.changes)return {duplicate:true,conversationId:null,turnId:null};
 const binding=JSON.stringify([event.address.instanceId,event.address.tenantId,event.address.chatId,event.address.threadId??null]);let conversation=db.query('SELECT * FROM conversations WHERE binding_key=?').get(binding) as Conversation|null;
 if(conversation&&conversation.owner_id!==ownerId)throw new Error('conversation_owner_mismatch');
 if(!conversation){const id=randomUUID();db.run('INSERT INTO conversations(id,binding_key,address,owner_id,created_at) VALUES(?,?,?,?,?)',[id,binding,JSON.stringify(event.address),ownerId,event.receivedAt]);conversation=db.query('SELECT * FROM conversations WHERE id=?').get(id) as Conversation;}
 const row=db.query('SELECT COALESCE(MAX(sequence),0)+1 n FROM conversation_turns WHERE conversation_id=?').get(conversation.id) as {n:number};const sequence=row.n;const turnId=randomUUID();db.run('INSERT INTO conversation_turns(id,conversation_id,sequence,text,state,created_at) VALUES(?,?,?,?,?,?)',[turnId,conversation.id,sequence,event.text,'queued',event.receivedAt]);return {duplicate:false,conversationId:conversation.id,turnId};
 }).immediate();}
export function bindSession(db:Database,conversationId:string,reference:SessionReference):void{const updated=db.run('UPDATE conversations SET session_reference=? WHERE id=? AND session_reference IS NULL',[JSON.stringify(reference),conversationId]);if(!updated.changes)throw new Error('session_already_bound');}
export function enqueueDelivery(db:Database,conversationId:string,businessKey:string,address:ChannelAddress,text:string):void{const id=randomUUID();db.run('INSERT OR IGNORE INTO channel_deliveries(id,conversation_id,business_key,payload) VALUES(?,?,?,?)',[id,conversationId,businessKey,JSON.stringify({deliveryId:id,address,text})]);}
