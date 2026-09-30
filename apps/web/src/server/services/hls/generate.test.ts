import { describe, expect, it } from "vitest";
import {
  type AdaptiveFormat,
  audioXtagsOf,
  buildMasterPlaylist,
  buildSubtitlePlaylist,
  pickAudioTracks,
} from "@/server/services/hls/generate";

const avc720: AdaptiveFormat = {
  itag: 136,
  type: 'video/mp4; codecs="avc1.4d401f"',
  url: "https://inv.example/videoplayback?itag=136&dur=562.433",
  init: "0-740",
  index: "741-2091",
  bitrate: 1_500_000,
  size: "1280x720",
};

const aacPlain: AdaptiveFormat = {
  itag: 140,
  type: 'audio/mp4; codecs="mp4a.40.2"',
  url: "https://inv.example/videoplayback?itag=140&dur=562.433",
  init: "0-722",
  index: "723-1438",
  bitrate: 130_000,
};

const xt = (v: string) => encodeURIComponent(v);
const dubEn: AdaptiveFormat = {
  ...aacPlain,
  bitrate: 130_895,
  url: `https://inv.example/videoplayback?itag=140&dur=562.433&xtags=${xt("acont=dubbed-auto:lang=en-US")}`,
};
const originalNlDrc: AdaptiveFormat = {
  ...aacPlain,
  bitrate: 130_946,
  url: `https://inv.example/videoplayback?itag=140&dur=562.433&xtags=${xt("acont=original:drc=1:lang=nl-NL")}`,
};
const originalNl: AdaptiveFormat = {
  ...aacPlain,
  bitrate: 130_950,
  url: `https://inv.example/videoplayback?itag=140&dur=562.433&xtags=${xt("acont=original:lang=nl-NL")}`,
};

describe("audioXtagsOf", () => {
  it("parses lang, acont and drc from the xtags parameter", () => {
    expect(audioXtagsOf(originalNlDrc.url)).toEqual({
      raw: "acont=original:drc=1:lang=nl-NL",
      lang: "nl-NL",
      acont: "original",
      drc: true,
    });
  });

  it("returns nulls when there is no xtags", () => {
    expect(audioXtagsOf(aacPlain.url)).toEqual({
      raw: null,
      lang: null,
      acont: null,
      drc: false,
    });
  });
});

describe("pickAudioTracks", () => {
  it("collapses a single-language video to one default track", () => {
    const tracks = pickAudioTracks([aacPlain, { ...aacPlain, bitrate: 1 }]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.isDefault).toBe(true);
    expect(tracks[0]?.isOriginal).toBe(true);
    expect(tracks[0]?.lang).toBeNull();
  });

  it("orders the original before dubs even when upstream lists dubs first", () => {
    const tracks = pickAudioTracks([dubEn, originalNlDrc, originalNl]);
    expect(tracks.map((t) => t.lang)).toEqual(["nl-NL", "en-US"]);
    expect(tracks[0]?.isDefault).toBe(true);
    // The non-drc row wins within the original group.
    expect(tracks[0]?.xtags).toBe("acont=original:lang=nl-NL");
  });
});

describe("buildMasterPlaylist", () => {
  it("keeps the legacy single-audio rendition shape", () => {
    const m3u8 = buildMasterPlaylist([avc720], pickAudioTracks([aacPlain]));
    expect(m3u8).toContain(
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="media.m3u8?itag=140"',
    );
  });

  it("lists one rendition per language with the original as DEFAULT", () => {
    const m3u8 = buildMasterPlaylist(
      [avc720],
      pickAudioTracks([dubEn, originalNlDrc, originalNl]),
    );
    expect(m3u8).toContain(
      `NAME="Dutch (Original)",LANGUAGE="nl-NL",DEFAULT=YES,AUTOSELECT=YES,URI="media.m3u8?itag=140&xtags=${xt("acont=original:lang=nl-NL")}"`,
    );
    expect(m3u8).toContain(
      `NAME="English",LANGUAGE="en-US",DEFAULT=NO,AUTOSELECT=NO,URI="media.m3u8?itag=140&xtags=${xt("acont=dubbed-auto:lang=en-US")}"`,
    );
    // Variant rows still reference the shared audio group.
    expect(m3u8).toContain('AUDIO="aud"');
  });
});

describe("subtitles in the master playlist", () => {
  it("adds one SUBTITLES rendition per caption and links the variants to it", () => {
    const m3u8 = buildMasterPlaylist([avc720], pickAudioTracks([aacPlain]), [
      { label: "Dutch (auto-generated)", language_code: "nl" },
      { label: "Commentary" },
    ]);
    expect(m3u8).toContain(
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Dutch (auto-generated)",LANGUAGE="nl",DEFAULT=NO,AUTOSELECT=YES,URI="subtitles.m3u8?lang=nl"',
    );
    expect(m3u8).toContain(
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Commentary",DEFAULT=NO,AUTOSELECT=YES,URI="subtitles.m3u8?label=Commentary"',
    );
    expect(m3u8).toContain('AUDIO="aud",SUBTITLES="subs"');
  });

  it("leaves the variants alone when there are no captions", () => {
    const m3u8 = buildMasterPlaylist([avc720], pickAudioTracks([aacPlain]), [
      {},
    ]);
    expect(m3u8).not.toContain("SUBTITLES");
  });

  it("keeps quotes out of the rendition name", () => {
    const m3u8 = buildMasterPlaylist([avc720], pickAudioTracks([aacPlain]), [
      { label: 'The "director" cut', languageCode: "en" },
    ]);
    expect(m3u8).toContain('NAME="The director cut"');
  });
});

describe("buildSubtitlePlaylist", () => {
  it("serves the whole caption file as one segment spanning the video", () => {
    expect(buildSubtitlePlaylist("abc_DEF-123", "lang=nl", 562.433)).toBe(
      [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:563",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXTINF:562.433,",
        "/captions/abc_DEF-123?lang=nl",
        "#EXT-X-ENDLIST",
        "",
      ].join("\n"),
    );
  });
});
