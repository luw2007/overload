import type { Database } from "bun:sqlite";
import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const SAFE_COMPONENT = /^[A-Za-z0-9._-]+$/;
const SEGMENT_FILE = /^(?:active|seg)-[A-Za-z0-9._-]+-\d+(?:-recovered)?\.ndjson$/;
/** Emitter ids are `<runtime>-<pid>-<random>`; the pid is the liveness handle. */
const EMITTER_PID = /^[A-Za-z0-9._]+-(\d+)-[A-Za-z0-9]+$/;

export type PruneSummary = { files: number; bytes: number; directories: number };

/** The spool is transport, not history: once the journal owns an event, the
 *  spool bytes behind it are disposable. Only this host's tree is pruned —
 *  a pulled tree is a mirror, and rsync would refetch whatever we deleted. */
export async function pruneSpool(db: Database, spoolRoot: string,
  options: { host: string; retentionMs: number; now?: number }): Promise<PruneSummary> {
  const summary: PruneSummary = { files: 0, bytes: 0, directories: 0 };
  if (!SAFE_COMPONENT.test(options.host)) return summary;
  const now = options.now ?? Date.now();
  const hostPath = join(spoolRoot, options.host);
  let emitters;
  try { emitters = await readdir(hostPath, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return summary;
    throw error;
  }

  const consumedCursor = db.query("SELECT bytes FROM cursors WHERE file_name=?");
  const dropCursor = db.query("DELETE FROM cursors WHERE file_name=?");
  for (const emitter of emitters) {
    if (!emitter.isDirectory() || !SAFE_COMPONENT.test(emitter.name)) continue;
    const emitterPath = join(hostPath, emitter.name);
    const dead = emitterIsDead(emitter.name);
    let remaining = 0;
    const removedKeys: string[] = [];
    for (const entry of await readdir(emitterPath, { withFileTypes: true })) {
      if (!entry.isFile() || !SEGMENT_FILE.test(entry.name)) { remaining++; continue; }
      const path = join(emitterPath, entry.name);
      const info = await lstat(path);
      // An unsealed file may still be held open by its writer: only a sealed
      // segment or a dead emitter's leftovers can be removed safely.
      if (!info.isFile() || info.isSymbolicLink() ||
          now - info.mtimeMs <= options.retentionMs ||
          (entry.name.startsWith("active-") && !dead)) { remaining++; continue; }
      const key = relative(resolve(spoolRoot), path).split(sep).join("/");
      if ((consumedCursor.get(key) as { bytes: number } | null)?.bytes !== info.size) { remaining++; continue; }
      await unlink(path);
      removedKeys.push(key);
      summary.files++;
      summary.bytes += info.size;
    }
    if (removedKeys.length) {
      db.transaction(() => { for (const key of removedKeys) dropCursor.run(key); }).immediate();
    }
    if (remaining === 0) {
      try { await rmdir(emitterPath); summary.directories++; } catch { /* raced or not empty */ }
    }
  }
  return summary;
}

/** Unknown or still-running pids keep their files: pid reuse can only make a
 *  dead emitter look alive, which delays a prune instead of losing events. */
function emitterIsDead(emitterId: string): boolean {
  const match = EMITTER_PID.exec(emitterId);
  if (!match) return false;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "EPERM"; }
}
