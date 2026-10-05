// ADP-20 (guard branches): PiRuntime.start rejects mismatched ownerId/cwd and a
// stopped existing session BEFORE spawning any broker child. We seed a fake
// broker metadata JSON on a tmp runtimeRoot and assert the pre-spawn throws.
// The live start/connect/restore/shutdown round-trip still requires the real
// pi binary and remains out of bun test scope.
import { expect, test } from "bun:test";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRuntime } from "./pi";
import {createServer,type Socket} from 'node:net';
import {captureProcessIdentity,JsonlFramer} from './pi-broker';

function seedMetadata(root: string, sessionId: string, fields: Record<string, unknown>): void {
  mkdirSync(join(root, "metadata"), { recursive: true });
  writeFileSync(
    join(root, "metadata", `${sessionId}.json`),
    JSON.stringify({
      sessionId,
      ownerId: "owner",
      ownerToken: "tok",
      socketPath: join(root, "sockets", `${sessionId}.sock`),
      ...fields,
    }),
  );
}

test("ADP-20 start rejects an owner/cwd mismatch before spawning the broker", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-guard-"));
  try {
    seedMetadata(root, "s1", { cwd: "/repo", state: "running" });
    const runtime = new PiRuntime({ runtimeRoot: root, spawnBroker: async () => { throw new Error("should not spawn"); } });
    await expect(
      runtime.start({ sessionId: "s1", ownerId: "intruder", cwd: "/repo" }),
    ).rejects.toThrow("runtime_ownership_mismatch");
    await expect(
      runtime.start({ sessionId: "s1", ownerId: "owner", cwd: "/other" }),
    ).rejects.toThrow("runtime_ownership_mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ADP-20 start rejects an existing stopped session before spawning the broker", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-guard-stopped-"));
  try {
    seedMetadata(root, "s2", { cwd: "/repo", state: "stopped" });
    const runtime = new PiRuntime({ runtimeRoot: root, spawnBroker: async () => { throw new Error("should not spawn"); } });
    await expect(
      runtime.start({ sessionId: "s2", ownerId: "owner", cwd: "/repo" }),
    ).rejects.toThrow("runtime_session_exists_stopped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shutdown rejects mismatched owner without signaling broker',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-shutdown-owner-'));
 try{
  seedMetadata(root,'owned',{cwd:'/repo',state:'running'});
  const runtime=new PiRuntime({runtimeRoot:root,commandTimeoutMs:5});
  await expect(runtime.shutdown({runtimeKind:'pi',sessionId:'owned',ownerId:'intruder',cwd:'/repo'})).rejects.toThrow('runtime_ownership_mismatch');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('shutdown ACK cannot release ownership while the recorded child is still alive',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-shutdown-unconfirmed-'));
 const socketPath=join(root,'broker.sock'),sockets=new Set<Socket>();
 const identity=captureProcessIdentity(process.pid);
 if(!identity)throw Error('process identity unavailable for live-child regression');
 const fields={cwd:'/repo',state:'running',socketPath,brokerIdentity:identity,childIdentity:identity};
 let shutdowns=0;
 const server=createServer(socket=>{
  sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
  const framer=new JsonlFramer();
  socket.on('data',data=>{
   for(const message of framer.push(data)){
    if(message.op==='hello')socket.write(JSON.stringify({type:'hello',ok:true,reference:{runtimeKind:'pi',sessionId:'owned',ownerId:'owner',cwd:'/repo'}})+'\n');
    else if(message.op==='command'){
     const payload=message.payload as {type?:string}|undefined;
     if(payload?.type==='shutdown'){
      shutdowns++;
      // Even stopped metadata is insufficient when its exact child incarnation is alive.
      seedMetadata(root,'owned',{...fields,state:'stopped'});
      socket.write(JSON.stringify({type:'command_response',commandId:message.commandId,state:'accepted'})+'\n');
     }
    }
   }
  });
 });
 try{
  seedMetadata(root,'owned',fields);
  const listening=Promise.withResolvers<void>();
  server.once('error',listening.reject);server.listen(socketPath,listening.resolve);
  await listening.promise;
  const runtime=new PiRuntime({runtimeRoot:root,commandTimeoutMs:100});
  const result=await runtime.shutdown({runtimeKind:'pi',sessionId:'owned',ownerId:'owner',cwd:'/repo'});
  expect(shutdowns).toBe(1);
  expect(result.state).toBe('unknown');
 }finally{
  for(const socket of sockets)socket.destroy();
  const closed=Promise.withResolvers<void>();
  server.close(()=>closed.resolve());await closed.promise;
  rmSync(root,{recursive:true,force:true});
 }
});
