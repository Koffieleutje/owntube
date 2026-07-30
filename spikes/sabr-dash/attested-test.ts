/**
 * Does a properly attested session get past the ~60s cut-off on a long video?
 *
 * GVS_BINDING=session|content chooses what the streaming token is bound to; the
 * guide says web GVS tokens are usually video-bound, the companion binds its
 * streaming token to visitorData, so try both.
 */
import { Constants, Innertube, Platform, UniversalCache, type Types } from 'youtubei.js';
import { SabrStream } from 'googlevideo/sabr-stream';
import { buildSabrFormat, EnabledTrackTypes } from 'googlevideo/utils';
import { createMinter } from './minter.js';
import { USER_AGENT as BG_USER_AGENT } from 'bgutils-js';

Platform.shim.eval = async (d: Types.BuildScriptResult, e: Record<string, Types.VMPrimative>) => {
  const props = [];
  if (e.n) props.push(`n: exportedVars.nFunction("${e.n}")`);
  if (e.sig) props.push(`sig: exportedVars.sigFunction("${e.sig}")`);
  return new Function(`${d.output}\nreturn { ${props.join(', ')} }`)();
};

const VIDEO = process.argv[2] ?? '0e3GPea1Tyg';
const GVS_BINDING = process.env.GVS_BINDING ?? 'session';

// The session that asks for the challenge must look like the browser BotGuard is
// about to attest, so it carries the same user agent the minter presents.
const bootstrap = await Innertube.create({
  enable_session_cache: false,
  retrieve_player: false,
  user_agent: BG_USER_AGENT,
});
const minter = await createMinter(bootstrap);

const contentPoToken = await minter.mint(VIDEO);
const sessionPoToken = await minter.mint(minter.visitorData);
const gvsPoToken = GVS_BINDING === 'content' ? contentPoToken : sessionPoToken;

// The player request must carry the content token, or the ustreamer config it
// returns was issued to an unattested session.
const innertube = await Innertube.create({
  po_token: contentPoToken,
  visitor_data: minter.visitorData,
  cache: new UniversalCache(true),
});
const info: any = await innertube.getBasicInfo(VIDEO, 'WEB' as any);

const url = await innertube.session.player?.decipher(info.streaming_data?.server_abr_streaming_url);
const ustreamer =
  info.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
if (!url || !ustreamer) throw new Error('no SABR url / ustreamer config');

console.log(`${VIDEO} ${info.basic_info?.duration}s | WEB | gvs binding=${GVS_BINDING}`);

const stream = new SabrStream({
  formats: (info.streaming_data?.adaptive_formats ?? []).map(buildSabrFormat),
  serverAbrStreamingUrl: url,
  videoPlaybackUstreamerConfig: ustreamer,
  poToken: gvsPoToken,
  clientInfo: {
    clientName: parseInt((Constants.CLIENT_NAME_IDS as any).WEB),
    clientVersion: innertube.session.context.client.clientVersion,
  },
});

const statuses = new Set<number>();
stream.on('streamProtectionStatusUpdate', (s: any) => statuses.add(s?.status));

const isMp4 = (f: any) => (f.mimeType ?? '').includes('mp4');
const { videoStream } = await stream.start({
  videoFormat: (f: any[]) => f.find((x) => x.itag === 160) ?? f.filter((x) => isMp4(x) && x.width)[0],
  audioFormat: (f: any[]) => {
    const a = f.filter((x) => isMp4(x) && !x.width);
    return a.find((x) => !x.isDubbed && !x.isDrc) ?? a.find((x) => !x.isDubbed) ?? a[0];
  },
  enabledTrackTypes: EnabledTrackTypes.VIDEO_AND_AUDIO,
});

const started = Date.now();
const reader = (videoStream as ReadableStream<Uint8Array>).getReader();
let bytes = 0, moofs = 0, lastLog = 0;
try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    const b = Buffer.from(value);
    for (let i = 0; i + 4 <= b.length; i++)
      if (b[i] === 0x6d && b[i+1] === 0x6f && b[i+2] === 0x6f && b[i+3] === 0x66) moofs++;
    if (bytes - lastLog > 4_000_000) {
      lastLog = bytes;
      console.log(`  ${(bytes/1e6).toFixed(1)}MB  ~${moofs} moof  ${((Date.now()-started)/1000)|0}s`);
    }
  }
  console.log(`OK: COMPLETE — ${(bytes/1e6).toFixed(1)}MB, ~${moofs} moof, ${((Date.now()-started)/1000)|0}s, statuses=[${[...statuses]}]`);
} catch (e: any) {
  console.log(`FAILED after ${((Date.now()-started)/1000)|0}s, ${(bytes/1e6).toFixed(1)}MB, ~${moofs} moof, statuses=[${[...statuses]}]: ${e?.message ?? e}`);
}
