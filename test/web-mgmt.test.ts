import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureControlSchema } from "../src/control/store";
import { ensureMgmtSchema } from "../src/manage/schema";
import { createHandoff } from "../src/manage/handoff";
import { mgmtRoute } from "../src/web/mgmt-routes";

const roots: string[] = [];
afterEach(() => {
 for (const root of roots.splice(0))
  rmSync(root, { recursive: true, force: true });
});
function fixture(coverage = "ledger_full", state = "done") {
 const root = mkdtempSync(join(tmpdir(), "overload-web-mgmt-"));
 roots.push(root);
 const controlPath = join(root, "control.db"),
  ledgerPath = join(root, "ledger.db");
 const db = new Database(controlPath);
 ensureControlSchema(db);
 ensureMgmtSchema(db);
 const ledger = new Database(ledgerPath);
 ledger.exec(
  readFileSync(new URL("../src/ingest/schema.sql", import.meta.url), "utf8"),
 );
 db
  .query("INSERT INTO control_works VALUES (?,?,?,?,?,?,?,?,?)")
  .run("w", "work", "test", "w", "active", 0, null, 1, 1);
 db
  .query(
   "INSERT INTO mgmt_work_profile(work_id,origin_mode,closeout_owner,track_state,decision_owner,discovered_title,input_head,updated_at) VALUES ('w','discovered','mgmt','tracking','owner','work','secret input',1)",
  )
  .run();
 db
  .query("INSERT INTO mgmt_session_binding VALUES ('s','w','origin','seed',1)")
  .run();
 db
  .query(
   "INSERT INTO mgmt_executions(execution_id,work_id,stable_id,writer_id,attempt_no,exec_state,source_coverage,ledger_evidence,started_at,cwd) VALUES ('e','w','s','wr',1,'running',?,'{}',1,'/tmp')",
  )
  .run(coverage);
 ledger
  .query(
   "INSERT INTO sessions(stable_id,host,runtime,session,origin,cwd,first_seen_at) VALUES ('s','local','pi','s','human','/tmp',1)",
  )
  .run();
 ledger
  .query(
   "INSERT INTO current(stable_id,writer_id,state,origin,last_event_at) VALUES ('s','wr',?,'human',?)",
  )
  .run(state, Date.now());
 db.close();
 ledger.close();
 writeFileSync(join(root,"host"),"local");
 writeFileSync(join(root,"config.json"),JSON.stringify({manage:{hosts:[{host:"local",kind:"local"}]}}));
 return { controlPath, ledgerPath, overloadHome:root };
}
const call = (
 f: ReturnType<typeof fixture>,
 path: string,
 init?: RequestInit,
) =>
 mgmtRoute(
  new Request(`http://localhost${path}`, init),
  new URL(`http://localhost${path}`),
  f,
 );
describe("management web routes", () => {
 test("manifest routes expose list, 404, acceptance validation, and poll shapes", async () => {
  const f = fixture(),
   db = new Database(f.controlPath);
  db
   .query(
    "INSERT INTO mgmt_manifests(manifest_id,work_id,verification,built_by,built_at) VALUES ('m','w','[]','owner',2)",
   )
   .run();
  db
   .query(
    "INSERT INTO mgmt_acceptances VALUES ('a','w','m','accepted','owner','{}',NULL,NULL)",
   )
   .run();
  db.close();
  let r = await call(f, "/api/mgmt/works/w/manifests");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual([
   {
    manifest_id: "m",
    built_at: 2,
    entries: 0,
    acceptance: {
     acceptance_id: "a",
     verdict: "accepted",
     actor: "owner",
     invalidated_at: null,
    },
    submission: null,
   },
  ]);
  r = await call(f, "/api/mgmt/works/no/manifests");
  expect(r.status).toBe(404);
  r = await call(f, "/api/mgmt/manifests/m/acceptance", {
   method: "POST",
   body: JSON.stringify({ verdict: "maybe" }),
  });
  expect(r.status).toBe(400);
  r = await call(f, "/api/mgmt/submissions/poll", {
   method: "POST",
   body: "{}",
  });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({
   checked: 0,
   merged: 0,
   failed_observations: 0,
  });
 });
 test("unknown work is 404 and blocked handoff is 409 with allowed", async () => {
  const f = fixture("file_only", "idle");
  expect((await call(f, "/api/mgmt/works/missing"))!.status).toBe(404);
  const r = (await call(f, "/api/mgmt/works/w/handoffs", {
   method: "POST",
   headers: { "content-type": "application/json" },
   body: JSON.stringify({
    target_agent: "pi",
    target_host: "local",
    isolate: false,
   }),
  }))!;
  expect(r.status).toBe(409);
  expect(await r.json()).toMatchObject({
   allowed: ["isolate_with_confirmation"],
  });
 });
 test("launch requires confirmation, abandon transitions, packet contains refs not content", async () => {
  const f = fixture();
  const db = new Database(f.controlPath),
   ledger = new Database(f.ledgerPath);
  const h = createHandoff(db, {
   workId: "w",
   sourceExecutionId: "e",
   targetAgent: "pi",
   ledger,
  });
  db.close();
  ledger.close();
  let r = (await call(f, `/api/mgmt/handoffs/${h.handoff_id}/launch`, {
   method: "POST",
   headers: { "content-type": "application/json" },
   body: "{}",
  }))!;
  expect(r.status).toBe(400);
  r = (await call(f, `/api/mgmt/handoffs/${h.handoff_id}/packet`))!;
  const text = await r.text();
  expect(text).not.toContain("excerpt");
  expect(text).not.toContain("secret input");
  r = (await call(f, `/api/mgmt/handoffs/${h.handoff_id}/abandon`, {
   method: "POST",
   headers: { "content-type": "application/json" },
   body: JSON.stringify({ reason: "operator cancelled" }),
  }))!;
  expect(r.status).toBe(200);
  const verify = new Database(f.controlPath);
  expect(
   verify
    .query("SELECT state FROM mgmt_handoffs WHERE handoff_id=?")
    .get(h.handoff_id),
  ).toEqual({ state: "abandoned" });
  verify.close();
 });
});


test("alias projection preserves history, rejects revival, and correction supersedes evidence", async () => {
 const f=fixture(), db=new Database(f.controlPath);
 db.query("INSERT INTO control_works VALUES (?,?,?,?,?,?,?,?,?)").run("canonical","canonical","test","canonical","candidate",0,null,1,1);
 db.query("INSERT INTO mgmt_work_profile(work_id,origin_mode,closeout_owner,track_state,decision_owner,discovered_title,updated_at) VALUES ('canonical','discovered','mgmt','tracking','owner','canonical',1)").run();
 db.query("INSERT INTO mgmt_artifacts VALUES ('artifact','w','file','/tmp/a','/tmp/a',1)").run();
 db.query("INSERT INTO mgmt_links(link_id,work_id,subject,relation,object,confidence,evidence_ref,observed_at) VALUES ('link','w','e','modified','artifact','strong','jsonl:session#1',1)").run();
 const postBody=(value:unknown)=>({method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(value)});
 let response=await call(f,"/api/mgmt/links/link/correct",postBody({relation:"read",actor:"owner",reason:"Only read this file"}));
 expect(response.status).toBe(200);
 expect(db.query("SELECT relation,superseded_at FROM mgmt_links WHERE link_id='link'").get()).toMatchObject({relation:"modified",superseded_at:expect.any(Number)});
 expect(db.query("SELECT relation FROM mgmt_links WHERE supersedes='link'").get()).toMatchObject({relation:"read"});
 expect(db.query("SELECT actor FROM mgmt_corrections WHERE evidence_ref='jsonl:session#1'").get()).toMatchObject({actor:"owner"});
 response=await call(f,"/api/mgmt/works/w/alias",postBody({canonical_work_id:"canonical",actor:"owner",reason:"Same task"}));
 expect(response.status).toBe(200);
 const detail=await (await call(f,"/api/mgmt/works/canonical")).json();
 expect(detail.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({artifact_id:"artifact",work_id:"w"})]));
 expect(db.query("SELECT work_id FROM mgmt_artifacts WHERE artifact_id='artifact'").get()).toEqual({work_id:"w"});
 response=await call(f,"/api/mgmt/works/w/track",postBody({on:true}));
 expect(response.status).toBe(409);
 expect(db.query("SELECT track_state FROM mgmt_work_profile WHERE work_id='w'").get()).toEqual({track_state:"archived"});
 db.close();
});
