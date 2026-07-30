import { afterEach, describe, expect, it } from "vitest";
import {
  companionInternalBase,
  companionPublicBase,
  toInternalCompanionUrl,
} from "@/server/services/companion";

const PUBLIC = "https://inv.example";
const INTERNAL = "http://invidious-companion:8282";

describe("companion base resolution", () => {
  const env = process.env;
  afterEach(() => {
    process.env = env;
  });

  it("falls back to the public base when no internal address is set", () => {
    process.env = { ...env, INVIDIOUS_PUBLIC_BASE_URL: PUBLIC };
    delete process.env.INVIDIOUS_COMPANION_INTERNAL_URL;
    expect(companionPublicBase()).toBe(PUBLIC);
    expect(companionInternalBase()).toBe(PUBLIC);
  });

  it("trims trailing slashes from both", () => {
    process.env = {
      ...env,
      INVIDIOUS_PUBLIC_BASE_URL: `${PUBLIC}//`,
      INVIDIOUS_COMPANION_INTERNAL_URL: `${INTERNAL}/`,
    };
    expect(companionPublicBase()).toBe(PUBLIC);
    expect(companionInternalBase()).toBe(INTERNAL);
  });
});

describe("toInternalCompanionUrl", () => {
  const env = process.env;
  afterEach(() => {
    process.env = env;
  });

  function withBases(fn: () => void) {
    process.env = {
      ...env,
      INVIDIOUS_PUBLIC_BASE_URL: PUBLIC,
      INVIDIOUS_COMPANION_INTERNAL_URL: INTERNAL,
    };
    fn();
  }

  it("swaps the public origin for the internal one, keeping path and query", () => {
    withBases(() => {
      expect(
        toInternalCompanionUrl(
          `${PUBLIC}/companion/videoplayback?itag=140&sq=7&pot=abc`,
        ),
      ).toBe(`${INTERNAL}/companion/videoplayback?itag=140&sq=7&pot=abc`);
    });
  });

  it("leaves URLs on other hosts alone", () => {
    withBases(() => {
      const googlevideo =
        "https://rr3---sn-abc.googlevideo.com/videoplayback?itag=140";
      expect(toInternalCompanionUrl(googlevideo)).toBe(googlevideo);
    });
  });

  it("is idempotent — an already-internal URL is untouched", () => {
    withBases(() => {
      const internal = `${INTERNAL}/companion/videoplayback?sq=1`;
      expect(toInternalCompanionUrl(internal)).toBe(internal);
    });
  });

  it("does not rewrite a host that merely shares the public prefix", () => {
    withBases(() => {
      // `https://inv.example.evil.test` starts with the public base as a string
      // but is a different host; the trailing-slash check is what stops it.
      const lookalike = `${PUBLIC}.evil.test/companion/videoplayback`;
      expect(toInternalCompanionUrl(lookalike)).toBe(lookalike);
    });
  });

  it("passes through unchanged when the two bases are equal", () => {
    process.env = {
      ...env,
      INVIDIOUS_PUBLIC_BASE_URL: PUBLIC,
      INVIDIOUS_COMPANION_INTERNAL_URL: PUBLIC,
    };
    const url = `${PUBLIC}/companion/videoplayback?sq=1`;
    expect(toInternalCompanionUrl(url)).toBe(url);
  });

  it("passes through unchanged when no public base is configured", () => {
    process.env = { ...env, INVIDIOUS_COMPANION_INTERNAL_URL: INTERNAL };
    delete process.env.INVIDIOUS_PUBLIC_BASE_URL;
    const url = `${PUBLIC}/companion/videoplayback?sq=1`;
    expect(toInternalCompanionUrl(url)).toBe(url);
  });
});
