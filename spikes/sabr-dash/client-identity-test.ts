/**
 * Does a *correctly formed* ANDROID_VR session survive past 57s?
 *
 * Every previous "client" test was a lie: `getBasicInfo(id, client)` fetches the
 * player response as that client but does not mutate `session.context.client`,
 * so the clientInfo we handed the SABR server was always WEB. This builds the
 * clientInfo from the client we actually asked for, and attaches no po_token —
 * which is what yt-dlp does when it downloads this exact video in full.
 */
import { Constants, Innertube, Platform, UniversalCache, type Types } from 'youtubei.js';
import { SabrStream } from 'googlevideo/sabr-stream';
import { buildSabrFormat, EnabledTrackTypes } from 'googlevideo/utils';

Platform.shim.eval = async (
  data: Types.BuildScriptResult,
  env: Record<string, Types.VMPrimative>,
) => {
  const props = [];
  if (env.n) props.push(`n: exportedVars.nFunction("${env.n}")`);
  if (env.sig) props.push(`sig: exportedVars.sigFunction("${env.sig}")`);
  return new Function(`${data.output}\nreturn { ${props.join(', ')} }`)();
};

const VIDEO = process.argv[2] ?? '0e3GPea1Tyg';
const CLIENT = process.argv[3] ?? 'ANDROID_VR';
const WITH_POTOKEN = process.argv.includes('--potoken');

const innertube = await Innertube.create({ cache: new UniversalCache(true) });
const info: any = await innertube.getBasicInfo(VIDEO, CLIENT as any);

const url =
  (await innertube.session.player?.decipher(info.streaming_data?.server_abr_streaming_url)) ??
  info.streaming_data?.server_abr_streaming_url;
const ustreamer =
  info.player_config?.media_common_config?.media_ustreamer_request_config
    ?.video_playback_ustreamer_config;
if (!url || !ustreamer) throw new Error('no SABR url / ustreamer config');

// The whole point: name the client we actually fetched as, not the session's.
const clientName = parseInt((Constants.CLIENT_NAME_IDS as any)[CLIENT]);
const clientVersion =
  (Constants as any).CLIENTS?.[CLIENT]?.VERSION ?? innertube.session.context.client.clientVersion;

let poToken: string | undefined;
if (WITH_POTOKEN) {
  const { mintPoToken } = await import('./sabr.js');
  poToken = await mintPoToken(innertube.session.context.client.visitorData || VIDEO);
}

console.log(
  `${VIDEO} ${info.basic_info?.duration}s | client=${CLIENT} id=${clientName} v=${clientVersion} | poToken=${poToken ? 'yes' : 'no'}`,
);

const stream = new SabrStream({
  formats: (info.streaming_data?.adaptive_formats ?? []).map(buildSabrFormat),
  serverAbrStreamingUrl: url,
  videoPlaybackUstreamerConfig: ustreamer,
  ...(poToken ? { poToken } : {}),
  // The full device identity, not just the name and version. yt-dlp sends
  // deviceMake/deviceModel/osName/osVersion/androidSdkVersion too, and claiming
  // to be a Quest 3 app without saying so is a thin story to tell the server.
  clientInfo: {
    clientName,
    clientVersion,
    ...(CLIENT === 'ANDROID_VR'
      ? { deviceMake: 'Oculus', deviceModel: 'Quest 3', osName: 'Android', osVersion: '12L', androidSdkVersion: 32 }
      : {}),
  },
});

stream.on('streamProtectionStatusUpdate', (s: any) =>
  console.log(`  streamProtectionStatus -> ${s?.status}`),
);

const isMp4 = (f: any) => (f.mimeType ?? '').includes('mp4');
const wantItag = process.env.ITAG ? parseInt(process.env.ITAG) : undefined;
const { videoStream } = await stream.start({
  videoFormat: (f: any[]) =>
    (wantItag ? f.find((x) => x.itag === wantItag) : undefined) ??
    f.filter((x) => isMp4(x) && x.width)[0],
  // The default track, explicitly. Taking the first mp4 audio format picks
  // whichever dub the server happens to list first — and asking for a
  // non-default audio track is what makes the server demand attestation.
  audioFormat: (f: any[]) => {
    const audio = f.filter((x) => isMp4(x) && !x.width);
    return (
      audio.find((x) => !x.isDubbed && !x.isDrc) ??
      audio.find((x) => !x.isDubbed) ??
      audio[0]
    );
  },
  enabledTrackTypes: process.env.TRACKS === 'av'
    ? EnabledTrackTypes.VIDEO_AND_AUDIO
    : EnabledTrackTypes.VIDEO_ONLY,
});

const started = Date.now();
const reader = (videoStream as ReadableStream<Uint8Array>).getReader();
let bytes = 0;
let moofs = 0;
let lastLog = 0;
try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    // Cheap moof count: enough to see progress without a full box walk.
    const buf = Buffer.from(value);
    for (let i = 0; i + 4 <= buf.length; i++) {
      if (buf[i] === 0x6d && buf[i + 1] === 0x6f && buf[i + 2] === 0x6f && buf[i + 3] === 0x66) moofs++;
    }
    if (bytes - lastLog > 4_000_000) {
      lastLog = bytes;
      console.log(`  ${(bytes / 1e6).toFixed(1)}MB  ~${moofs} moof  ${((Date.now() - started) / 1000) | 0}s`);
    }
  }
  console.log(`OK: complete — ${(bytes / 1e6).toFixed(1)}MB, ~${moofs} moof, ${((Date.now() - started) / 1000) | 0}s`);
} catch (e: any) {
  console.log(`FAILED after ${((Date.now() - started) / 1000) | 0}s, ${(bytes / 1e6).toFixed(1)}MB, ~${moofs} moof: ${e?.message ?? e}`);
}
