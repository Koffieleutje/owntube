/**
 * Player response from a *pure* ANDROID_VR innertube call — hand-rolled fetch,
 * no youtubei.js session, no WEB visitorData, exactly the request yt-dlp makes.
 *
 * Rationale: the server sends yt-dlp zero SabrContextUpdates over a complete
 * 1541s download, but sends us one at ~57s and then stops serving media. The
 * sessions are being classified differently, and every request-level field has
 * been made identical — so the difference must be in how the streaming session
 * is established, i.e. the player request.
 */
import { SabrStream } from 'googlevideo/sabr-stream';
import { buildSabrFormat, EnabledTrackTypes } from 'googlevideo/utils';
import { Innertube } from 'youtubei.js';

const VIDEO = process.argv[2] ?? '0e3GPea1Tyg';

// A visitorData is still required (LOGIN_REQUIRED without one) — but only the
// id itself: the player call below shares nothing else with the WEB session
// that produced it.
const bootstrap = await Innertube.create({ retrieve_player: false });
const visitorData = bootstrap.session.context.client.visitorData!;
const UA = 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip';

const context = {
  client: {
    clientName: 'ANDROID_VR',
    clientVersion: '1.65.10',
    deviceMake: 'Oculus',
    deviceModel: 'Quest 3',
    androidSdkVersion: 32,
    userAgent: UA,
    osName: 'Android',
    osVersion: '12L',
    hl: 'en',
    gl: 'US',
    visitorData,
  },
};

const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'user-agent': UA,
    'x-youtube-client-name': '28',
    'x-youtube-client-version': '1.65.10',
    'x-goog-visitor-id': visitorData,
  },
  body: JSON.stringify({
    context,
    videoId: VIDEO,
    contentCheckOk: true,
    racyCheckOk: true,
  }),
});
const player: any = await res.json();

const status = player?.playabilityStatus?.status;
const url = player?.streamingData?.serverAbrStreamingUrl;
const ustreamer =
  player?.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig;
const duration = parseInt(player?.videoDetails?.lengthSeconds ?? '0');
console.log(`${VIDEO} ${duration}s | raw ANDROID_VR | status=${status} | sabrUrl=${!!url} ustreamer=${!!ustreamer}`);
if (!url || !ustreamer) {
  console.log(JSON.stringify(player?.playabilityStatus ?? {}, null, 2).slice(0, 500));
  process.exit(1);
}

// buildSabrFormat reads the raw camelCase player JSON directly (`lastModified`,
// `mimeType`); only drc and the audio track id need aliasing.
const formats = (player.streamingData.adaptiveFormats ?? []).map((f: any) =>
  buildSabrFormat({
    ...f,
    is_drc: f.isDrc,
    audio_track: f.audioTrack
      ? { id: f.audioTrack.id, audio_is_default: f.audioTrack.audioIsDefault }
      : undefined,
  } as any),
);

const stream = new SabrStream({
  formats,
  serverAbrStreamingUrl: url, // ANDROID_VR needs no deciphering
  videoPlaybackUstreamerConfig: ustreamer,
  clientInfo: {
    clientName: 28,
    clientVersion: '1.65.10',
    deviceMake: 'Oculus',
    deviceModel: 'Quest 3',
    osName: 'Android',
    osVersion: '12L',
    androidSdkVersion: 32,
  } as any,
  fetch: (input: any, init?: any) =>
    fetch(input, { ...init, headers: { ...(init?.headers ?? {}), 'user-agent': UA } }),
});

stream.on('streamProtectionStatusUpdate', (s: any) => console.log(`  protection -> ${s?.status}`));

const isMp4 = (f: any) => (f.mimeType ?? '').includes('mp4');
const { videoStream } = await stream.start({
  videoFormat: (f: any[]) => f.find((x) => x.itag === 160) ?? f.filter((x) => isMp4(x) && x.width)[0],
  audioFormat: (f: any[]) => {
    const a = f.filter((x) => !x.width);
    return a.find((x) => !x.isDubbed && !x.isDrc) ?? a[0];
  },
  enabledTrackTypes: EnabledTrackTypes.VIDEO_ONLY,
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
      console.log(`  ${(bytes/1e6).toFixed(1)}MB ~${moofs} moof ${((Date.now()-started)/1000)|0}s`);
    }
  }
  console.log(`OK: COMPLETE — ${(bytes/1e6).toFixed(1)}MB, ~${moofs} moof, ${((Date.now()-started)/1000)|0}s`);
} catch (e: any) {
  console.log(`FAILED after ${((Date.now()-started)/1000)|0}s, ${(bytes/1e6).toFixed(1)}MB, ~${moofs} moof: ${e?.message ?? e}`);
}
