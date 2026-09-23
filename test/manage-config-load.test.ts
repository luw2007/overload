import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { loadManageConfig } from "../src/manage/manage";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const DAY = 86_400_000;

test("MAN-31: loadManageConfig returns built-in defaults for an empty tmp HOME", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "overload-man31-default-"));
  dirs.push(home);
  const overloadHome = join(home, ".overload");
  await mkdir(overloadHome, { recursive: true });

  const cfg = loadManageConfig(overloadHome);

  expect(cfg.enabled).toBe(false);
  expect(cfg.agents).toEqual(["pi", "omp", "claude"]);
  expect(cfg.hosts).toEqual([{ host: "local", kind: "local" }]);
  expect(cfg.lookback_ms).toBe(7 * DAY);
  expect(cfg.follow_new).toBe(true);
  expect(cfg.snapshot).toEqual({
    file_max_bytes: 2 * 1024 * 1024,
    work_max_bytes: 64 * 1024 * 1024,
    retain_ms: 30 * DAY,
  });
  expect(cfg.archive_grace_ms).toBe(30 * 60_000);
  expect(cfg.snapshot_root).toBe(join(overloadHome, "artifacts/mgmt"));
});

test("MAN-31: loadManageConfig reads host from ~/.overload/host", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "overload-man31-host-"));
  dirs.push(home);
  const overloadHome = join(home, ".overload");
  await mkdir(overloadHome, { recursive: true });
  await writeFile(join(overloadHome, "host"), "devbox\n");

  const cfg = loadManageConfig(overloadHome);
  expect(cfg.hosts).toEqual([{ host: "devbox", kind: "local" }]);
});
