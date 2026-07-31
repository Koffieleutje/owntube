import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logger } from "@/lib/logger";

/**
 * Generic playback hooks, in the pocket-sessions mold: OwnTube reports the
 * event with enough context to identify the video, and each executable in
 * OWNTUBE_HOOKS_DIR decides whether it cares. The server knows nothing about
 * the receivers — credentials and endpoints live in the scripts' environment
 * (the container env), never in OwnTube itself.
 *
 * Contract: every executable runs once per event, in lexical order, with the
 * event as OT_* environment variables and as JSON on stdin. Exit status is
 * logged; a failing or slow hook never blocks another hook or the caller.
 * Hooks MUST be idempotent: replays (see OT_SOURCE=replay) re-deliver
 * current state after outages, and over-delivery has to be harmless.
 */

export type HookEvent = {
  /** watched (completed) or progress (position moved). */
  event: "watched" | "progress";
  videoId: string;
  channelId?: string;
  positionSeconds: number;
  /** 0 = unknown. */
  durationSeconds: number;
  completed: boolean;
  videoTitle?: string;
  channelName?: string;
  /** live = a real playback write; replay = the reconciliation sweep. */
  source: "live" | "replay";
};

const HOOK_TIMEOUT_MS = Number.parseInt(
  process.env.OWNTUBE_HOOK_TIMEOUT_MS ?? "30000",
  10,
);

function hooksDir(): string {
  return process.env.OWNTUBE_HOOKS_DIR?.trim() ?? "";
}

/** Executable regular files, lexically ordered so operators can sequence
 * them by name (10-foo, 20-bar). */
function listHooks(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.join(dir, e.name))
    .filter((p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

function envFor(event: HookEvent): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OT_EVENT: event.event,
    OT_VIDEO_ID: event.videoId,
    OT_CHANNEL_ID: event.channelId ?? "",
    OT_POSITION_SECONDS: String(Math.max(0, Math.floor(event.positionSeconds))),
    OT_DURATION_SECONDS: String(Math.max(0, Math.floor(event.durationSeconds))),
    OT_COMPLETED: event.completed ? "true" : "false",
    OT_VIDEO_TITLE: event.videoTitle ?? "",
    OT_CHANNEL_NAME: event.channelName ?? "",
    OT_SOURCE: event.source,
    OT_AT: String(Math.floor(Date.now() / 1000)),
  };
}

function runOne(script: string, event: HookEvent): Promise<void> {
  return new Promise((resolve) => {
    const name = path.basename(script);
    const child = spawn(script, [], {
      env: envFor(event),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: HOOK_TIMEOUT_MS,
    });
    let output = "";
    child.stdout?.on("data", (d: Buffer) => {
      output += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      output += d.toString();
    });
    child.on("error", (error) => {
      logger.warn("hook failed to start", { hook: name, err: error.message });
      resolve();
    });
    child.on("close", (code) => {
      const trimmed = output.trim();
      if (code === 0) {
        if (trimmed) {
          logger.info("hook ran", {
            hook: name,
            event: event.event,
            output: trimmed,
          });
        }
      } else {
        logger.warn("hook failed", {
          hook: name,
          event: event.event,
          code,
          output: trimmed,
        });
      }
      resolve();
    });
    child.stdin?.end(JSON.stringify(event));
  });
}

/**
 * Run every hook for one event, sequentially, and resolve when all finished.
 * Callers on hot paths should NOT await (fire and forget); the reconciliation
 * sweep awaits to keep replays orderly.
 */
export async function runHooks(event: HookEvent): Promise<void> {
  const dir = hooksDir();
  if (!dir || !event.videoId) return;
  for (const script of listHooks(dir)) {
    await runOne(script, event);
  }
}

/** Fire-and-forget wrapper for hot paths (history writes). */
export function fireHooks(event: HookEvent): void {
  void runHooks(event).catch((error: unknown) => {
    logger.warn("hooks run failed", {
      err: error instanceof Error ? error.message : String(error),
    });
  });
}
