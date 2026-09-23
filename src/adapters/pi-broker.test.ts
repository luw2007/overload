import { expect, test } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  JsonlFramer,
  brokerMetadataPath,
  brokerSocketPath,
  readBrokerMetadata,
} from "./pi-broker";

test("JsonlFramer splits newline-delimited records across chunks and strips CR", () => {
  const framer = new JsonlFramer();
  expect(framer.push('{"a":1}\n{"b":2}\r\n')).toEqual([
    { a: 1 },
    { b: 2 },
  ]);
  expect(framer.push(new TextEncoder().encode('{"c":3}\n{"d":4}'))).toEqual([
    { c: 3 },
  ]);
  expect(framer.finish()).toEqual([{ d: 4 }]);
});

test("JsonlFramer rejects non-object JSON records", () => {
  const framer = new JsonlFramer();
  expect(() => framer.push("123\n")).toThrow("rpc_non_object_record");
});

test("broker path helpers embed sessionId under runtimeRoot", () => {
  expect(brokerMetadataPath("/rt", "sess-1")).toBe("/rt/metadata/sess-1.json");
  expect(brokerSocketPath("/rt", "sess-1")).toBe("/rt/sockets/sess-1.sock");
});

test("readBrokerMetadata accepts a valid metadata file and rejects malformed ones", () => {
  const root = mkdtempSync(join(tmpdir(), "broker-meta-"));
  try {
    const valid = join(root, "valid.json");
    writeFileSync(
      valid,
      JSON.stringify({
        sessionId: "s",
        ownerId: "o",
        ownerToken: "t",
        socketPath: "/sock",
        pid: 1,
        state: "running",
        updatedAt: 1,
      }),
    );
    expect(readBrokerMetadata(valid)?.sessionId).toBe("s");

    writeFileSync(join(root, "bad.json"), '{"sessionId":"s"}');
    expect(readBrokerMetadata(join(root, "bad.json"))).toBeNull();
    expect(readBrokerMetadata(join(root, "missing.json"))).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
