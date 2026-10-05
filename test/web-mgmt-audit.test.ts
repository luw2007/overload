import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureControlSchema, getAttention, getAttentionMaterial } from "../src/control/store";
import { ensureMgmtSchema } from "../src/manage/schema";
import { mgmtRoute } from "../src/web/mgmt-routes";
import {requestAcceptance,type ManifestDecisionBasis} from '../src/manage/manifest';
import type {MgmtRouteOptions} from '../src/web/mgmt-routes';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "overload-mgmt-audit-"));
  roots.push(root);
  const controlPath = join(root, "control.db");
  const ledgerPath = join(root, "ledger.db");
  const db = new Database(controlPath);
  ensureControlSchema(db);
  ensureMgmtSchema(db);
  db.query("INSERT INTO control_works VALUES (?,?,?,?,?,?,?,?,?)").run("w", "work", "test", "w", "active", 1, null, 1, 1);
  db.query("INSERT INTO mgmt_work_profile(work_id,origin_mode,closeout_owner,track_state,decision_owner,discovered_title,input_head,updated_at) VALUES ('w','discovered','mgmt','tracking','owner','work','secret input',1)").run();
  db.query("INSERT INTO mgmt_manifests(manifest_id,work_id,verification,built_by,built_at) VALUES ('m','w','[]','owner',2)").run();
  db.query("INSERT INTO mgmt_acceptances VALUES ('a','w','m','accepted','owner','{}',NULL,NULL)").run();
  db.close();
  const ledger = new Database(ledgerPath);
  ledger.exec(readFileSync(new URL("../src/ingest/schema.sql", import.meta.url), "utf8"));
  ledger.query("INSERT INTO sessions(stable_id,host,runtime,session,origin,cwd,first_seen_at) VALUES ('s','local','pi','s','human','/tmp',1)").run();
  ledger.close();
  writeFileSync(join(root, "host"), "local");
  writeFileSync(join(root, "config.json"), JSON.stringify({ manage: { hosts: [{ host: "local", kind: "local" }] } }));
  return { controlPath, ledgerPath, overloadHome: root, actor: "owner" };
}

const call = (f: MgmtRouteOptions, path: string, init?: RequestInit) =>
  mgmtRoute(new Request(`http://localhost${path}`, init), new URL(`http://localhost${path}`), f);

function acceptanceBasis(controlPath: string): ManifestDecisionBasis {
  const db = new Database(controlPath);
  try {
    const {item_id}=requestAcceptance(db,'m',Date.now());
    const card=getAttention(db,item_id)!,material=getAttentionMaterial(db,item_id)!;
    return {attention_revision:card.revision,material_fingerprint:material.fingerprint};
  } finally {db.close();}
}

test("WEB-36 list works by track filter and toggles tracking", async () => {
  const f = fixture();
  const list = await call(f, "/api/mgmt/works?track=tracking");
  expect(list!.status).toBe(200);
  const rows = await list!.json();
  expect(Array.isArray(rows)).toBe(true);
  expect(rows.map((r: { work_id: string }) => r.work_id)).toContain("w");

  const off = await call(f, "/api/mgmt/works/w/track", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: false }) });
  expect(off!.status).toBe(200);
  const db = new Database(f.controlPath);
  expect(db.query("SELECT track_state FROM mgmt_work_profile WHERE work_id='w'").get()).toEqual({ track_state: "paused" });
  db.close();

  const badTrack = await call(f, "/api/mgmt/works?track=nonsense");
  expect(badTrack!.status).toBe(400);
});

test("WEB-37 acceptance verdict accepted records owner verdict", async () => {
  const f = fixture();
  const seed = new Database(f.controlPath);
  seed.query("DELETE FROM mgmt_acceptances WHERE manifest_id='m'").run();
  seed.close();
  const basis=acceptanceBasis(f.controlPath);
  const r = await call(f, "/api/mgmt/manifests/m/acceptance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verdict: "accepted", evidence: { note: "good" }, ...basis }) });
  expect(r!.status).toBe(200);
  const db = new Database(f.controlPath);
  expect(db.query("SELECT actor,evidence FROM mgmt_acceptances WHERE manifest_id='m'").get()).toEqual({ actor: "owner", evidence: JSON.stringify({ note: "good" }) });
  db.close();
});

test("acceptance requires server identity and cannot impersonate the owner from its body", async () => {
  const f = fixture();
  const basis=acceptanceBasis(f.controlPath);
  const request = () => new Request("http://localhost/api/mgmt/manifests/m/acceptance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verdict: "rejected", actor: "owner", ...basis }) });
  const url = new URL(request().url);
  expect((await mgmtRoute(request(), url, { ...f, actor: undefined }))!.status).toBe(501);
  expect((await mgmtRoute(request(), url, { ...f, actor: "intruder" }))!.status).toBe(409);
  const db = new Database(f.controlPath);
  expect(db.query("SELECT verdict,actor FROM mgmt_acceptances WHERE manifest_id='m'").all()).toEqual([{ verdict: "accepted", actor: "owner" }]);
  db.close();
});

test("acceptance API rejects absent and outdated observed decision basis", async()=>{
  const f=fixture(),db=new Database(f.controlPath);
  db.run("DELETE FROM mgmt_acceptances WHERE manifest_id='m'");db.close();
  const decide=(basis:Partial<ManifestDecisionBasis>)=>call(f,'/api/mgmt/manifests/m/acceptance',{method:'POST',body:JSON.stringify({verdict:'accepted',...basis})});
  expect((await decide({}))!.status).toBe(409);
  const first=acceptanceBasis(f.controlPath);
  expect((await decide({}))!.status).toBe(400);
  const current=acceptanceBasis(f.controlPath);
  expect((await decide(first))!.status).toBe(409);
  expect((await decide(current))!.status).toBe(200);
  const inspect=new Database(f.controlPath);
  expect(inspect.query('SELECT verdict,actor FROM mgmt_acceptances').all()).toEqual([{verdict:'accepted',actor:'owner'}]);
  inspect.close();
});

test("WEB-38 handoff preconditions report gate state", async () => {
  const f = fixture();
  const r = await call(f, "/api/mgmt/works/w/handoff/preconditions");
  expect(r!.status).toBe(200);
  const body = await r!.json();
  expect(body).toBeTypeOf("object");
  expect(body).not.toBeNull();
});
