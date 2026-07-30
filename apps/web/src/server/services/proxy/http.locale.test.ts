import { describe, expect, it, vi } from "vitest";

const upstreamGetText = vi.fn();
vi.mock("@/server/services/upstream-get", () => ({ upstreamGetText }));
vi.mock("@/server/services/upstream-health", () => ({
  recordUpstreamFailure: vi.fn(),
  recordUpstreamSuccess: vi.fn(),
}));

const { fetchJson } = await import("@/server/services/proxy/http");

function calledUrl(): string {
  return upstreamGetText.mock.calls.at(-1)?.[0] as string;
}

describe("Invidious request locale", () => {
  it("asks for en-US so publishedText is not returned in another language", async () => {
    // Without hl, this deployment answered in Arabic ("1 السنة منذ"), and
    // publishedText is shown to the user.
    upstreamGetText.mockResolvedValue({ status: 200, ok: true, text: "[]" });
    await fetchJson("https://inv.test/api/v1/trending?region=US");
    expect(calledUrl()).toContain("hl=en-US");
  });

  it("does not override an hl the caller set", async () => {
    upstreamGetText.mockResolvedValue({ status: 200, ok: true, text: "[]" });
    await fetchJson("https://inv.test/api/v1/search?q=x&hl=fr");
    expect(calledUrl()).toContain("hl=fr");
    expect(calledUrl()).not.toContain("en-US");
  });

  it("leaves non-API URLs alone", async () => {
    upstreamGetText.mockResolvedValue({ status: 200, ok: true, text: "{}" });
    await fetchJson("https://inv.test/companion/whatever");
    expect(calledUrl()).not.toContain("hl=");
  });
});
