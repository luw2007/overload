import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureControlSchema } from "../src/control/store";
import { ensureMgmtSchema } from "../src/manage/schema";
import { mgmtRoute } from "../src/web/mgmt-routes";

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
  db.query("INSERT INTO control_works VALUES (?,?,?,?,?,?,?,?,?)").run("w", "work", "test", "w", "active", 0, null, 1, 1);
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
  return { controlPath, ledgerPath, overloadHome: root };
}

const call = (f: ReturnType<typeof fixture>, path: string, init?: RequestInit) =>
  mgmtRoute(new Request(`http://localhost${path}`, init), new URL(`http://localhost${path}`), f);

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
  const r = await call(f, "/api/mgmt/manifests/m/acceptance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verdict: "accepted", evidence: { note: "good" } }) });
  expect(r!.status).toBe(200);
  const db = new Database(f.controlPath);
  expect(db.query("SELECT verdict FROM mgmt_acceptances WHERE acceptance_id='a'").get()).toEqual({ verdict: "accepted" });
  db.close();
});

test("WEB-38 handoff preconditions report gate state", async () => {
  const f = fixture();
  const r = await call(f, "/api/mgmt/works/w/handoff/preconditions");
  expect(r!.status).toBe(200);
  const body = await r!.json();
  expect(body).toBeTypeOf("object");
  expect(body).not.toBeNull();
});
