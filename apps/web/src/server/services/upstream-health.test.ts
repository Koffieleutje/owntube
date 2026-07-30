import { beforeEach, describe, expect, it } from "vitest";
import {
  orderUpstreamCandidates,
  recordUpstreamFailure,
  recordUpstreamSuccess,
  resetUpstreamHealthForTests,
  upstreamHealthSnapshot,
} from "@/server/services/upstream-health";

describe("upstream health", () => {
  beforeEach(() => {
    resetUpstreamHealthForTests();
  });

  it("keeps a healthy preferred instance first", () => {
    recordUpstreamSuccess("invidious", "https://one.example", 120);
    recordUpstreamSuccess("invidious", "https://two.example", 80);

    expect(
      orderUpstreamCandidates(
        "invidious",
        ["https://one.example", "https://two.example"],
        "https://one.example",
      ),
    ).toEqual(["https://one.example", "https://two.example"]);
  });

  it("skips cooled-down failed instances while another candidate exists", () => {
    recordUpstreamFailure(
      "invidious",
      "https://bad.example",
      new Error("timeout"),
      8000,
    );

    expect(
      orderUpstreamCandidates("invidious", [
        "https://bad.example",
        "https://good.example",
      ]),
    ).toEqual(["https://good.example"]);
    expect(
      upstreamHealthSnapshot("invidious", "https://bad.example").status,
    ).toBe("cooldown");
  });

  it("retries cooled-down instances when every candidate is cooled down", () => {
    recordUpstreamFailure("invidious", "https://one.example", new Error("502"));
    recordUpstreamFailure("invidious", "https://two.example", new Error("503"));

    expect(
      orderUpstreamCandidates("invidious", [
        "https://one.example",
        "https://two.example",
      ]),
    ).toEqual(["https://one.example", "https://two.example"]);
  });
});
