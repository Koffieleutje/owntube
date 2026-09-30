import { describe, expect, it } from "vitest";
import { mapInvidiousVideo } from "@/server/services/proxy/mappers/invidious";

function audioFormat(opts: {
  lang: string;
  acont?: string;
  displayName: string;
  audioIsDefault: boolean;
}) {
  const xtags = opts.acont
    ? `&xtags=${encodeURIComponent(`acont=${opts.acont}:lang=${opts.lang}`)}`
    : "";
  return {
    url: `https://inv.test/videoplayback?itag=140${xtags}`,
    type: 'audio/mp4; codecs="mp4a.40.2"',
    itag: "140",
    bitrate: "130000",
    init: "0-722",
    index: "723-1000",
    audioTrack: {
      id: `${opts.lang}.4`,
      displayName: opts.displayName,
      audioIsDefault: opts.audioIsDefault,
    },
  };
}

function originalByLanguage(adaptiveFormats: unknown[]) {
  const detail = mapInvidiousVideo({
    videoId: "Aop6XBgCOIE",
    title: "Tip van een stemcoach",
    adaptiveFormats,
  });
  return Object.fromEntries(
    (detail?.audioSources ?? []).map((a) => [a.language, a.audioIsOriginal]),
  );
}

describe("mapInvidiousVideo audioIsOriginal", () => {
  // Real shape for Aop6XBgCOIE: YouTube flags the en-US auto-dub as default
  // because Invidious requests as en-US; the Dutch track is the original.
  it("trusts xtags acont over audioIsDefault", () => {
    expect(
      originalByLanguage([
        audioFormat({
          lang: "en-US",
          acont: "dubbed-auto",
          displayName: "English (US)",
          audioIsDefault: true,
        }),
        audioFormat({
          lang: "nl-NL",
          acont: "original",
          displayName: "Dutch (NL) original",
          audioIsDefault: false,
        }),
      ]),
    ).toEqual({ "en-US": false, "nl-NL": true });
  });

  it("falls back to the display name without xtags", () => {
    expect(
      originalByLanguage([
        audioFormat({
          lang: "en-US",
          displayName: "English (US)",
          audioIsDefault: true,
        }),
        audioFormat({
          lang: "nl-NL",
          displayName: "Dutch (NL) original",
          audioIsDefault: false,
        }),
      ]),
    ).toEqual({ "en-US": false, "nl-NL": true });
  });
});
