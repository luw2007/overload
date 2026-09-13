import { describe, expect, test } from "bun:test"
import { scrubText } from "../src/shared/redact"
import { buildSharePackage, classifyContent } from "../src/manage/classify"

describe("redaction and management export boundary", () => {
  test("scrubs the union of caller patterns and truncates", () => {
    for (const value of ["sk-abcdefghijkl", "ghp_abcdefghijkl", "xoxb-abcdefghijkl", "token=secret", "api-key: value", "secret=value"]) {
      expect(scrubText(value)).not.toContain(value.split(/[=:]/)[1] || value)
    }
    expect(scrubText("abcdefghijklmnopqrstuvwxyz", 10)).toHaveLength(10)
  })

  test("classifies denylisted, secret, plain, and binary content", () => {
    expect(classifyContent(".env", new TextEncoder().encode("x=1")).sensitivity).toBe("withheld")
    expect(classifyContent("key.pem", new TextEncoder().encode("-----BEGIN RSA PRIVATE KEY-----")).sensitivity).toBe("withheld")
    expect(classifyContent("a.ts", new TextEncoder().encode('const k = "sk-" + "live_" + "abcdef0123456789abcdef0123456789"')).sensitivity).toBe("none")
    expect(classifyContent("a.txt", new TextEncoder().encode("hello world")).sensitivity).toBe("none")
    expect(classifyContent("a.dat", Uint8Array.from([65, 0, 66])).sensitivity).toBe("suspect")
  })

  test("share package contains references only", () => {
    const output = buildSharePackage([
      { path: "a.txt", size: 1, sha256: "abc", sensitivity: "none", shareable: 1, excerpt: "secret content" },
      { path: ".env", size: 2, sha256: "def", sensitivity: "withheld", shareable: 0, excerpt: "token=x" },
    ])
    const json = JSON.stringify(output)
    expect(json).not.toContain("excerpt")
    expect(json).not.toContain("secret content")
    expect(output.entries).toEqual([{ path: "a.txt", size: 1, sha256: "abc" }])
    expect(output.omitted).toEqual([{ path: ".env", reason: "withheld" }])
  })
})
