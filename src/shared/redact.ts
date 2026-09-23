export function scrubText(text: string, maxLen?: number): string {
  const scrubbed = text
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{12,}\b/gi, "[REDACTED]")
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b(authorization|api[_-]?key|token|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
  if (maxLen === undefined || Buffer.byteLength(scrubbed, "utf8") <= maxLen) return scrubbed
  const bytes = Buffer.from(scrubbed)
  let end = maxLen
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString("utf8")
}
