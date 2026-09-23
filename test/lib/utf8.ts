/**
 * UTF-8 codepoint-safe truncation — §2.7 ("detail：UTF-8 码点安全截断（序列化前）").
 *
 * Must NEVER split a multi-byte UTF-8 sequence. Performed on the string BEFORE
 * serialization (so the resulting bytes fit within a budget counting only the
 * string payload, not JSON overhead — the contract says ≤500B for settled detail
 * text). We truncate by codepoint using the spread operator, which respects
 * surrogate pairs (BMP astral chars), then verify byte length.
 *
 * Returns the truncated string (maxBytes in UTF-8).
 */
export function truncateUtf8Safe(s: string, maxBytes: number): string {
  if (maxBytes < 0) throw new Error("maxBytes must be >= 0");
  // Fast path: already within budget.
  const fullBytes = Buffer.byteLength(s, "utf8");
  if (fullBytes <= maxBytes) return s;

  // Lower-bound slice by codepoints. We over-read then shrink by bytes.
  // Codepoints are ≤4 bytes each, so ceil(maxBytes/1) codepoints is an upper
  // bound; we then trim from the right until the byte budget fits.
  const chars = Array.from(s); // respects surrogate pairs (astral codepoints)
  let cut = chars.length;
  let candidate = chars.join("");
  while (Buffer.byteLength(candidate, "utf8") > maxBytes && cut > 0) {
    cut -= 1;
    candidate = chars.slice(0, cut).join("");
  }
  return candidate;
}

/**
 * Truncate every string value found anywhere inside a nested object
 * (recursively), to the given per-string byte budget. Used to enforce the
 * ≤500B text-detail rule from types.ts (settled detail) before serialization.
 * Non-string leaves are untouched.
 */
export function truncateStringLeaves(obj: unknown, maxBytes: number): unknown {
  if (typeof obj === "string") return truncateUtf8Safe(obj, maxBytes);
  if (Array.isArray(obj)) return obj.map((v) => truncateStringLeaves(v, maxBytes));
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = truncateStringLeaves(v, maxBytes);
    }
    return out;
  }
  return obj;
}
