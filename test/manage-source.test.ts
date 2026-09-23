import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { buildSshArgv, localSourceFs, shellQuote, sshSourceFs } from "../src/manage/source";
let dirs: string[] = []; afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
test("local source", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "overload-source-")); dirs.push(dir); await mkdir(resolve(dir, "nested"));
  const path = resolve(dir, "nested/a.jsonl"); await writeFile(path, "abcdef"); const info = await stat(path);
  const source = localSourceFs("test");
  expect(await source.listFiles(dir, { sinceMs: info.mtimeMs - 1, suffix: ".jsonl" })).toHaveLength(1);
  expect(await source.listFiles(dir, { sinceMs: info.mtimeMs + 1, suffix: ".jsonl" })).toEqual([]);
  expect(await source.readRange(path, 2, 2)).toMatchObject({ nextByte: 4, eof: false, generation: `${info.ino}:6` });
  const read = await source.readFile(path, 3); expect(new TextDecoder().decode(read!.bytes)).toBe("abc"); expect(read).toMatchObject({ truncated: true, sha256: createHash("sha256").update("abc").digest("hex") });
  expect(await source.readFile(resolve(dir, "missing"), 3)).toBeNull();
  const exec = await source.exec(dir, ["git", "--version"], 5000); expect(exec.code).toBe(0); expect(exec.stdout).toContain("git version");
});
test("ssh command builder quotes without a shell locally", () => {
  expect(shellQuote("a b'c")).toBe("'a b'\\''c'");
  expect(buildSshArgv({ host:"dev", kind:"ssh", remote:"devbox", ssh_cmd:"custom-ssh" }, `cat -- ${shellQuote("/a b/c'd")}`)).toEqual([
    "custom-ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", "devbox", "cat -- '/a b/c'\\''d'",
  ]);
});

test("ssh source preserves odd paths and caches platform detection", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "overload ssh 'source-")); dirs.push(dir);
  const ssh = resolve(dir, "ssh"), log = resolve(dir, "commands");
  await writeFile(ssh, `#!/bin/sh\nfor last do :; done\nprintf '%s\\n' "$last" >> ${shellQuote(log)}\nexec sh -c "$last"\n`); await chmod(ssh, 0o755);
  const nested = resolve(dir, "nested space'quote"); await mkdir(nested); const path = resolve(nested, "a b'c.jsonl"); await writeFile(path, "abcdef"); const info = await stat(path);
  const source = sshSourceFs({ host: "test", kind: "ssh", remote: "ignored", ssh_cmd: ssh });
  expect(await source.listFiles(dir, { sinceMs: info.mtimeMs - 2000, suffix: ".jsonl" })).toEqual([{ path, mtimeMs: Math.floor(info.mtimeMs / 1000) * 1000, size: 6 }]);
  expect(new TextDecoder().decode((await source.readRange(path, 1, 3))!.bytes)).toBe("bcd");
  expect((await Bun.file(log).text()).split("\n").filter((line) => line === "uname -s")).toHaveLength(1);
});

test("ssh list builds GNU and BSD stat commands", async () => {
  for (const [uname, expected] of [["Linux", "stat -c '%Y %s %n'"], ["Darwin", "stat -f '%m %z %N'"]] as const) {
    const dir = await mkdtemp(resolve(tmpdir(), `overload-${uname}-`)); dirs.push(dir); const ssh = resolve(dir, "ssh"), log = resolve(dir, "commands");
    await writeFile(ssh, `#!/bin/sh\nfor last do :; done\nprintf '%s\\n' "$last" >> ${shellQuote(log)}\nif [ "$last" = 'uname -s' ]; then echo ${uname}; else echo '1 2 /tmp/a.jsonl'; fi\n`); await chmod(ssh, 0o755);
    await sshSourceFs({ host: uname, kind: "ssh", remote: "ignored", ssh_cmd: ssh }).listFiles("/tmp", { sinceMs: 0, suffix: ".jsonl" });
    expect((await Bun.file(log).text()).replaceAll(`'\\''`, "'")).toContain(expected);
  }
});

test("identity helpers follow stable and content identity contracts", async () => {
  const { artifactId, canonicalFileKey, stableId, versionId } = await import("../src/manage/identity");
  expect(stableId("devbox", "pi", "uuid")).toBe("devbox:pi:uuid");
  const artifact = createHash("sha256").update("workfilea.ts").digest("hex").slice(0, 32);
  expect(artifactId("work", "file", "a.ts")).toBe(artifact);
  expect(versionId(artifact, "content", "abc")).toBe(createHash("sha256").update(`${artifact}:content:abc`).digest("hex").slice(0, 32));
  expect(canonicalFileKey("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
  expect(canonicalFileKey("/repo", "/else/a.ts")).toBe("/else/a.ts");
});
