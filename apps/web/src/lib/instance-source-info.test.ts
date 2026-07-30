import { afterEach, describe, expect, it } from "vitest";
import { getInstanceSourceInfo } from "@/server/services/proxy";

describe("getInstanceSourceInfo", () => {
  const env = process.env;

  afterEach(() => {
    process.env = env;
  });

  it("reports the env Invidious URL when there is no profile override", () => {
    process.env = { ...env, INVIDIOUS_BASE_URL: "https://inv.example" };
    const info = getInstanceSourceInfo({});
    expect(info.invidious.envUrl).toBe("https://inv.example");
    expect(info.invidious.effectiveUrl).toBe("https://inv.example");
    expect(info.invidious.urls).toEqual(["https://inv.example"]);
    expect(info.invidious.profileOverride).toBeNull();
  });

  it("reports a disabled env value instead of treating it as a URL", () => {
    process.env = { ...env, INVIDIOUS_BASE_URL: "disabled" };
    const info = getInstanceSourceInfo({});
    expect(info.invidious.envDisabled).toBe(true);
    expect(info.invidious.envUrl).toBeNull();
    expect(info.invidious.effectiveUrl).toBeNull();
    expect(info.invidious.urls).toEqual([]);
  });

  it("prefers profile override over env", () => {
    process.env = { ...env, INVIDIOUS_BASE_URL: "https://inv.env" };
    const info = getInstanceSourceInfo({
      invidiousBaseUrl: "https://inv.profile",
    });
    expect(info.invidious.envUrl).toBe("https://inv.env");
    expect(info.invidious.profileOverride).toBe("https://inv.profile");
    expect(info.invidious.effectiveUrl).toBe("https://inv.profile");
    expect(info.invidious.urls).toEqual(["https://inv.profile"]);
  });

  it("reports multiple profile overrides and orders the preferred URL first", () => {
    process.env = { ...env, INVIDIOUS_BASE_URL: "https://inv.env" };
    const info = getInstanceSourceInfo({
      invidiousBaseUrls: ["https://one.profile", "https://two.profile"],
      preferredInvidiousBaseUrl: "https://two.profile",
    });
    expect(info.invidious.profileOverride).toBe(
      "https://one.profile, https://two.profile",
    );
    expect(info.invidious.urls).toEqual([
      "https://two.profile",
      "https://one.profile",
    ]);
    expect(info.invidious.preferredUrl).toBe("https://two.profile");
  });
});
