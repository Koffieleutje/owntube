import { afterEach, describe, expect, it } from "vitest";
import { getInstanceSourceInfo } from "@/server/services/proxy";

describe("getInstanceSourceInfo", () => {
  const env = process.env;

  afterEach(() => {
    process.env = env;
  });

  it("reports the env Invidious URL", () => {
    process.env = { ...env, INVIDIOUS_BASE_URL: "https://inv.example" };
    const info = getInstanceSourceInfo();
    expect(info.invidious.envUrl).toBe("https://inv.example");
    expect(info.invidious.effectiveUrl).toBe("https://inv.example");
    expect(info.invidious.urls).toEqual(["https://inv.example"]);
    expect(info.invidious.envDisabled).toBe(false);
  });

  it("reports a disabled env value instead of treating it as a URL", () => {
    process.env = { ...env, INVIDIOUS_BASE_URL: "disabled" };
    const info = getInstanceSourceInfo();
    expect(info.invidious.envDisabled).toBe(true);
    expect(info.invidious.envUrl).toBeNull();
    expect(info.invidious.effectiveUrl).toBeNull();
    expect(info.invidious.urls).toEqual([]);
  });

  it("reports nothing configured when the env var is unset", () => {
    const { INVIDIOUS_BASE_URL: _drop, ...rest } = env;
    process.env = rest;
    const info = getInstanceSourceInfo();
    expect(info.invidious.envRaw).toBeNull();
    expect(info.invidious.effectiveUrl).toBeNull();
    expect(info.invidious.urls).toEqual([]);
  });

  it("accepts several instances to fail over between, dropping duplicates", () => {
    process.env = {
      ...env,
      // Whitespace- or comma-separated, and normalised (trailing slash, dupes).
      INVIDIOUS_BASE_URL:
        "https://one.example/, https://one.example https://two.example",
    };
    const info = getInstanceSourceInfo();
    expect(info.invidious.urls).toEqual([
      "https://one.example",
      "https://two.example",
    ]);
    expect(info.invidious.effectiveUrl).toBe("https://one.example");
    // One health row per configured instance, for the Settings display.
    expect(info.invidious.health).toHaveLength(2);
  });
});
