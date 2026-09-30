import { describe, expect, it } from "vitest";
import { searchCacheKey } from "@/server/services/proxy/cache";
import { buildInvidiousSearchUrl } from "@/server/services/proxy/search";

describe("search upload-date filter", () => {
  it("passes the date window through to Invidious only when set", () => {
    const plain = new URL(
      buildInvidiousSearchUrl("http://inv:3000", { q: "obsidian" }),
    );
    expect(plain.searchParams.has("date")).toBe(false);
    const filtered = new URL(
      buildInvidiousSearchUrl("http://inv:3000", {
        q: "obsidian",
        date: "year",
      }),
    );
    expect(filtered.searchParams.get("date")).toBe("year");
    expect(filtered.searchParams.get("q")).toBe("obsidian");
  });

  it("keys the cache by date window without disturbing unfiltered keys", () => {
    const unfiltered = searchCacheKey({ q: "obsidian", limit: 8 });
    const year = searchCacheKey({ q: "obsidian", limit: 8, date: "year" });
    const month = searchCacheKey({ q: "obsidian", limit: 8, date: "month" });
    expect(year).not.toBe(unfiltered);
    expect(month).not.toBe(year);
    // `date: undefined` must hash exactly like a request that never set it.
    expect(searchCacheKey({ q: "obsidian", limit: 8, date: undefined })).toBe(
      unfiltered,
    );
  });
});
