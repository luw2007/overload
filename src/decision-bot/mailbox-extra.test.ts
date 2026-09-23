import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonical,
  closeTarget,
  digest,
  getTarget,
  openMailbox,
  registerTarget,
} from "./mailbox";

test("canonical sorts object keys and digest is stable sha256", () => {
  expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  expect(digest({ b: 1, a: 2 })).toBe(digest({ a: 2, b: 1 }));
  expect(digest("x")).not.toBe(digest("y"));
});

test("closeTarget marks an active target closed without touching consumed ones", () => {
  const root = mkdtempSync(join(tmpdir(), "mailbox-close-"));
  const db = openMailbox(join(root, "m.db"));
  try {
    const t = registerTarget(db, {
      consumerOwner: "extension", approvalId: "a", question: "Q",
      options: ["ok"], effect: "push", scope: { gate: "g" }, evidence: {},
      expiresAt: Date.now() + 60_000,
    });
    closeTarget(db, "extension", "a", "cancelled");
    expect(getTarget(db, "extension", "a")?.state).toBe("closed");
    expect(getTarget(db, "extension", "a")?.state).not.toBe("consumed");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
