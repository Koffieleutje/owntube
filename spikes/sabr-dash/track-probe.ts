/** How many audio tracks does the raw VR response expose, vs youtubei.js? */
import { Innertube, UniversalCache } from 'youtubei.js';
const bootstrap = await Innertube.create({ retrieve_player: false });
const visitorData = bootstrap.session.context.client.visitorData!;
const UA = 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip';
const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'user-agent': UA, 'x-youtube-client-name': '28', 'x-youtube-client-version': '1.65.10', 'x-goog-visitor-id': visitorData },
  body: JSON.stringify({ context: { client: { clientName: 'ANDROID_VR', clientVersion: '1.65.10', deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L', hl: 'en', gl: 'US', visitorData } }, videoId: '0e3GPea1Tyg', contentCheckOk: true, racyCheckOk: true }),
});
const p: any = await res.json();
const fmts = p?.streamingData?.adaptiveFormats ?? [];
const tracks = new Set(fmts.filter((f: any) => f.audioTrack).map((f: any) => f.audioTrack.id));
console.log(`raw VR: formats=${fmts.length} audioTracks=${tracks.size} [${[...tracks].slice(0,5).join(', ')}...]`);
