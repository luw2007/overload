/**
 * test/recon-cmux-snapshot.test.ts — cmux hook-sessions snapshot contract.
 *
 * cmuxSnapshot/collectCmux (src/recon/recon.ts):
 *  - a `*-hook-sessions.json` glob is resolved across multiple files and merged;
 *  - each row's native_id binds by precedence workspaceId > workspace_id >
 *    workstreamId > id > map key;
 *  - visible = (agentLifecycle !== "unknown"): unknown rows are hidden, every
 *    other lifecycle value (including absent) is visible.
 *
 * tmp isolation: only synthetic *-hook-sessions.json files under mkdtemp.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmuxSnapshot, collectCmux } from "../src/recon/recon";

const dir = mkdtempSync(join(tmpdir(), "overload-rec-cmux-"));

writeFileSync(join(dir, "alpha-hook-sessions.json"), JSON.stringify({
  sessions: {
    "k-workspace": {
      workspaceId: "ws-primary", workstreamId: "ws-shadow", id: "id-shadow",
      cwd: "/repo/a", agentLifecycle: "working",
    },
    "k-workstream": {
      workstreamId: "wl-only", id: "id-shadow", cwd: "/repo/b", agentLifecycle: "working",
    },
  },
}));
writeFileSync(join(dir, "beta-hook-sessions.json"), JSON.stringify({
  sessions: {
    "k-id": { id: "id-only", cwd: "/repo/c", agentLifecycle: "running" },
    "k-unknown": { id: "id-hidden", cwd: "/repo/d", agentLifecycle: "unknown" },
  },
}));
// Ignored: does not match the hook-sessions suffix; must not be parsed.
writeFileSync(join(dir, "not-a-hook.json"), JSON.stringify({ sessions: { bogus: {} } }));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("REC-07: glob merges hook-sessions files and binds native_id + visibility correctly", async () => {
  const snap = await cmuxSnapshot(join(dir, "*-hook-sessions.json"));
  const byId = new Map(snap.sessions.map((s) => [s.native_id, s]));

  expect(snap.sessions.length).toBe(4);
  expect(byId.has("bogus")).toBe(false);

  // Precedence: workspaceId wins over workstreamId/id shadows.
  expect(byId.get("ws-primary")?.visible).toBe(true);
  // workstreamId binds when workspaceId is absent.
  expect(byId.get("wl-only")?.visible).toBe(true);
  // id binds when neither workspaceId nor workstreamId is present.
  expect(byId.get("id-only")?.visible).toBe(true);
  // agentLifecycle=unknown is not visible.
  expect(byId.get("id-hidden")?.visible).toBe(false);
});

test("REC-07: collectCmux falls back to map key, and treats missing agentLifecycle as visible", () => {
  const out1: Array<{ native_id: string; cwd?: string; visible: boolean }> = [];
  // No sessions wrapper: root itself is the map.
  collectCmux({ "k-direct": { id: "direct-id", agentLifecycle: "idle" } }, out1 as never);
  expect(out1[0]).toMatchObject({ native_id: "direct-id", visible: true });

  const out2: Array<{ native_id: string; cwd?: string; visible: boolean }> = [];
  // No id/workspaceId/workstreamId → key becomes native_id; missing lifecycle → visible.
  collectCmux({ "k-naked": { cwd: "/x" } }, out2 as never);
  expect(out2[0]).toMatchObject({ native_id: "k-naked", visible: true });
});
