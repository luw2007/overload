export type ChannelIdentity={instanceId:string;tenantId:string;userId:string};
export type ChannelAddress={instanceId:string;tenantId:string;chatId:string;threadId?:string};
export type ChannelEvent={eventId:string;identity:ChannelIdentity;address:ChannelAddress;messageId:string;receivedAt:number;kind:'message';text:string}|{eventId:string;identity:ChannelIdentity;address:ChannelAddress;messageId:string;receivedAt:number;kind:'decision';itemId:string;revision:number;answer:string};
export type ChannelMessage={deliveryId:string;address:ChannelAddress;text:string;replyTo?:string;replaceMessageId?:string;decision?:{itemId:string;revision:number;title:string;owner:string;options:string[];state:string;expiresAt?:number;reviewUrl?:string}};
export type DeliveryReceipt={state:'sent';messageId:string}|{state:'retryable'|'failed'|'unknown';reason:string};
export interface ChannelAdapter{readonly kind:string;readonly instanceId:string;readonly capabilities:{update:boolean;actions:boolean};start(accept:(event:ChannelEvent)=>Promise<void>):Promise<void>;stop():Promise<void>;send(message:ChannelMessage):Promise<DeliveryReceipt>}
export type SessionReference={runtimeKind:string;sessionId:string;ownerId:string;cwd:string;sessionFile?:string};
export type StartRequest={sessionId:string;ownerId:string;cwd:string;provider?:string;model?:string};
export type TurnRequest={turnId:string;text:string};
export type CommandReceipt={state:'accepted'|'rejected'|'unknown';commandId:string;reason?:string};
export type RuntimeEvent={eventId:string;sessionId:string;turnId?:string;kind:'output'|'completed'|'failed'|'unknown'|'blocked';text?:string;reason?:string;checkpoint?:string;requestId?:string;requestMethod?:'select'|'confirm'|'input'|'editor';options?:string[];expiresAt?:number};
export interface SessionHandle{readonly reference:SessionReference;readonly events:AsyncIterable<RuntimeEvent>;submit(request:TurnRequest):Promise<CommandReceipt>;cancel(turnId:string):Promise<CommandReceipt>;answer?(requestId:string,value:string):Promise<CommandReceipt>;close():Promise<void>}
export interface AgentRuntime{readonly kind:string;readonly capabilities:{restore:boolean;answer:boolean;steer:boolean};start(request:StartRequest):Promise<SessionHandle>;connect(reference:SessionReference):Promise<SessionHandle>;restore?(reference:SessionReference):Promise<SessionHandle>}
