import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

function hash(parts: string[]): string { return createHash("sha256").update(parts.join("")).digest("hex").slice(0, 32); }
export function stableId(host: string, runtime: "pi"|"omp"|"claude", sessionUuid: string): string { return `${host}:${runtime}:${sessionUuid}`; }
export function artifactId(workId: string, kind: "file"|"git_commit"|"git_dirty"|"external", canonicalKey: string): string { return hash([workId, kind, canonicalKey]); }
export function versionId(artifactIdValue: string, contentKind: string, contentSha256: string): string { return hash([artifactIdValue, ":", contentKind, ":", contentSha256]); }
export function canonicalFileKey(repoRoot: string | null, absPath: string): string {
  const absolute = resolve(absPath);
  if (!repoRoot) return absolute;
  const root = resolve(repoRoot); const rel = relative(root, absolute);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolute;
}
