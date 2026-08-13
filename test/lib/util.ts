/**
 * Test helpers: temp-dir lifecycle and small fixtures.
 * Tests must be deterministic & isolated (mktemp-style temp dirs, never real
 * ~/.overload). We use Bun's shell for mktemp -d.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let seq = 0;

/** Create a unique temp dir under the OS tmp root, prefixed for cleanup. */
export function makeTempDir(label = "overload-n3"): string {
  // mkdtempSync is atomic and unique; the prefix makes stray dirs identifiable.
  const base = join(tmpdir(), `${label}-`);
  const d = mkdtempSync(base);
  return d;
}

/** Remove a temp dir (recursive, force). Safe to call on non-existent paths. */
export function cleanupTempDir(d: string): void {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/** A monotonically increasing counter for unique per-test ids (no Math.random). */
export function nextCounter(): number {
  seq += 1;
  return seq;
}
