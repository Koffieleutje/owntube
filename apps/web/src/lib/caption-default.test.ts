import { describe, expect, it } from "vitest";
import { pickDefaultCaptionIndex } from "@/lib/caption-default";

const t = (languageCode: string, label: string) => ({ label, languageCode });

// YRccclHk5M0: English original, auto-dubbed into many languages, ASR for each.
const DUBBED = [
  t("ar", "Arabic (auto-generated)"),
  t("bn", "Bangla (auto-generated)"),
  t("en", "English (auto-generated)"),
  t("iw", "Hebrew (auto-generated)"),
  t("nl", "Dutch (auto-generated)"),
];

describe("pickDefaultCaptionIndex", () => {
  it("uses the original audio language, not the first track", () => {
    expect(
      pickDefaultCaptionIndex(DUBBED, {
        preferred: "original",
        originalAudioLanguage: "en-US",
      }),
    ).toBe(2);
  });

  it("uses the chosen language when the video has it", () => {
    expect(
      pickDefaultCaptionIndex(DUBBED, {
        preferred: "nl",
        originalAudioLanguage: "en-US",
      }),
    ).toBe(4);
  });

  it("matches the base language and legacy codes", () => {
    expect(
      pickDefaultCaptionIndex(DUBBED, {
        preferred: "he-IL",
        originalAudioLanguage: "en-US",
      }),
    ).toBe(3);
  });

  it("falls back to the original when the chosen language is missing", () => {
    expect(
      pickDefaultCaptionIndex(DUBBED, {
        preferred: "de",
        originalAudioLanguage: "en-US",
      }),
    ).toBe(2);
  });

  it("takes the single auto-generated track as the original", () => {
    const tracks = [
      t("en", "English"),
      t("nl", "Dutch (auto-generated)"),
      t("fr", "French"),
    ];
    expect(pickDefaultCaptionIndex(tracks, { preferred: "original" })).toBe(1);
  });

  it("prefers human-made captions over auto-generated ones", () => {
    const tracks = [t("nl", "Dutch (auto-generated)"), t("nl-NL", "Dutch")];
    expect(pickDefaultCaptionIndex(tracks, { preferred: "nl" })).toBe(1);
  });

  it("falls back to English, then the first track", () => {
    expect(
      pickDefaultCaptionIndex([t("fr", "French"), t("en", "English")], {
        preferred: "original",
      }),
    ).toBe(1);
    expect(
      pickDefaultCaptionIndex([t("fr", "French"), t("de", "German")], {
        preferred: "original",
      }),
    ).toBe(0);
  });
});
