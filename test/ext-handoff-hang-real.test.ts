/**
 * Verifier: a real TCP control plane that accepts and never answers must not
 * hold before_agent_start past the 1500ms deadline, and turn_start is never
 * touched by the handoff poll (manager-chat spec §3 extension, §5 B).
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let currentHome = "";
mock.module("node:os", () => ({ homedir: () => currentHome, tmpdir }));
type Handler = (event: unknown, ctx: unknown) => unknown;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("extension handoff poll against a hanging socket", () => {
  test("before_agent_start returns within the deadline; turn_start does not poll", async () => {
    const sockets: Array<{ end: () => void }> = [];
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(s) { sockets.push(s); }, data() {} } });
    const home = mkdtempSync(join(tmpdir(), "overload-ext-handoff-hang-")); roots.push(home); currentHome = home;
    mkdirSync(join(home, ".overload"), { recursive: true });
    writeFileSync(join(home, ".overload", "config.json"), JSON.stringify({ web_port: listener.port }));
    const handlers = new Map<string, Handler[]>();
    const { default: overload } = await import(`../src/extension/overload.ts?handoff-hang-real=1`);
    overload({ on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]), registerTool: () => {} } as never);
    // Sequential like pi's runner (emitBeforeAgentStart awaits each handler in order).
    const dispatchSeq = async (name: string, event: unknown = {}, ctx: unknown = {}) => { const out = []; for (const h of handlers.get(name) ?? []) out.push(await h(event, ctx)); return out; };
    try {
      await dispatchSeq("session_start", { reason: "startup" }, { cwd: home, sessionManager: { getSessionId: () => "hang" } });
      let started = Date.now();
      const results = await dispatchSeq("before_agent_start");
      const elapsed = Date.now() - started;
      expect(results.filter(Boolean)).toEqual([]);
      expect(elapsed).toBeGreaterThanOrEqual(1000); // it really waited on the socket...
      expect(elapsed).toBeLessThan(2000);            // ...but not past the deadline
      expect(sockets.length).toBeGreaterThan(0);
      const before = sockets.length;
      started = Date.now();
      await dispatchSeq("turn_start");
      expect(Date.now() - started).toBeLessThan(200);
      expect(sockets.length).toBe(before);
      await dispatchSeq("session_shutdown", { reason: "test_end" });
    } finally { for (const s of sockets) s.end(); listener.stop(true); }
  });
});
