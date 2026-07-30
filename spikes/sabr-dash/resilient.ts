/**
 * A resilient wrapper around SabrStream.
 *
 * The PoC proved SABR converts to DASH. This asks the harder question: does it
 * keep working. Everything here targets a failure mode we have actually seen or
 * that yt-dlp's test suite says is real:
 *
 *  - **stalls** — observed live: yt-dlp aborted with "no activity detected in 3
 *    consecutive requests" on its second run. SabrStream has its own stall
 *    handling, but a watchdog above it means a hung session cannot wedge a
 *    request forever.
 *  - **player-response reload** — the server can invalidate a session mid-pull.
 *    SabrStream emits `reloadPlayerResponse`; re-fetching and re-deciphering is
 *    the caller's job.
 *  - **transient failure** — retry with backoff, re-fetching the player response
 *    each attempt so we never retry with a stale streaming URL.
 *  - **partial progress** — a converter serves segments lazily, so it must be
 *    able to stop early and to start mid-video rather than pulling everything.
 */
import { JSDOM } from 'jsdom';
import { BG, type BgConfig } from 'bgutils-js';
import { Constants, Innertube, Platform, UniversalCache, type Types } from 'youtubei.js';
import { SabrStream } from 'googlevideo/sabr-stream';
import { buildSabrFormat, EnabledTrackTypes } from 'googlevideo/utils';

export interface PullOptions {
  videoId: string;
  client?: string;
  /** Stop after this many video segments; a converter serves lazily. */
  maxSegments?: number;
  /** Start mid-video (ms). Exercises random access. */
  startAtMs?: number;
  /** Abort an attempt if no bytes arrive for this long. */
  stallMs?: number;
  /** Total attempts before giving up. */
  attempts?: number;
  quiet?: boolean;
}

export interface PullResult {
  ok: boolean;
  attemptsUsed: number;
  segments: { number: number; bytes: number; baseMediaDecodeTime?: number }[];
  initBytes: number;
  timescale?: number;
  firstDecodeTimeSec?: number;
  reloads: number;
  stalls: number;
  errors: string[];
  wallMs: number;
}

Platform.shim.eval = async (
  data: Types.BuildScriptResult,
  env: Record<string, Types.VMPrimative>,
) => {
  const props = [];
  if (env.n) props.push(`n: exportedVars.nFunction("${env.n}")`);
  if (env.sig) props.push(`sig: exportedVars.sigFunction("${env.sig}")`);
  return new Function(`${data.output}\nreturn { ${props.join(', ')} }`)();
};

let poTokenCache: { token: string; at: number } | null = null;

/**
 * BotGuard attestation is the expensive part of session setup, so cache it.
 * Ten minutes is arbitrary but well inside its lifetime; a real converter would
 * refresh on the invalidation signal instead of on a clock.
 */
async function getPoToken(binding: string): Promise<string> {
  if (poTokenCache && Date.now() - poTokenCache.at < 10 * 60_000) return poTokenCache.token;
  const dom = new JSDOM();
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const bgConfig: BgConfig = {
    fetch: (input: any, init?: RequestInit) => fetch(input, init),
    globalObj: globalThis,
    identifier: binding,
    requestKey: 'O43z0dpjhgX20SCx4KAo',
  };
  const challenge = await BG.Challenge.create(bgConfig);
  if (!challenge) throw new Error('no BotGuard challenge');
  const vm = challenge.interpreterJavascript.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!vm) throw new Error('no BotGuard VM');
  new Function(vm)();
  const res = await BG.PoToken.generate({
    program: challenge.program,
    globalName: challenge.globalName,
    bgConfig,
  });
  poTokenCache = { token: res.poToken!, at: Date.now() };
  return res.poToken!;
}

/** Boxes we need to split on; kept local so this file stands alone. */
function readBox(buf: Buffer, off: number) {
  if (off + 8 > buf.length) return null;
  const size = buf.readUInt32BE(off);
  const type = buf.subarray(off + 4, off + 8).toString('latin1');
  if (!/^[a-zA-Z0-9]{4}$/.test(type) || size < 8 || off + size > buf.length) return null;
  return { size, type };
}

function baseMediaDecodeTime(moof: Buffer): number | undefined {
  const i = moof.indexOf('tfdt', 0, 'latin1');
  if (i < 0) return undefined;
  const version = moof.readUInt8(i + 4);
  const off = i + 8;
  if (version === 1) return off + 8 <= moof.length ? Number(moof.readBigUInt64BE(off)) : undefined;
  return off + 4 <= moof.length ? moof.readUInt32BE(off) : undefined;
}

function timescaleOf(init: Buffer): number | undefined {
  const i = init.indexOf('mvhd', 0, 'latin1');
  if (i < 0) return undefined;
  const version = init.readUInt8(i + 4);
  const off = i + 4 + 4 + (version === 1 ? 16 : 8);
  return off + 4 <= init.length ? init.readUInt32BE(off) : undefined;
}

/** One attempt. Throws on stall or error so the caller can retry. */
async function attempt(opts: PullOptions, result: PullResult): Promise<void> {
  const innertube = await Innertube.create({ cache: new UniversalCache(true) });
  const poToken = await getPoToken(innertube.session.context.client.visitorData || opts.videoId);

  const fetchPlayer = () => innertube.getBasicInfo(opts.videoId, (opts.client ?? 'WEB') as any) as any;
  const info = await fetchPlayer();

  const url = await innertube.session.player?.decipher(info.streaming_data?.server_abr_streaming_url);
  const ustreamer =
    info.player_config?.media_common_config?.media_ustreamer_request_config
      ?.video_playback_ustreamer_config;
  if (!url || !ustreamer) throw new Error('no SABR streaming url/ustreamer config');

  const stream = new SabrStream({
    formats: info.streaming_data?.adaptive_formats.map(buildSabrFormat) ?? [],
    serverAbrStreamingUrl: url,
    videoPlaybackUstreamerConfig: ustreamer,
    poToken,
    clientInfo: {
      clientName: parseInt(
        Constants.CLIENT_NAME_IDS[
          innertube.session.context.client.clientName as keyof typeof Constants.CLIENT_NAME_IDS
        ],
      ),
      clientVersion: innertube.session.context.client.clientVersion,
    },
  });

  stream.on('reloadPlayerResponse', async (ctx: any) => {
    result.reloads++;
    if (!opts.quiet) console.log('    reloadPlayerResponse -> refetching');
    const fresh = await fetchPlayer();
    const freshUrl = await innertube.session.player?.decipher(
      fresh.streaming_data?.server_abr_streaming_url,
    );
    const freshCfg =
      fresh.player_config?.media_common_config?.media_ustreamer_request_config
        ?.video_playback_ustreamer_config;
    if (freshUrl && freshCfg) {
      stream.setStreamingURL(freshUrl);
      stream.setUstreamerConfig(freshCfg);
    }
  });

  const isMp4 = (f: any) => (f.mimeType ?? '').includes('mp4');
  const startOpts: any = {
    videoFormat: (f: any[]) => f.filter((x) => isMp4(x) && x.width)[0],
    audioFormat: (f: any[]) => f.filter((x) => isMp4(x) && !x.width)[0],
    enabledTrackTypes: EnabledTrackTypes.VIDEO_ONLY,
  };
  if (opts.startAtMs) startOpts.state = { playerTimeMs: opts.startAtMs };

  const { videoStream } = await stream.start(startOpts);

  // Watchdog: SabrStream has its own stall handling, but a hung session must not
  // be able to wedge a request indefinitely.
  const stallMs = opts.stallMs ?? 20_000;
  let lastByteAt = Date.now();
  let aborted = false;
  // `stream.abort()`, not `reader.cancel()`. Cancelling the reader leaves
  // SabrStream writing into a closed controller, which it then retries ten times
  // per segment — the library has to be told to stop, not have the floor pulled
  // out from under it.
  const watchdog = setInterval(() => {
    if (Date.now() - lastByteAt > stallMs) {
      aborted = true;
      result.stalls++;
      try { stream.abort(); } catch { /* already gone */ }
    }
  }, 250);

  const reader = (videoStream as ReadableStream<Uint8Array>).getReader();
  let buf = Buffer.alloc(0);
  let init: Buffer | null = null;
  const header: Buffer[] = [];
  let pendingMoof: Buffer | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || aborted) break;
      lastByteAt = Date.now();
      buf = Buffer.concat([buf, Buffer.from(value)]);

      let off = 0;
      for (;;) {
        const box = readBox(buf, off);
        if (!box) break;
        const raw = buf.subarray(off, off + box.size);
        if (!init) {
          if (box.type === 'moof') {
            init = Buffer.concat(header);
            result.initBytes = init.length;
            result.timescale = timescaleOf(init);
            pendingMoof = Buffer.from(raw);
          } else header.push(Buffer.from(raw));
        } else if (box.type === 'moof') pendingMoof = Buffer.from(raw);
        else if (box.type === 'mdat' && pendingMoof) {
          const t = baseMediaDecodeTime(pendingMoof);
          if (result.segments.length === 0 && t !== undefined && result.timescale) {
            result.firstDecodeTimeSec = t / result.timescale;
          }
          result.segments.push({
            number: result.segments.length + 1,
            bytes: pendingMoof.length + raw.length,
            baseMediaDecodeTime: t,
          });
          pendingMoof = null;
        }
        off += box.size;
      }
      if (off > 0) buf = buf.subarray(off);

      if (opts.maxSegments && result.segments.length >= opts.maxSegments) {
        try { stream.abort(); } catch { /* already gone */ }
        break;
      }
    }
  } finally {
    clearInterval(watchdog);
  }

  if (aborted) throw new Error(`stalled: no bytes for ${stallMs}ms`);
  if (result.segments.length === 0) throw new Error('no segments produced');
}

/** Retry with backoff, refetching the player response each attempt. */
export async function pull(opts: PullOptions): Promise<PullResult> {
  const started = Date.now();
  const result: PullResult = {
    ok: false,
    attemptsUsed: 0,
    segments: [],
    initBytes: 0,
    reloads: 0,
    stalls: 0,
    errors: [],
    wallMs: 0,
  };
  const attempts = opts.attempts ?? 3;

  for (let i = 1; i <= attempts; i++) {
    result.attemptsUsed = i;
    result.segments = [];
    try {
      await attempt(opts, result);
      result.ok = true;
      break;
    } catch (e: any) {
      result.errors.push(`attempt ${i}: ${e?.message ?? e}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 500 * 2 ** (i - 1)));
    }
  }
  result.wallMs = Date.now() - started;
  return result;
}
