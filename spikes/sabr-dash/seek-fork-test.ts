/**
 * Does the forked `startAtMs` actually seek?
 *
 * The fork changes two lines: `SabrPlaybackOptions.startAtMs`, and
 * `let playerTimeMs = options.startAtMs ?? 0` in `setupStreamingProcess`.
 *
 * The theory: on the FIRST request no formats are initialized, so no buffered
 * ranges are sent — the request carries only `clientAbrState.playerTimeMs`. Every
 * earlier attempt failed because it also injected fabricated buffered ranges,
 * which contradicted that position. Setting the position alone should be enough.
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
    duration: info.basic_info?.duration ?? 0,
  };
})();
const streamFor = () => new SabrStream({ formats: sess.formats, serverAbrStreamingUrl: sess.url, videoPlaybackUstreamerConfig: sess.cfg, poToken: sess.poToken, clientInfo: sess.clientInfo });
const isMp4 = (f: any) => (f.mimeType ?? '').includes('mp4');

async function firstSegmentAt(startAtMs?: number) {
  const s = streamFor();
  const r = await s.start({
    videoFormat: (f: any[]) => f.filter((x) => isMp4(x) && x.width && x.height === 360)[0],
    audioFormat: (f: any[]) => f.filter((x) => isMp4(x) && !x.width)[0],
    enabledTrackTypes: EnabledTrackTypes.VIDEO_AND_AUDIO,
    ...(startAtMs ? { startAtMs } : {}),
  } as any);
  const reader = (r.videoStream as ReadableStream<Uint8Array>).getReader();
  let buf = Buffer.alloc(0), init: Buffer | null = null, pending: Buffer | null = null, ts: number | undefined;
  const header: Buffer[] = [];
  let firstTime: number | undefined;
  try {
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
        else if (type === 'mdat' && pending) { firstTime = tfdt(pending); pending = null; }
        off += size;
      }
      if (off) buf = buf.subarray(off);
      if (firstTime !== undefined) { try { s.abort(); } catch {} break; }
    }
  } catch { /* fall through */ }
  return firstTime !== undefined && ts ? firstTime / ts : NaN;
}

console.log(`video duration ${sess.duration}s\n`);
console.log('baseline (no startAtMs):');
console.log(`   -> first segment at ${(await firstSegmentAt()).toFixed(1)}s\n`);

for (const target of [30, 60, 120, 180]) {
  if (target > sess.duration) continue;
  const at = await firstSegmentAt(target * 1000);
  const ok = !Number.isNaN(at) && Math.abs(at - target) < 10;
  console.log(`startAtMs=${String(target * 1000).padStart(6)} (${String(target).padStart(3)}s) -> first segment ${Number.isNaN(at) ? 'none' : at.toFixed(1) + 's'}  ${ok ? 'SEEK WORKS' : 'MISS'}`);
}
