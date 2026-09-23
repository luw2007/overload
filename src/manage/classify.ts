export const SCANNER_VERSION = "1"

export type Sensitivity = "none" | "suspect" | "withheld"
export type ClassifiedContent = { sensitivity: Sensitivity; reasons: string[]; scanner_version: string }

const PATH_DENYLIST = [
  /^\.env(?:\.|$)/i, /\.pem$/i, /\.key$/i, /(?:^|\/)id_rsa[^/]*$/i,
  /credentials?/i, /\.p12$/i, /(?:^|\/)tokens?(?:\.|$)/i,
]
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/i, /\bAKIA[0-9A-Z]{16}\b/, /\bghp_[A-Za-z0-9]{20,}\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/i, /-----BEGIN [^-\n]*PRIVATE KEY-----/i,
  /Authorization:\s*Bearer\s+\S+/i,
]

export function classifyContent(path: string | null, bytes: Uint8Array): ClassifiedContent {
  const reasons: string[] = []
  if (path && PATH_DENYLIST.some((pattern) => pattern.test(path))) {
    return { sensitivity: "withheld", reasons: ["path-denylist"], scanner_version: SCANNER_VERSION }
  }
  const head = bytes.subarray(0, 8192)
  if (head.includes(0)) return { sensitivity: "suspect", reasons: ["binary"], scanner_version: SCANNER_VERSION }
  const text = new TextDecoder().decode(bytes)
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) reasons.push("secret-pattern")
  // Key-like names followed by long base64/hex values are withheld conservatively.
  if (/(?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{32,}/i.test(text)) reasons.push("high-entropy-token")
  return { sensitivity: reasons.length ? "withheld" : "none", reasons, scanner_version: SCANNER_VERSION }
}

type ShareEntry = { path: string; size: number; sha256: string; sensitivity: Sensitivity; shareable: 0 | 1; excerpt?: string }
export function buildSharePackage(entries: ShareEntry[]): { entries: { path: string; size: number; sha256: string }[]; omitted: { path: string; reason: string }[] } {
  const included: { path: string; size: number; sha256: string }[] = []
  const omitted: { path: string; reason: string }[] = []
  for (const entry of entries) {
    if (entry.sensitivity !== "none" || entry.shareable === 0) {
      omitted.push({ path: entry.path, reason: entry.sensitivity !== "none" ? entry.sensitivity : "not-shareable" })
    } else included.push({ path: entry.path, size: entry.size, sha256: entry.sha256 })
  }
  return { entries: included, omitted }
}
