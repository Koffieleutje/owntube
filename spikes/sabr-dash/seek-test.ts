/**
 * Seeking with SabrStream, by asserting a synthetic buffered range.
 *
 * SabrStream has no seek API. But `setupStreamingProcess` only rebuilds
 * `cachedBufferedRanges` when the restored set is empty, so a non-empty set from
 * `state` is sent verbatim. A player seeking to T tells the server "my playhead
 * is at T"; the server then sends from the end of what we claim to hold. So:
 * claim 0..T is buffered, set playerTimeMs=T, and the next media should start
 * at T rather than at 0 or at wherever the snapshot left off.
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
    clientInfo: {
      clientName: parseInt(Constants.CLIENT_NAME_IDS[yt.session.context.client.clientName as keyof typeof Constants.CLIENT_NAME_IDS]),
      clientVersion: yt.session.context.client.clientVersion,
    },
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

async function read(stream: SabrStream, s: ReadableStream<Uint8Array>, max: number, knownTs?: number, onFirst?: () => void) {
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
      else if (type === 'mdat' && pending) { times.push(tfdt(pending)!); pending = null; }
      off += size;
    }
    if (off) buf = buf.subarray(off);
    if (times.length >= max) { onFirst?.(); try { stream.abort(); } catch {} break; }
  }
  return { times, ts };
}

// Prime a session so we have real formatInitializationMetadata to reuse.
console.log('priming a session to capture format metadata...');
const s0 = streamFor();
const r0 = await s0.start(base() as any);
let snapshot: any = null;
// getState() throws if the main format is not yet initialized, and it is only
// valid *before* abort(), so try at each opportunity and keep the last good one.
const grab = () => { try { snapshot = s0.getState(); } catch { /* not ready */ } };
const primed = await read(s0, r0.videoStream as any, 4, undefined, grab);
if (!snapshot) grab();
if (!snapshot) throw new Error('could not capture a session snapshot');
console.log(`   primed: ${primed.times.length} segs, timescale=${primed.ts}, formats=${snapshot.initializedFormats.length}`);

for (const targetSec of [60, 120, 180]) {
  const targetMs = targetSec * 1000;
  // Claim everything from 0 to the seek target is already buffered, for every
  // initialized format, so the server's next media starts at the target.
  const cachedBufferedRanges = snapshot.initializedFormats.map((f: any) => ({
    formatId: f.formatInitializationMetadata.formatId,
    startTimeMs: '0',
    durationMs: String(targetMs),
    startSegmentIndex: 1,
    endSegmentIndex: Math.max(1, Math.round(targetSec / 5)),
    timeRange: { startTicks: '0', durationTicks: String(targetMs), timescale: 1000 },
  }));

  const state = {
    ...snapshot,
    playerTimeMs: targetMs,
    durationMs: sess.durationMs || snapshot.durationMs,
    cachedBufferedRanges,
    initializedFormats: snapshot.initializedFormats.map((f: any) => ({ ...f, downloadedSegments: [], lastMediaHeaders: [] })),
  };

  const s = streamFor();
  try {
    const r = await s.start(base(state) as any);
    const got = await read(s, r.videoStream as any, 2, primed.ts);
    const at = got.times.length ? got.times[0] / got.ts! : NaN;
    const ok = Math.abs(at - targetSec) < 12;
    console.log(`seek ${String(targetSec).padStart(3)}s -> first segment ${Number.isNaN(at) ? 'none' : at.toFixed(1) + 's'}  ${ok ? 'OK' : 'MISS'}`);
  } catch (e: any) {
    console.log(`seek ${String(targetSec).padStart(3)}s -> ERROR ${String(e?.message).slice(0, 70)}`);
  }
}
