import type { SponsorBlockCategory } from "@web/lib/sponsorblock";

/**
 * Mirrors the web's SPONSORBLOCK_CATEGORY_LABELS; copied rather than imported
 * because that module pulls zod into the bundle at runtime.
 */
export const SPONSORBLOCK_LABELS: Record<SponsorBlockCategory, string> = {
  sponsor: "Sponsor",
  selfpromo: "Self-promotion",
  interaction: "Interaction reminder",
  intro: "Intro",
  outro: "Outro",
  preview: "Preview / recap",
  hook: "Hook",
  filler: "Filler",
};

/** Seek-bar colours per category, SponsorBlock's own convention. */
export const SPONSORBLOCK_COLORS: Record<SponsorBlockCategory, string> = {
  sponsor: "#00d400",
  selfpromo: "#ffff00",
  interaction: "#cc00ff",
  intro: "#00ffff",
  outro: "#0202ed",
  preview: "#008fd6",
  hook: "#395699",
  filler: "#7300ff",
};
