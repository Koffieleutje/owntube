import { describe, expect, it } from "vitest";
import { cardThumbnailWidth } from "@/server/media/upstream-proxy";

describe("cardThumbnailWidth", () => {
  it("accepts only the offered card widths", () => {
    expect(cardThumbnailWidth("480")).toBe(480);
    expect(cardThumbnailWidth("320")).toBe(320);
    expect(cardThumbnailWidth("640")).toBe(640);
  });

  it("ignores anything else, so each video caches a few variants at most", () => {
    expect(cardThumbnailWidth(null)).toBeNull();
    expect(cardThumbnailWidth("")).toBeNull();
    expect(cardThumbnailWidth("481")).toBeNull();
    expect(cardThumbnailWidth("999")).toBeNull();
    expect(cardThumbnailWidth("abc")).toBeNull();
  });
});
