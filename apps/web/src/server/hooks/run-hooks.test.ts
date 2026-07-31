import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHooks } from "./run-hooks";

describe("runHooks", () => {
  let dir: string;
  const savedEnv = process.env.OWNTUBE_HOOKS_DIR;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ot-hooks-"));
    process.env.OWNTUBE_HOOKS_DIR = dir;
  });

  afterEach(() => {
    process.env.OWNTUBE_HOOKS_DIR = savedEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const event = {
    event: "watched" as const,
    videoId: "abc123XYZ_-",
    channelId: "UCchan",
    positionSeconds: 591,
    durationSeconds: 620,
    completed: true,
    videoTitle: "T",
    source: "live" as const,
  };

  it("runs executables with the env contract and stdin JSON, in order", async () => {
    const outA = path.join(dir, "a.out");
    const outB = path.join(dir, "b.out");
    fs.writeFileSync(
      path.join(dir, "10-a.sh"),
      `#!/bin/sh\nprintf '%s %s %s %s ' "$OT_EVENT" "$OT_VIDEO_ID" "$OT_COMPLETED" "$OT_SOURCE" > ${outA}\ncat >> ${outA}\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(dir, "20-b.sh"),
      `#!/bin/sh\ndate +%s%N > ${outB}\n`,
      { mode: 0o755 },
    );
    // Non-executables are skipped, and a failing hook doesn't break the run.
    fs.writeFileSync(path.join(dir, "ignored.txt"), "not a hook");
    fs.writeFileSync(path.join(dir, "15-fails.sh"), "#!/bin/sh\nexit 3\n", {
      mode: 0o755,
    });

    await runHooks(event);

    const a = fs.readFileSync(outA, "utf8");
    expect(a).toContain("watched abc123XYZ_- true live ");
    expect(a).toContain('"videoId":"abc123XYZ_-"');
    expect(fs.existsSync(outB)).toBe(true);
  });

  it("is a no-op without a hooks dir or video id", async () => {
    process.env.OWNTUBE_HOOKS_DIR = "";
    await expect(runHooks(event)).resolves.toBeUndefined();
    process.env.OWNTUBE_HOOKS_DIR = dir;
    await expect(runHooks({ ...event, videoId: "" })).resolves.toBeUndefined();
  });
});
