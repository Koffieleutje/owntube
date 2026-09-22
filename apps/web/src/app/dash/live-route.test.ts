import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The VOD half of the route pulls in the DB and upstream services; the live
// half needs none of it.
vi.mock("@/server/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/server/services/proxy", () => ({ fetchVideoDetail: vi.fn() }));
vi.mock("@/server/trpc/caller", () => ({ createCaller: vi.fn() }));
vi.mock("@/server/services/dash/generate", () => ({
  DASH_VIDEO_FAMILIES: ["vp9", "av01", "avc"],
  generateMpd: vi.fn(),
}));

const { GET } = await import("./[...parts]/route");

const COMPANION = "http://companion.internal";
const VIDEO = "Ao58WyRJdg8";

/** The companion's `/sabr` live manifest: YouTube's, BaseURLs rewritten. */
const companionMpd =
  '<MPD type="dynamic" minimumUpdatePeriod="PT5.000S"><Period start="PT500.000S">' +
  '<SegmentList presentationTimeOffset="500000" startNumber="100" timescale="1000">' +
  '<SegmentTimeline><S d="5000"/><S d="5000"/></SegmentTimeline></SegmentList>' +
  '<AdaptationSet mimeType="video/mp4"><Representation id="299">' +
  "<BaseURL>live/chk/3/</BaseURL><SegmentList>" +
  '<SegmentURL media="sq/100/lmt/1"/><SegmentURL media="sq/101/lmt/1"/>' +
  "</SegmentList></Representation></AdaptationSet></Period></MPD>";

function box(type: string, payload: number): Uint8Array {
  const b = new Uint8Array(8 + payload);
  new DataView(b.buffer).setUint32(0, b.length);
  b.set(new TextEncoder().encode(type), 4);
  return b;
}
const init = new Uint8Array([...box("ftyp", 4), ...box("moov", 16)]);
const segment = new Uint8Array([
  ...init,
  ...box("moof", 8),
  ...box("mdat", 64),
]);

function get(path: string): Promise<Response> {
  const parts = path.split("/").filter(Boolean).slice(1);
  return GET(new Request(`http://owntube.test${path}`), {
    params: Promise.resolve({ parts }),
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
/** Companion paths fetched, without host or `check`. */
const requested = () =>
  fetchMock.mock.calls.map(([u]) =>
    String(u)
      .replace(COMPANION, "")
      .replace(/\?check=.*/, ""),
  );

beforeEach(() => {
  vi.stubEnv("INVIDIOUS_COMPANION_INTERNAL_URL", COMPANION);
  vi.stubEnv("INVIDIOUS_COMPANION_SECRET_KEY", "");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("/dash/<id>/live.mpd", () => {
  it("serves the companion's manifest as a template on our segment proxy", async () => {
    fetchMock.mockResolvedValue(new Response(companionMpd));
    const r = await get(`/dash/${VIDEO}/live.mpd`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/dash+xml");
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = await r.text();
    expect(body).toContain(`<BaseURL>/dash/${VIDEO}/live/3/</BaseURL>`);
    expect(body).toContain('media="sq/$Number$/lmt/1" initialization="init"');
    expect(requested()).toEqual([`/companion/sabr/${VIDEO}/manifest.mpd`]);
  });

  it("502s on the companion's empty non-live manifest", async () => {
    fetchMock.mockResolvedValue(
      new Response('<MPD type="static"><Period/></MPD>'),
    );
    expect((await get("/dash/Bo58WyRJdg8/live.mpd")).status).toBe(502);
  });
});

describe("/dash/<id>/live/<rep>/...", () => {
  it("streams a segment from the companion's live route", async () => {
    fetchMock.mockResolvedValue(
      new Response(segment, { headers: { "content-type": "video/mp4" } }),
    );
    const r = await get(`/dash/${VIDEO}/live/3/sq/101/lmt/1`);
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(segment);
    expect(r.headers.get("content-length")).toBe(String(segment.byteLength));
    expect(requested()).toEqual([
      `/companion/sabr/${VIDEO}/live/-/3/sq/101/lmt/1`,
    ]);
  });

  it("re-fetches the manifest and retries once when the companion lost it", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response("Live manifest not held", { status: 404 }),
      )
      .mockResolvedValueOnce(new Response(companionMpd))
      .mockResolvedValueOnce(new Response(segment));
    const r = await get("/dash/Co58WyRJdg8/live/3/sq/101/lmt/1");
    expect(r.status).toBe(200);
    expect(requested()).toEqual([
      "/companion/sabr/Co58WyRJdg8/live/-/3/sq/101/lmt/1",
      "/companion/sabr/Co58WyRJdg8/manifest.mpd",
      "/companion/sabr/Co58WyRJdg8/live/-/3/sq/101/lmt/1",
    ]);
  });

  it("serves init as the ftyp+moov of the newest segment", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(companionMpd))
      .mockResolvedValueOnce(new Response(segment));
    const r = await get("/dash/Do58WyRJdg8/live/3/init");
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(init);
    expect(requested()).toEqual([
      "/companion/sabr/Do58WyRJdg8/manifest.mpd",
      "/companion/sabr/Do58WyRJdg8/live/-/3/sq/101/lmt/1",
    ]);
  });

  it("rejects paths outside the segment shape", async () => {
    for (const path of [
      `/dash/${VIDEO}/live/x/sq/1/lmt/1`,
      `/dash/${VIDEO}/live/3/sq/../../etc`,
      `/dash/${VIDEO}/live/3/`,
    ]) {
      expect((await get(path)).status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
