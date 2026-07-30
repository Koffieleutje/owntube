/**
 * Is a po_token actually required for headless SABR?
 *
 * BotGuard attestation is the most expensive and most fragile part of session
 * setup — it needs jsdom and runs YouTube's own VM code. yt-dlp's SABR branch
 * says "for web: you will need to provide a PO Token", implying other clients
 * may not. Worth knowing before building it into a connector.
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

let cached: string | null = null;
async function mintPoToken(binding: string) {
  if (cached) return cached;
  const t0 = Date.now();
  const dom = new JSDOM();
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const cfg: BgConfig = { fetch: (i: any, x?: RequestInit) => fetch(i, x), globalObj: globalThis, identifier: binding, requestKey: 'O43z0dpjhgX20SCx4KAo' };
  const ch = await BG.Challenge.create(cfg);
  new Function(ch!.interpreterJavascript.privateDoNotAccessOrElseSafeScriptWrappedValue!)();
  cached = (await BG.PoToken.generate({ program: ch!.program, globalName: ch!.globalName, bgConfig: cfg })).poToken!;
  console.log(`   (BotGuard attestation took ${Date.now() - t0}ms)`);
  return cached;
}

const tfdt = (b: Buffer) => { const i = b.indexOf('tfdt', 0, 'latin1'); if (i < 0) return undefined; return b.readUInt8(i+4) === 1 ? Number(b.readBigUInt64BE(i+8)) : b.readUInt32BE(i+8); };

async function tryClient(client: string, withPoToken: boolean) {
  const t0 = Date.now();
  try {
    const yt = await Innertube.create({ cache: new UniversalCache(true) });
    const info: any = await yt.getBasicInfo(VIDEO, client as any);
    const url = await yt.session.player?.decipher(info.streaming_data?.server_abr_streaming_url);
    const cfg = info.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
    if (!url || !cfg) return { ok: false, why: 'no sabr url/config', ms: Date.now() - t0 };

    const stream = new SabrStream({
      formats: info.streaming_data?.adaptive_formats.map(buildSabrFormat) ?? [],
      serverAbrStreamingUrl: url,
      videoPlaybackUstreamerConfig: cfg,
      ...(withPoToken ? { poToken: await mintPoToken(yt.session.context.client.visitorData || VIDEO) } : {}),
      clientInfo: {
        clientName: parseInt(Constants.CLIENT_NAME_IDS[yt.session.context.client.clientName as keyof typeof Constants.CLIENT_NAME_IDS]),
        clientVersion: yt.session.context.client.clientVersion,
      },
    });
    const isMp4 = (f: any) => (f.mimeType ?? '').includes('mp4');
    const { videoStream } = await stream.start({
      videoFormat: (f: any[]) => f.filter((x) => isMp4(x) && x.width)[0],
      audioFormat: (f: any[]) => f.filter((x) => isMp4(x) && !x.width)[0],
      enabledTrackTypes: EnabledTrackTypes.VIDEO_ONLY,
    } as any);

    const reader = (videoStream as ReadableStream<Uint8Array>).getReader();
    let buf = Buffer.alloc(0), seen = 0, pending: Buffer | null = null, sawInit = false;
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
        if (type === 'moov') sawInit = true;
        if (type === 'moof') pending = Buffer.from(buf.subarray(off, off + size));
        if (type === 'mdat' && pending) { seen++; pending = null; }
        off += size;
      }
      if (off) buf = buf.subarray(off);
      if (seen >= 2) { try { stream.abort(); } catch {} break; }
    }
    return { ok: seen > 0, why: seen > 0 ? `${seen} segments, init=${sawInit}` : 'no segments', ms: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, why: String(e?.message ?? e).slice(0, 52), ms: Date.now() - t0 };
  }
}

for (const client of ['WEB', 'ANDROID', 'IOS', 'TV', 'MWEB', 'WEB_EMBEDDED']) {
  const without = await tryClient(client, false);
  console.log(`${client.padEnd(13)} no po_token: ${without.ok ? 'WORKS' : 'fails '} (${String(without.ms).padStart(5)}ms) ${without.why}`);
}
console.log('');
const withTok = await tryClient('WEB', true);
console.log(`WEB           WITH po_token: ${withTok.ok ? 'WORKS' : 'fails '} (${withTok.ms}ms) ${withTok.why}`);
