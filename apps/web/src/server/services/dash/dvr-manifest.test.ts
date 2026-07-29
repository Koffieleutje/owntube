import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invalidateDvrManifest,
  resolveDvrSegmentUrl,
  rewriteDvrManifestSegmentUrls,
} from "@/server/services/dash/dvr-manifest";

const VIDEO_ID = "7S6aQm1ZxkQ";

/** Shaped like invidious-companion's real DVR output: absolute, entity-escaped
 *  `media` with a `$Number$` tail, a SegmentTimeline child, and no
 *  `initialization` (YouTube's live segments are self-initializing). */
function companionMpd(): string {
  return [
    '<MPD type="static" mediaPresentationDuration="PT7145S"><Period>',
    '<AdaptationSet id="0" mimeType="audio/mp4" contentType="audio">',
    '<Representation id="140" bandwidth="144000" codecs="mp4a.40.2">',
    '<SegmentTemplate startNumber="0" timescale="1000" media="https://inv.example/companion/videoplayback?expire=1785381923&amp;itag=140&amp;pot=ABC&amp;sq=$Number$">',
    '<SegmentTimeline><S d="5000" r="1429"/></SegmentTimeline>',
    "</SegmentTemplate></Representation></AdaptationSet>",
    '<AdaptationSet id="1" mimeType="video/mp4" contentType="video">',
    '<Representation id="137" width="1920" height="1080" codecs="avc1.640028">',
    '<SegmentTemplate startNumber="0" timescale="1000" media="https://inv.example/companion/videoplayback?expire=1785381923&amp;itag=137&amp;pot=ABC&amp;sq=$Number$"/>',
    "</Representation></AdaptationSet></Period></MPD>",
  ].join("");
}

describe("rewriteDvrManifestSegmentUrls", () => {
  const out = rewriteDvrManifestSegmentUrls(companionMpd(), VIDEO_ID);

  it("repoints every media template at a stable /dvr path keyed by representation", () => {
    expect(out).toContain(`media="/dvr/${VIDEO_ID}/140/$Number$"`);
    expect(out).toContain(`media="/dvr/${VIDEO_ID}/137/$Number$"`);
  });

  it("adds an explicit initialization at segment 0", () => {
    expect(out).toContain(`initialization="/dvr/${VIDEO_ID}/140/0"`);
    expect(out).toContain(`initialization="/dvr/${VIDEO_ID}/137/0"`);
  });

  it("leaks no expiring upstream URL, token or host to the client", () => {
    expect(out).not.toContain("expire=");
    expect(out).not.toContain("pot=");
    expect(out).not.toContain("inv.example");
    expect(out).not.toContain("videoplayback");
  });

  it("keeps the timeline and the static duration intact", () => {
    expect(out).toContain('<S d="5000" r="1429"/>');
    expect(out).toContain('type="static"');
    expect(out).toContain('mediaPresentationDuration="PT7145S"');
  });

  it("preserves a self-closing SegmentTemplate as self-closing", () => {
    // The 137 template is self-closing; it must not swallow the Representation.
    expect(out).toContain(`initialization="/dvr/${VIDEO_ID}/137/0"/>`);
    expect(out).toContain("</Representation></AdaptationSet></Period></MPD>");
    // Same number of open and close tags as we started with.
    const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
    expect(count(out, /<Representation\b/g)).toBe(2);
    expect(count(out, /<\/Representation>/g)).toBe(2);
    expect(count(out, /<SegmentTemplate\b/g)).toBe(2);
  });

  it("is idempotent — a second pass changes nothing", () => {
    expect(rewriteDvrManifestSegmentUrls(out, VIDEO_ID)).toBe(out);
  });

  it("leaves a Representation with no SegmentTemplate alone", () => {
    const byteRange =
      '<MPD><Period><AdaptationSet><Representation id="140">' +
      '<SegmentList><Initialization sourceURL="https://inv.example/x"/></SegmentList>' +
      "</Representation></AdaptationSet></Period></MPD>";
    expect(rewriteDvrManifestSegmentUrls(byteRange, VIDEO_ID)).toBe(byteRange);
  });

  it("skips a representation whose id is not a plausible itag", () => {
    const weird =
      '<MPD><Period><AdaptationSet><Representation id="../../etc/passwd">' +
      '<SegmentTemplate media="https://inv.example/v?sq=$Number$"/>' +
      "</Representation></AdaptationSet></Period></MPD>";
    const res = rewriteDvrManifestSegmentUrls(weird, VIDEO_ID);
    expect(res).toBe(weird);
    expect(res).not.toContain("/dvr/");
  });

  it("replaces an initialization the companion did supply", () => {
    const withInit =
      '<MPD><Period><AdaptationSet><Representation id="140">' +
      '<SegmentTemplate media="https://inv.example/v?sq=$Number$" initialization="https://inv.example/v?sq=init"/>' +
      "</Representation></AdaptationSet></Period></MPD>";
    const res = rewriteDvrManifestSegmentUrls(withInit, VIDEO_ID);
    expect(res).toContain(`initialization="/dvr/${VIDEO_ID}/140/0"`);
    expect(res).not.toContain("sq=init");
    expect((res.match(/initialization=/g) ?? []).length).toBe(1);
  });
});

describe("resolveDvrSegmentUrl", () => {
  afterEach(() => {
    invalidateDvrManifest(VIDEO_ID);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubCompanion(
    responses: (() => { ok: boolean; body: string })[],
  ): () => number {
    vi.stubEnv("INVIDIOUS_PUBLIC_BASE_URL", "https://inv.example");
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      const next = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      const { ok, body } = next();
      return { ok, text: async () => body, body: null } as unknown as Response;
    });
    return () => calls;
  }

  const good = () => ({ ok: true, body: companionMpd() });
  const broken = () => ({
    ok: false,
    body: "dash generation failed: no usable adaptive video + AAC audio streams",
  });

  it("substitutes the segment number and decodes XML entities", async () => {
    stubCompanion([good]);
    const res = await resolveDvrSegmentUrl(VIDEO_ID, "140", "42");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // &amp; decoded back to a usable query string, $Number$ -> 42.
    expect(res.url).toContain("&itag=140&");
    expect(res.url).not.toContain("&amp;");
    expect(res.url).toMatch(/sq=42$/);
  });

  it("reports an unknown representation as no-representation (a real 404)", async () => {
    stubCompanion([good]);
    const res = await resolveDvrSegmentUrl(VIDEO_ID, "999", "1");
    expect(res).toEqual({ ok: false, reason: "no-representation" });
  });

  it("rejects a representation id that isn't itag-shaped without fetching", async () => {
    const calls = stubCompanion([good]);
    const res = await resolveDvrSegmentUrl(VIDEO_ID, "../../etc/passwd", "1");
    expect(res).toEqual({ ok: false, reason: "no-representation" });
    expect(calls()).toBe(0);
  });

  it("reports a failing companion as no-manifest, not a 404", async () => {
    stubCompanion([broken]);
    const res = await resolveDvrSegmentUrl(VIDEO_ID, "140", "1");
    expect(res).toEqual({ ok: false, reason: "no-manifest" });
  });

  it("retries a flapping companion instead of failing the segment", async () => {
    // Fails twice, then succeeds — within MANIFEST_ATTEMPTS.
    const calls = stubCompanion([broken, broken, good]);
    const res = await resolveDvrSegmentUrl(VIDEO_ID, "140", "1");
    expect(res.ok).toBe(true);
    expect(calls()).toBe(3);
  });

  it("serves the previous manifest when a later refresh fails", async () => {
    const calls = stubCompanion([good]);
    expect((await resolveDvrSegmentUrl(VIDEO_ID, "140", "1")).ok).toBe(true);
    const afterFirst = calls();

    // Force a refresh path that fails; the cached copy must still answer, since
    // its URLs stay valid for hours.
    vi.unstubAllGlobals();
    stubCompanion([broken]);
    const res = await resolveDvrSegmentUrl(VIDEO_ID, "140", "2");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.url).toMatch(/sq=2$/);
    expect(afterFirst).toBeGreaterThan(0);
  });

  it("does not fall back to a stale manifest when forced after a 403", async () => {
    stubCompanion([good]);
    expect((await resolveDvrSegmentUrl(VIDEO_ID, "140", "1")).ok).toBe(true);
    vi.unstubAllGlobals();
    stubCompanion([broken]);
    // force=true means those URLs already 403'd — replaying them is pointless.
    const res = await resolveDvrSegmentUrl(VIDEO_ID, "140", "1", true);
    expect(res).toEqual({ ok: false, reason: "no-manifest" });
  });
});
