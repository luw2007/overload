// Gap-fill tests for pass stories whose existing evidence only covered the happy
// path. Local-only, tmp DB / fake channel, no real pi or Feishu.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMailbox } from "../decision-bot/mailbox";
import { AdapterService } from "./service";
import type { ChannelAdapter } from "./types";

function dupChannel(): ChannelAdapter {
  return {
    kind: "test",
    instanceId: "same",
    capabilities: { update: true, actions: true },
    async start() {},
    async stop() {},
    async send() { return { state: "sent", messageId: "m" }; },
  };
}

test("ADP-21 AdapterService rejects duplicate channel instanceId", () => {
  const root = mkdtempSync(join(tmpdir(), "adapter-dup-"));
  try {
    const db = openMailbox(join(root, "c.db"));
    expect(() => new AdapterService(db, { runtime: {} as any, channels: [dupChannel(), dupChannel()], cwd: root })).toThrow("duplicate_channel_instance");
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
