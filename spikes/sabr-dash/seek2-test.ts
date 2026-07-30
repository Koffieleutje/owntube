/**
 * Headless seek, done the way yt-dlp does it.
 *
 * yt-dlp's `build_vpabr_request` maps consumed ranges to BufferedRange as:
 *   start_segment_index = cr.start_sequence_number
 *   end_segment_index   = cr.end_sequence_number
 *   start_time_ms / duration_ms, timescale 1000
 *
 * Those sequence numbers are *real* — the earlier attempt failed because it
 * fabricated end_segment_index as `targetSec / 5`, which corresponds to no
 * actual segment boundary, and the server simply declined to serve.
 *
 * So: index the stream once (segment N -> decode time + duration), then assert a
 * consumed range that ends on a real boundary. That is the mechanism a converter
 * would use: index on first touch, then serve any segment thereafter.
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
async function poToken(b: string) {
  if (po) return po;
  const dom = new JSDOM();
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const cfg: BgConfig = { fetch: (i: any, x?: RequestInit) => fetch(i, x), globalObj: globalThis, identifier: b, requestKey: 'O43z0dpjhgX20SCx4KAo' };
  const ch = await BG.Challenge.create(cfg);
  new Function(ch!.interpreterJavascript.privateDoNotAccessOrElseSafeScriptWrappedValue!)();
  po = (await BG.PoToken.generate({ program: ch!.program, globalName: ch!.globalName, bgConfig: cfg })).poToken!;
  return po;
}
const tfdt = (b: Buffer) => { const i = b.indexOf('tfdt', 0, 'latin1'); if (i < 0) return undefined; return b.readUInt8(i+4) === 1 ? Number(b.readBigUInt64BE(i+8)) : b.readUInt32BE(i+8); };
const tscale = (b: Buffer) => { const i = b.indexOf('mvhd', 0, 'latin1'); if (i < 0) return undefined; const v = b.readUInt8(i+4); return b.readUInt32BE(i+4+4+(v===1?16:8)); };

const sess = await (async () => {
  const yt = await Innertube.create({ cache: new UniversalCache(true) });
  const info: any = await yt.getBasicInfo(VIDEO, 'WEB' as any);
  return {
    formats: info.streaming_data?.adaptive_formats.map(buildSabrFormat) ?? [],
    url: (await yt.session.player?.decipher(info.streaming_data?.server_abr_streaming_url))!,
    cfg: info.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config!,
    poToken: await poToken(yt.session.context.client.visitorData || VIDEO),
    clientInfo: { clientName: parseInt(Constants.CLIENT_NAME_IDS[yt.session.context.client.clientName as keyof typeof Constants.CLIENT_NAME_IDS]), clientVersion: yt.session.context.client.clientVersion },
    durationMs: (info.basic_info?.duration ?? 0) * 1000,
  };
})();
const streamFor = () => new SabrStream({ formats: sess.formats, serverAbrStreamingUrl: sess.url, videoPlaybackUstreamerConfig: sess.cfg, poToken: sess.poToken, clientInfo: sess.clientInfo });
const isMp4 = (f: any) => (f.mimeType ?? '').includes('mp4');
const base = (state?: any) => ({
  videoFormat: (f: any[]) => f.filter((x) => isMp4(x) && x.width && x.height === 360)[0],
  audioFormat: (f: any[]) => f.filter((x) => isMp4(x) && !x.width)[0],
  enabledTrackTypes: EnabledTrackTypes.VIDEO_AND_AUDIO,
  ...(state ? { state } : {}),
});
async function read(stream: SabrStream, s: ReadableStream<Uint8Array>, max: number, knownTs?: number, onEach?: () => void) {
  const reader = s.getReader();
  let buf = Buffer.alloc(0), init: Buffer | null = knownTs ? Buffer.alloc(0) : null, pending: Buffer | null = null, ts = knownTs;
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
      if (!init) { if (type === 'moof') { init = Buffer.concat(header); ts = tscale(init); pending = Buffer.from(raw); } else header.push(Buffer.from(raw)); }
      else if (type === 'moof') pending = Buffer.from(raw);
      else if (type === 'mdat' && pending) { times.push(tfdt(pending)!); pending = null; onEach?.(); }
      off += size;
    }
    if (off) buf = buf.subarray(off);
    if (times.length >= max) { try { stream.abort(); } catch {} break; }
  }
  return { times, ts };
}

// 1. Index the whole stream once: real segment boundaries.
console.log('indexing (one full pass)...');
const s0 = streamFor();
const r0 = await s0.start(base() as any);
let snap: any = null;
const grab = () => { try { snap = s0.getState(); } catch {} };
const idx = await read(s0, r0.videoStream as any, 999, undefined, grab);
if (!snap) grab();
const ts = idx.ts!;
const startsSec = idx.times.map((t) => t / ts);
console.log(`   indexed ${idx.times.length} segments, timescale=${ts}, last starts at ${startsSec.at(-1)!.toFixed(1)}s`);

// 2. Seek by asserting a consumed range that ends on a REAL segment boundary.
for (const targetSec of [60, 120, 180]) {
  // The segment we want is the first whose start >= target; we claim everything
  // before it. end_sequence_number is that segment's index (1-based), exclusive.
  let k = startsSec.findIndex((v) => v >= targetSec);
  if (k <= 0) k = 1;
  const claimedDurationMs = Math.round(startsSec[k] * 1000);

  const cr = {
    startTimeMs: '0',
    durationMs: String(claimedDurationMs),
    startSegmentIndex: 1,
    endSegmentIndex: k,                       // real boundary, 1-based
    timeRange: { startTicks: '0', durationTicks: String(claimedDurationMs), timescale: 1000 },
  };
  const state = {
    ...snap,
    playerTimeMs: claimedDurationMs,
    durationMs: sess.durationMs || snap.durationMs,
    cachedBufferedRanges: snap.initializedFormats.map((f: any) => ({ ...cr, formatId: f.formatInitializationMetadata.formatId })),
    initializedFormats: snap.initializedFormats.map((f: any) => ({ ...f, downloadedSegments: [], lastMediaHeaders: [] })),
  };

  const s = streamFor();
  try {
    const r = await s.start(base(state) as any);
    const got = await read(s, r.videoStream as any, 1, ts);
    const at = got.times.length ? got.times[0] / got.ts! : NaN;
    const want = startsSec[k];
    console.log(`seek ~${String(targetSec).padStart(3)}s (segment ${k + 1},真 start ${want.toFixed(1)}s) -> got ${Number.isNaN(at) ? 'none' : at.toFixed(1) + 's'}  ${Math.abs(at - want) < 6 ? 'OK' : 'MISS'}`);
  } catch (e: any) {
    console.log(`seek ~${targetSec}s -> ERROR ${String(e?.message).slice(0, 60)}`);
  }
}
