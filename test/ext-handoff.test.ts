import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let currentHome = "";
mock.module("node:os", () => ({ homedir: () => currentHome, tmpdir }));

type Handler = (event: unknown, ctx: unknown) => unknown;
let importCounter = 0;
const homes: string[] = [];

async function harness() {
  const home = mkdtempSync(join(tmpdir(), "overload-ext-handoff-"));
  homes.push(home);
  currentHome = home;
  mkdirSync(join(home, ".overload"), { recursive: true });
  writeFileSync(join(home, ".overload", "config.json"), JSON.stringify({ approval_gate: { enabled: false } }));
  const handlers = new Map<string, Handler[]>();
  const { default: overload } = await import(`../src/extension/overload.ts?handoff-test=${++importCounter}`);
  overload({
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as never);
  const dispatch = (name: string, event: unknown, ctx: unknown = {}) =>
    (handlers.get(name) ?? []).map((handler) => handler(event, ctx));
  await Promise.all(dispatch("session_start", { reason: "startup" }, {
    cwd: home,
    sessionManager: { getSessionId: () => `handoff-session-${importCounter}` },
  }));
  return {
    home,
    dispatch,
    async close() {
      await Promise.all(dispatch("session_shutdown", { reason: "test_end" }));
      const hostDir = join(home, ".overload", "spool", "local");
      const sealed = (readdirSync(hostDir, { recursive: true }) as string[]).filter((name) => name.includes("seg-"));
      return sealed.flatMap((name) => readFileSync(join(hostDir, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    },
  };
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("HANDOFF.md capture", () => {
  test("captures current handoff status and uncertainty count", async () => {
    const h = await harness();
    await Promise.all(h.dispatch("before_agent_start", {}));
    writeFileSync(join(h.home, "HANDOFF.md"), "STATUS — blocked\nUNCERTAINTIES\nfirst\nsecond\nNEXT_OWNER — reviewer\n");
    const fresh = new Date(Date.now() + 1);
    utimesSync(join(h.home, "HANDOFF.md"), fresh, fresh);
    await Promise.all(h.dispatch("agent_settled", {}));
    const events = await h.close();
    const settled = events.find((event: { kind: string }) => event.kind === "settled");
    expect(settled?.detail?.handoff).toMatchObject({ status: "blocked", uncertainties: 2, next_owner: "reviewer" });
  });

  test("ignores handoff older than run start", async () => {
    const h = await harness();
    writeFileSync(join(h.home, "HANDOFF.md"), "STATUS — blocked\nUNCERTAINTIES\nold\n");
    const old = new Date(Date.now() - 10_000);
    utimesSync(join(h.home, "HANDOFF.md"), old, old);
    await Promise.all(h.dispatch("before_agent_start", {}));
    await Promise.all(h.dispatch("agent_settled", {}));
    const events = await h.close();
    const settled = events.find((event: { kind: string }) => event.kind === "settled");
    expect(settled?.detail?.handoff).toBeUndefined();
  });
});
