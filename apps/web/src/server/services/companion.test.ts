import { createDecipheriv } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  companionCheckParam,
  companionInternalBase,
  companionPublicBase,
  toInternalCompanionUrl,
  withCompanionCheck,
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

describe("companionCheckParam", () => {
  const env = process.env;
  const KEY = "testkey000000001"; // any 16 chars; aes-128-ecb needs exactly 16
  afterEach(() => {
    process.env = env;
  });

  it("returns null when no key is configured, so the param is omitted", () => {
    process.env = { ...env };
    delete process.env.INVIDIOUS_COMPANION_SECRET_KEY;
    expect(companionCheckParam("haxkWC6MgcQ")).toBeNull();
    expect(withCompanionCheck("https://x/api", "haxkWC6MgcQ")).toBe(
      "https://x/api",
    );
  });

  it("throws on a wrong-length key instead of failing per request", () => {
    process.env = { ...env, INVIDIOUS_COMPANION_SECRET_KEY: "tooshort" };
    expect(() => companionCheckParam("haxkWC6MgcQ")).toThrow(/16 characters/);
  });

  it("produces a token the companion's verifyRequest can decrypt", () => {
    process.env = { ...env, INVIDIOUS_COMPANION_SECRET_KEY: KEY };
    const videoId = "haxkWC6MgcQ";
    const check = companionCheckParam(videoId);
    expect(check).not.toBeNull();
    // Mirror the companion: urlsafe -> standard base64, AES-128-ECB decrypt,
    // then split on "|" (src/lib/helpers/verifyRequest.ts).
    const raw = Buffer.from(
      (check as string).replaceAll("-", "+").replaceAll("_", "/"),
      "base64",
    );
    const d = createDecipheriv("aes-128-ecb", KEY, null);
    const plain = Buffer.concat([d.update(raw), d.final()]).toString("utf8");
    const [ts, id] = plain.split("|");
    expect(id).toBe(videoId);
    expect(Number(ts)).toBeGreaterThan(1_700_000_000);
    // Not in the future — the companion rejects timestamps >6h ahead.
    expect(Number(ts)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 2);
  });

  it("uses the urlsafe alphabet and keeps padding, as Crystal does", () => {
    process.env = { ...env, INVIDIOUS_COMPANION_SECRET_KEY: KEY };
    const check = companionCheckParam("haxkWC6MgcQ") as string;
    expect(check).not.toMatch(/[+/]/);
    expect(check).toMatch(/^[A-Za-z0-9\-_]+={0,2}$/);
  });

  it("appends with & when the URL already has a query", () => {
    process.env = { ...env, INVIDIOUS_COMPANION_SECRET_KEY: KEY };
    const out = withCompanionCheck("https://x/api?local=true", "haxkWC6MgcQ");
    expect(out).toContain("?local=true&check=");
  });
});
