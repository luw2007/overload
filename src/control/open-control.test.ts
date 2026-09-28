// CTRL-06: openControl bootstrap on a tmp file path (no ~/.overload touch).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROL_SCHEMA_VERSION, openControl } from "./store";

test("CTRL-06 openControl creates a secured WAL db and boots the control schema", () => {
  const root = mkdtempSync(join(tmpdir(), "control-open-"));
  try {
    const path = join(root, "control.db");
    const db = openControl(path);
    try {
      expect((db.query("PRAGMA journal_mode").get() as any).journal_mode.toLowerCase()).toBe("wal");
      expect(Number((db.query("PRAGMA busy_timeout").get() as any).timeout)).toBeGreaterThan(0);
      expect(db.query("SELECT version FROM control_schema_meta WHERE id=1").get()).toEqual({
        version: CONTROL_SCHEMA_VERSION,
      });
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CTRL-06 openControl is idempotent across reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "control-open-reopen-"));
  try {
    const path = join(root, "control.db");
    const first = openControl(path);
    first.close();
    const second = openControl(path);
    try {
      expect(second.query("SELECT version FROM control_schema_meta WHERE id=1").get()).toEqual({
        version: CONTROL_SCHEMA_VERSION,
      });
    } finally {
      second.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
