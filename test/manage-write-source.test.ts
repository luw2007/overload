import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { localSourceFs, writeSourceFile, type SourceFs } from "../src/manage/source";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("MAN-52: local writeSourceFile creates missing parent dirs and writes content", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "overload-man52-local-"));
  dirs.push(dir);
  const out = join(dir, "nested", "deep", "out.txt"); // parent does not exist yet
  const content = new TextEncoder().encode("hello overload");

  await writeSourceFile(localSourceFs("local"), out, content);

  expect(existsSync(out)).toBe(true);
  expect(new TextDecoder().decode(await readFile(out))).toBe("hello overload");
});

test("MAN-52: remote writeSourceFile mkdirs parent, truncates then appends 48KB base64 chunks (Darwin -D)", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "overload-man52-remote-"));
  dirs.push(dir);
  const path = "/remote/path/deep/file.bin";
  const parent = "/remote/path/deep";

  // ~100KB payload -> base64 ~133KB -> 48000+48000+remainder chunks.
  const raw = new Uint8Array(100_000);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 31 + 7) & 0xff;

  const calls: string[][] = [];
  const fakeRemote: SourceFs = {
    host: { host: "dev-id", kind: "ssh", remote: "dev-alias" },
    listFiles: async () => [],
    readRange: async () => null,
    readFile: async () => null,
    exec: async (_cwd, argv) => {
      calls.push(argv);
      if (argv[0] === "uname" && argv[1] === "-s") return { code: 0, stdout: "Darwin\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };

  await writeSourceFile(fakeRemote, path, raw);

  // mkdir -p parent
  const mkdirCall = calls.find((a) => a[0] === "mkdir" && a[1] === "-p");
  expect(mkdirCall).toBeDefined();
  expect(mkdirCall![2]).toBe(parent);

  // truncate: sh -c ': > "$1"
  const truncate = calls.find((a) => a[2] === ": > \"$1\"");
  expect(truncate).toBeDefined();
  expect(truncate![truncate!.length - 1]).toBe(path);

  // base64 append chunks
  const base64Calls = calls.filter((a) => a[0] === "sh" && a[1] === "-c" && String(a[2]).includes("base64"));
  expect(base64Calls.length).toBeGreaterThan(1);
  for (const c of base64Calls) {
    expect(String(c[2])).toContain("base64 -D"); // Darwin decode flag
    expect(String(c[2])).not.toContain("base64 -d");
  }
  const chunks = base64Calls.map((c) => c[c.length - 2] as string);
  // All but the last chunk are exactly 48KB; the last is the remainder.
  for (let i = 0; i < chunks.length - 1; i++) expect(chunks[i]!.length).toBe(48_000);
  expect(chunks[chunks.length - 1]!.length).toBeLessThanOrEqual(48_000);

  // Reassembled base64 must decode back to the original bytes.
  const reassembled = chunks.join("");
  expect(Buffer.from(reassembled, "base64").length).toBe(raw.length);
});
