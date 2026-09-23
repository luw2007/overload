import { describe, expect, test } from "bun:test";
import { notificationCapability } from "./nudge";

describe("notificationCapability", () => {
  test("reports actual supported and unsupported platforms", () => {
    expect(notificationCapability("darwin")).toEqual({ available: true, platform: "darwin", reason: null });
    expect(notificationCapability("linux")).toEqual({ available: false, platform: "linux", reason: "macOS notifications unavailable on this platform" });
  });
});
