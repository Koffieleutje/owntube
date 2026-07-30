import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMpd,
  pickDashVideoFormats,
} from "@/server/services/dash/generate";
import {
  type AdaptiveFormat,
  pickAudioTracks,
} from "@/server/services/hls/generate";

const vp9_2160: AdaptiveFormat = {
  itag: 313,
  type: 'video/webm; codecs="vp9"',
  url: "https://inv.example/videoplayback?itag=313&dur=562.433&x=1",
  init: "0-219",
  index: "220-2999",
  bitrate: 12_000_000,
  size: "3840x2160",
  fps: 30,
};

const vp9_1080: AdaptiveFormat = {
  itag: 248,
  type: 'video/webm; codecs="vp9"',
  url: "https://inv.example/videoplayback?itag=248&dur=562.433",
  init: "0-219",
  index: "220-1999",
  bitrate: 2_500_000,
  size: "1920x1080",
  fps: 30,
};

const avc_1080: AdaptiveFormat = {
  itag: 137,
  type: 'video/mp4; codecs="avc1.640028"',
  url: "https://inv.example/videoplayback?itag=137&dur=562.433",
  init: "0-740",
  index: "741-2091",
  bitrate: 4_600_000,
  size: "1920x1080",
  fps: 30,
};

const aac: AdaptiveFormat = {
  itag: 140,
  type: 'audio/mp4; codecs="mp4a.40.2"',
  url: "https://inv.example/videoplayback?itag=140&dur=562.433",
  init: "0-722",
  index: "723-1438",
  bitrate: 130_000,
};

const aacTrack = pickAudioTracks([aac]);

describe("pickDashVideoFormats", () => {
  it("keeps only the requested family, best bitrate first, deduped", () => {
    const picked = pickDashVideoFormats(
      [avc_1080, vp9_1080, vp9_2160, vp9_1080, aac],
      "vp9",
    );
    expect(picked.map((f) => f.itag)).toEqual([313, 248]);
  });

  it("returns empty when the family is not offered", () => {
    expect(pickDashVideoFormats([avc_1080, aac], "av01")).toEqual([]);
  });
});

describe("companion-direct segments", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rewrites googlevideo URLs to the companion proxy, never direct", () => {
    vi.stubEnv("INVIDIOUS_PUBLIC_BASE_URL", "https://inv.example");
    vi.stubEnv("INVIDIOUS_DIRECT_DASH_SEGMENTS", "true");
    const gv = {
      ...vp9_2160,
      url: "https://rr2---sn-abc.googlevideo.com/videoplayback?itag=313&dur=562.433",
    };
    const mpd = buildMpd([gv], aacTrack, 562);
    expect(mpd).toContain(
      "https://inv.example/companion/videoplayback?itag=313",
    );
    expect(mpd).toContain("host=rr2---sn-abc.googlevideo.com");
    expect(mpd).not.toContain("<BaseURL>https://rr2---sn-abc.googlevideo.com");
  });

  it("moves instance-minted local URLs onto the companion path", () => {
    vi.stubEnv("INVIDIOUS_DIRECT_DASH_SEGMENTS", "true");
    const local = {
      ...vp9_2160,
      url: "https://inv.example/videoplayback?itag=313&host=rr2---sn-abc.googlevideo.com",
    };
    const mpd = buildMpd([local], aacTrack, 562);
    expect(mpd).toContain(
      "<BaseURL>https://inv.example/companion/videoplayback?itag=313",
    );
  });

  it("split mode (default): heavy rungs same-origin, seek-critical direct", () => {
    vi.stubEnv("INVIDIOUS_DIRECT_DASH_SEGMENTS", "split");
    const withHost = (f: AdaptiveFormat) => ({
      ...f,
      url: `${f.url}&host=rr2---sn-abc.googlevideo.com`,
    });
    const mpd = buildMpd(
      [withHost(vp9_2160), withHost(vp9_1080)],
      pickAudioTracks([withHost(aac)]),
      562,
    );
    // 12Mbps 2160p: aborted multi-MB fetches must drain bounded → proxy.
    expect(mpd).toContain("<BaseURL>/stream/videoplayback?itag=313");
    // 2.5Mbps seek rung and audio: latency-critical on seeks → direct.
    expect(mpd).toContain(
      "<BaseURL>https://inv.example/companion/videoplayback?itag=248",
    );
    expect(mpd).toContain(
      "<BaseURL>https://inv.example/companion/videoplayback?itag=140",
    );
  });

  it("false: everything through the same-origin proxy", () => {
    vi.stubEnv("INVIDIOUS_DIRECT_DASH_SEGMENTS", "false");
    const mpd = buildMpd([vp9_2160, vp9_1080], aacTrack, 562);
    expect(mpd).not.toContain("companion/videoplayback");
    expect(mpd).toContain("<BaseURL>/stream/videoplayback?itag=313");
    expect(mpd).toContain("<BaseURL>/stream/videoplayback?itag=140");
  });
});

describe("buildMpd", () => {
  it("emits a static VOD MPD with SegmentBase byte ranges", () => {
    const mpd = buildMpd([vp9_2160, vp9_1080], aacTrack, 562.433);
    expect(mpd).toContain('type="static"');
    expect(mpd).toContain('mediaPresentationDuration="PT562.433S"');
    expect(mpd).toContain('mimeType="video/webm"');
    expect(mpd).toContain('mimeType="audio/mp4"');
    expect(mpd).toContain('codecs="vp9"');
    expect(mpd).toContain('width="3840" height="2160"');
    expect(mpd).toContain('<SegmentBase indexRange="220-2999">');
    expect(mpd).toContain('<Initialization range="0-219"/>');
    expect(mpd).toContain('codecs="mp4a.40.2"');
  });

  it("XML-escapes ampersands in stream URLs", () => {
    const mpd = buildMpd([vp9_2160], aacTrack, 562);
    expect(mpd).toContain("itag=313&amp;dur=562.433&amp;x=1");
    expect(mpd).not.toMatch(/<BaseURL>[^<]*&(?!amp;)/);
  });

  it("advertises caption tracks as text AdaptationSets", () => {
    const mpd = buildMpd([vp9_1080], aacTrack, 562, "dQw4w9WgXcQ", [
      { label: "English", languageCode: "en" },
      { label: "Nederlands", languageCode: "nl" },
    ]);
    expect(mpd).toContain('contentType="text" mimeType="text/vtt" lang="en"');
    expect(mpd).toContain('contentType="text" mimeType="text/vtt" lang="nl"');
    expect(mpd).toContain("<BaseURL>/captions/dQw4w9WgXcQ?lang=en</BaseURL>");
    expect(mpd).toContain('value="subtitle"');
  });

  it("falls back to the label when a track has no language code", () => {
    const mpd = buildMpd([vp9_1080], aacTrack, 562, "dQw4w9WgXcQ", [
      { label: "Auto-generated" },
    ]);
    expect(mpd).toContain(
      "<BaseURL>/captions/dQw4w9WgXcQ?label=Auto-generated</BaseURL>",
    );
  });

  it("reads Invidious's snake_case language_code", () => {
    const mpd = buildMpd([vp9_1080], aacTrack, 562, "dQw4w9WgXcQ", [
      { label: "English", language_code: "en" },
    ]);
    expect(mpd).toContain('lang="en"');
    expect(mpd).toContain("<BaseURL>/captions/dQw4w9WgXcQ?lang=en</BaseURL>");
  });

  it("always emits lang, since a track without one is dropped by the client", () => {
    const mpd = buildMpd([vp9_1080], aacTrack, 562, "dQw4w9WgXcQ", [
      { label: "English (auto-generated)" },
    ]);
    expect(mpd).toContain('lang="und"');
  });

  it("omits caption sets entirely when there are none", () => {
    const mpd = buildMpd([vp9_1080], aacTrack, 562, "dQw4w9WgXcQ", []);
    expect(mpd).not.toContain("text/vtt");
  });

  it("keeps the single-audio shape free of multi-track attributes", () => {
    const mpd = buildMpd([vp9_1080], aacTrack, 562);
    expect(mpd).not.toContain("<Label>");
    expect(mpd).not.toContain('value="main"');
    expect(mpd).not.toContain("selectionPriority");
  });
});

describe("multi-language audio", () => {
  // Mirrors a real auto-dubbed video: the en-US dub rows come FIRST and every
  // language shares itag 140; only the URL's xtags tells them apart.
  const xt = (v: string) => encodeURIComponent(v);
  const dubEn: AdaptiveFormat = {
    ...aac,
    bitrate: 130_895,
    url: `https://inv.example/videoplayback?itag=140&dur=562.433&xtags=${xt("acont=dubbed-auto:lang=en-US")}`,
  };
  const originalNlDrc: AdaptiveFormat = {
    ...aac,
    bitrate: 130_946,
    url: `https://inv.example/videoplayback?itag=140&dur=562.433&xtags=${xt("acont=original:drc=1:lang=nl-NL")}`,
  };
  const originalNl: AdaptiveFormat = {
    ...aac,
    bitrate: 130_950,
    url: `https://inv.example/videoplayback?itag=140&dur=562.433&xtags=${xt("acont=original:lang=nl-NL")}`,
  };

  it("puts the original first and default, dropping drc duplicates", () => {
    const tracks = pickAudioTracks([dubEn, originalNlDrc, originalNl]);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]?.lang).toBe("nl-NL");
    expect(tracks[0]?.isOriginal).toBe(true);
    expect(tracks[0]?.isDefault).toBe(true);
    expect(tracks[0]?.xtags).toBe("acont=original:lang=nl-NL");
    expect(tracks[1]?.lang).toBe("en-US");
    expect(tracks[1]?.isOriginal).toBe(false);
  });

  it("emits one AdaptationSet per language, original as Role=main", () => {
    const tracks = pickAudioTracks([dubEn, originalNlDrc, originalNl]);
    const mpd = buildMpd([vp9_1080], tracks, 562, "dQw4w9WgXcQ", [
      { label: "English", languageCode: "en" },
    ]);
    const nl = mpd.indexOf('lang="nl-NL"');
    const en = mpd.indexOf('lang="en-US"');
    expect(nl).toBeGreaterThan(-1);
    expect(en).toBeGreaterThan(nl);
    expect(mpd).toContain('selectionPriority="2"');
    expect(mpd).toContain('value="main"');
    expect(mpd).toContain('value="dub"');
    expect(mpd).toContain("<Label>Dutch (Original)</Label>");
    expect(mpd).toContain("<Label>English</Label>");
    // Same itag on every language: representation ids must still be unique.
    expect(mpd).toContain('<Representation id="a0-140"');
    expect(mpd).toContain('<Representation id="a1-140"');
    // Caption set ids start after the audio sets (video=0, audio=1..2).
    expect(mpd).toContain('<AdaptationSet id="3" contentType="text"');
  });
});
