import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfigs } from "./runtime-config";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "runtime-config-")));
  temporary.push(root);
  const allowed = join(root, "repo");
  mkdirSync(allowed);
  const config = join(root, "config.json");
  const gate = { enabled: true, require_approval_write_paths: [root], allowed_write_roots: [allowed], block_bash_patterns: [".*"] };
  const save = (value: unknown = { approval_gate: gate }) => writeFileSync(config, JSON.stringify(value));
  save();
  const entries = [{ chatId: "required", runtimeConfigPath: config }];
  return { root, allowed, config, gate, entries, save };
}
test("required chat accepts canonical confined gate and canonicalizes config aliases", () => {
  const f = fixture();
  const alias = join(f.root, "alias.json"); symlinkSync(f.config, alias);
  expect(loadRuntimeConfigs([...f.entries, { chatId: "required", runtimeConfigPath: alias }], " required ,", f.root).get("required")).toBe(f.config);
});
test("every required authorization entry needs config and root is explicit", () => {
  const f = fixture();
  expect(() => loadRuntimeConfigs(f.entries, "required", "")).toThrow();
  expect(() => loadRuntimeConfigs(f.entries, "required", "relative")).toThrow();
  expect(() => loadRuntimeConfigs(f.entries, "required", f.config)).toThrow();
  expect(() => loadRuntimeConfigs([...f.entries, { chatId: "required" }], "required", f.root)).toThrow();
});
test("strict gate rejects disabled empty uncovered and bash-permitting configurations", () => {
  const f = fixture();
  const invalid = [undefined, { enabled: false }, { ...f.gate, allowed_write_roots: [] }, { ...f.gate, require_approval_write_paths: [] }, { ...f.gate, block_bash_patterns: ["rm"] }, { ...f.gate, require_approval_write_paths: [f.allowed], allowed_write_roots: [f.root] }];
  for (const gate of invalid) { f.save({ approval_gate: gate }); expect(() => loadRuntimeConfigs(f.entries, "required", f.root)).toThrow(); }
});
test("strict gate rejects sibling-prefix escapes symlinks relative and absent directories", () => {
  const f = fixture();
  const outside = realpathSync(mkdtempSync(`${f.root}-sibling-`)); temporary.push(outside);
  const alias = join(f.root, "link"); symlinkSync(outside, alias);
  for (const path of [outside, alias, "relative", join(f.root, "missing")]) {
    f.save({ approval_gate: { ...f.gate, allowed_write_roots: [path] } });
    expect(() => loadRuntimeConfigs(f.entries, "required", f.root)).toThrow();
  }
});
test("ordinary configs preserve absent disabled and unrestricted general gate semantics", () => {
  const f = fixture();
  for (const config of [{}, { approval_gate: { enabled: false } }, { approval_gate: { enabled: true, require_approval_write_paths: ["relative-prefix"], block_bash_patterns: ["rm"] } }]) {
    f.save(config); expect(loadRuntimeConfigs(f.entries, "", "").get("required")).toBe(f.config);
  }
});
test("malformed ordinary configs fail closed without imposing strict policy", () => {
  const f = fixture();
  for (const config of [null, { approval_gate: {} }, { approval_gate: { enabled: true, block_bash_patterns: ["["] } }, { approval_gate: { enabled: true, timeout_ms: 0 } }, { approval_gate: { enabled: true }, web_port: 65536 }]) {
    f.save(config); expect(() => loadRuntimeConfigs(f.entries, "", "")).toThrow();
  }
  writeFileSync(f.config, "{"); expect(() => loadRuntimeConfigs(f.entries, "", "")).toThrow();
});
test("conflicting chat configs reject rather than overwrite", () => {
  const f = fixture(); const second = join(f.root, "second.json"); writeFileSync(second, "{}");
  expect(() => loadRuntimeConfigs([...f.entries, { chatId: "required", runtimeConfigPath: second }], "", "")).toThrow();
  expect(() => loadRuntimeConfigs([...f.entries, { chatId: "required" }], "", "")).toThrow();
  expect(loadRuntimeConfigs([{ chatId: "ordinary" }], "", "").size).toBe(0);
});
test("unknown required chats and server root aliases fail closed", () => {
  const f = fixture();
  expect(() => loadRuntimeConfigs(f.entries, "missing", f.root)).toThrow();
  const alias = join(f.root, "server-alias"); symlinkSync(f.root, alias);
  expect(() => loadRuntimeConfigs(f.entries, "required", alias)).toThrow();
});
test("ordinary enabled allowed roots validate confinement syntax without strict server policy", () => {
  const f = fixture();
  const alias = join(f.root, "repo-alias"); symlinkSync(f.allowed, alias);
  for (const roots of [["relative"], [join(f.root, "missing")], [alias], "invalid"]) {
    f.save({ approval_gate: { enabled: true, allowed_write_roots: roots } });
    expect(() => loadRuntimeConfigs(f.entries, "", "")).toThrow();
  }
  f.save({ approval_gate: { enabled: true, allowed_write_roots: [f.allowed] } });
  expect(loadRuntimeConfigs(f.entries, "", "").get("required")).toBe(f.config);
  f.save({ approval_gate: { enabled: true, allowed_write_roots: [] } });
  expect(loadRuntimeConfigs(f.entries, "", "").get("required")).toBe(f.config);
});
