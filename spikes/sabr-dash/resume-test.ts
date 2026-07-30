/**
 * yt-dlp's `test_resume.py`, ported to our converter's actual need.
 *
 * A DASH converter must serve segment N without pulling 0..N-1 every time.
 * `SabrStream.start({ state })` looks like a seek, but `restoreState` rejects a
 * bare `{ playerTimeMs }` — it requires a state captured from a live session,
 * carrying both format keys, their init metadata, and downloaded segments.
 *
 * So the question is not "can we seek" but "can we snapshot a session and resume
 * it later at a different position". That is what a session cache would do.
 */
import { JSDOM } from 'jsdom';
import { BG, type BgConfig } from 'bgutils-js';
import { Constants, Innertube, Platform, UniversalCache, type Types } from 'youtubei.js';
import { SabrStream } from 'googlevideo/sabr-stream';
import { buildSabrFormat, EnabledTrackTypes } from 'googlevideo/utils';

Platform.shim.eval = async (d: Types.BuildScriptResult, env: Record<string, Types.VMPrimative>) => {
  const p = [];
  if (env.n) p.push(`n: exportedVars.nFunction("${env.n}")`);
  if (env.sig) p.push(`sig: exportedVars.sigFunction("${env.sig}")`);
  return new Function(`${d.output}\nreturn { ${p.join(', ')} }`)();
};

const VIDEO = process.argv[2] ?? 'dQw4w9WgXcQ';
let po: string | null = null;

async function poToken(binding: string) {
  if (po) return po;
  const dom = new JSDOM();
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const cfg: BgConfig = { fetch: (i: any, x?: RequestInit) => fetch(i, x), globalObj: globalThis, identifier: binding, requestKey: 'O43z0dpjhgX20SCx4KAo' };
  const ch = await BG.Challenge.create(cfg);
  new Function(ch!.interpreterJavascript.privateDoNotAccessOrElseSafeScriptWrappedValue!)();
  po = (await BG.PoToken.generate({ program: ch!.program, globalName: ch!.globalName, bgConfig: cfg })).poToken!;
  return po;
}

function tfdt(b: Buffer) {
  const i = b.indexOf('tfdt', 0, 'latin1');
  if (i < 0) return undefined;
  return b.readUInt8(i + 4) === 1 ? Number(b.readBigUInt64BE(i + 8)) : b.readUInt32BE(i + 8);
}
function timescale(b: Buffer) {
  const i = b.indexOf('mvhd', 0, 'latin1');
  if (i < 0) return undefined;
  const v = b.readUInt8(i + 4);
  return b.readUInt32BE(i + 4 + 4 + (v === 1 ? 16 : 8));
}

/**
 * A session is the player response + deciphered streaming URL + ustreamer config.
 * Resuming across *different* sessions fails with
 * `sabr.media_serving_enforcement_id_error`, so the converter must keep these
 * together and spin SabrStream instances against one cached session.
 */
async function makeSession() {
  const yt = await Innertube.create({ cache: new UniversalCache(true) });
  const info: any = await yt.getBasicInfo(VIDEO, 'WEB' as any);
  const url = await yt.session.player?.decipher(info.streaming_data?.server_abr_streaming_url);
  const cfg = info.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
  return {
    formats: info.streaming_data?.adaptive_formats.map(buildSabrFormat) ?? [],
    url: url!, cfg: cfg!,
    poToken: await poToken(yt.session.context.client.visitorData || VIDEO),
    clientInfo: {
      clientName: parseInt(Constants.CLIENT_NAME_IDS[yt.session.context.client.clientName as keyof typeof Constants.CLIENT_NAME_IDS]),
      clientVersion: yt.session.context.client.clientVersion,
    },
  };
}

function streamFor(sess: any) {
  return new SabrStream({
    formats: sess.formats, serverAbrStreamingUrl: sess.url,
    videoPlaybackUstreamerConfig: sess.cfg, poToken: sess.poToken, clientInfo: sess.clientInfo,
  });
}

const isMp4 = (f: any) => (f.mimeType ?? '').includes('mp4');
const opts = (state?: any) => ({
  videoFormat: (f: any[]) => f.filter((x) => isMp4(x) && x.width && x.height === 360)[0],
  audioFormat: (f: any[]) => f.filter((x) => isMp4(x) && !x.width)[0],
  enabledTrackTypes: EnabledTrackTypes.VIDEO_AND_AUDIO,
  ...(state ? { state } : {}),
});

/** Read up to `max` segments, returning their decode times, then abort. */
async function read(stream: SabrStream, s: ReadableStream<Uint8Array>, max: number, onBeforeAbort?: () => void, knownTimescale?: number) {
  const reader = s.getReader();
  // On resume the server does NOT resend ftyp/moov — the client is assumed to
  // still have the init segment. So when we already know the timescale, start in
  // the 'init already seen' state or we would wait for a header that never comes.
  let buf = Buffer.alloc(0), init: Buffer | null = knownTimescale ? Buffer.alloc(0) : null, pending: Buffer | null = null, ts: number | undefined = knownTimescale;
  const header: Buffer[] = [], times: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf = Buffer.concat([buf, Buffer.from(value)]);
    let off = 0;
    for (;;) {
      if (off + 8 > buf.length) break;
      const size = buf.readUInt32BE(off);
      const type = buf.subarray(off + 4, off + 8).toString('latin1');
      if (!/^[a-zA-Z0-9]{4}$/.test(type) || size < 8 || off + size > buf.length) break;
      const raw = buf.subarray(off, off + size);
      if (!init) {
        if (type === 'moof') { init = Buffer.concat(header); ts = timescale(init); pending = Buffer.from(raw); }
        else header.push(Buffer.from(raw));
      } else if (type === 'moof') pending = Buffer.from(raw);
      else if (type === 'mdat' && pending) { times.push(tfdt(pending)!); pending = null; }
      off += size;
    }
    if (off) buf = buf.subarray(off);
    if (times.length >= max) { onBeforeAbort?.(); try { stream.abort(); } catch {} break; }
  }
  return { times, ts };
}

const sess = await makeSession();

console.log('== 1. bare {playerTimeMs} (what we tried first)');
{
  const stream = streamFor(sess);
  const { videoStream } = await stream.start(opts({ playerTimeMs: 60_000 }) as any);
  const { times, ts } = await read(stream, videoStream as any, 2);
  console.log(`   asked 60s -> first segment ${(times[0] / ts!).toFixed(1)}s  ${times[0] === 0 ? 'IGNORED (as restoreState documents)' : 'honoured'}`);
}

console.log('\n== 2. snapshot a live session, then resume it at a later position');
{
  const s1 = streamFor(sess);
  const r1 = await s1.start(opts() as any);
  let state: any = null;
  const a = await read(s1, r1.videoStream as any, 4, () => { state = s1.getState(); });
  if (!state) state = s1.getState();
  console.log(`   session A read ${a.times.length} segments, ended at ${(a.times.at(-1)! / a.ts!).toFixed(1)}s`);
  console.log(`   snapshot: durationMs=${state.durationMs} playerTimeMs=${state.playerTimeMs} formats=${state.initializedFormats?.length} requestNumber=${state.requestNumber}`);

  const s2 = streamFor(sess);   // same session, new stream instance
  // Keep the format initialization (restoreState requires it) but drop every
  // claim about what we already hold: the server continues from the buffered
  // ranges we assert, so leaving them in place pins us to the old position.
  const resumed = {
    ...state,
    playerTimeMs: 120_000,
    cachedBufferedRanges: [],
    requestNumber: 0,
    initializedFormats: (state.initializedFormats ?? []).map((f: any) => ({
      ...f,
      downloadedSegments: [],
      lastMediaHeaders: [],
    })),
  };
  try {
    const r2 = await s2.start(opts(resumed) as any);
    const b = await read(s2, r2.videoStream as any, 2, undefined, a.ts);
    const at = b.times[0] / b.ts!;
    console.log(`   session B resumed at playerTimeMs=120000 -> first segment ${at.toFixed(1)}s  ${Math.abs(at - 120) < 12 ? 'SEEK WORKS' : 'MISS (started at ' + at.toFixed(1) + 's)'}`);
  } catch (e: any) {
    console.log(`   resume FAILED: ${e?.message ?? e}`);
  }
}
