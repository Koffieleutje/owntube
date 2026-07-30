/**
 * SABR -> DASH proof of concept.
 *
 * Pulls a video over YouTube's SABR protocol server-side, cuts the resulting
 * fMP4 into DASH segments, and writes a manifest. The point is only to answer
 * one question: can a headless server turn SABR into something an ordinary DASH
 * player can consume? Nothing here is production shaped — no sessions, no
 * caching, no seeking, one quality rung.
 */
import { writeFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { BG, type BgConfig } from 'bgutils-js';
import {
  Constants,
  Innertube,
  type IPlayerResponse,
  Platform,
  UniversalCache,
  YTNodes,
  type Types,
} from 'youtubei.js';
import { SabrStream } from 'googlevideo/sabr-stream';
import { buildSabrFormat, EnabledTrackTypes } from 'googlevideo/utils';

import { segment, type SegmentResult } from './segmenter.js';

const VIDEO_ID = process.argv[2] ?? 'dQw4w9WgXcQ';
const CLIENT = (process.argv[3] ?? 'WEB') as any;
const OUT = 'dash-out';

// youtubei.js needs a way to run YouTube's signature JS. Same shim as the
// library's own downloader example.
Platform.shim.eval = async (
  data: Types.BuildScriptResult,
  env: Record<string, Types.VMPrimative>,
) => {
  const properties = [];
  if (env.n) properties.push(`n: exportedVars.nFunction("${env.n}")`);
  if (env.sig) properties.push(`sig: exportedVars.sigFunction("${env.sig}")`);
  return new Function(`${data.output}\nreturn { ${properties.join(', ')} }`)();
};

async function generateWebPoToken(contentBinding: string) {
  const dom = new JSDOM();
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const bgConfig: BgConfig = {
    fetch: (input: any, init?: RequestInit) => fetch(input, init),
    globalObj: globalThis,
    identifier: contentBinding,
    requestKey: 'O43z0dpjhgX20SCx4KAo',
  };
  const challenge = await BG.Challenge.create(bgConfig);
  if (!challenge) throw new Error('no BotGuard challenge');
  const vm = challenge.interpreterJavascript.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!vm) throw new Error('no BotGuard VM');
  new Function(vm)();
  return BG.PoToken.generate({
    program: challenge.program,
    globalName: challenge.globalName,
    bgConfig,
  });
}

/**
 * `getBasicInfo` rather than a hand-rolled NavigationEndpoint call: the latter
 * silently came back without `server_abr_streaming_url`, and every client
 * returns it through this path (verified across WEB/ANDROID/IOS/TV/MWEB).
 */
async function playerRequest(innertube: Innertube, videoId: string, _reload?: any) {
  return innertube.getBasicInfo(videoId, CLIENT) as any;
}

/**
 * Minimal single-Representation DASH manifest.
 *
 * Uses `SegmentTimeline` rather than a fixed-duration `SegmentTemplate`: SABR's
 * video fragments are *not* uniform (measured 3.4s-7.0s on the test video),
 * so a fixed duration would desynchronise the timeline. Audio happens to be
 * uniform (~9.98s) but gets the same treatment for consistency.
 */
function buildMpd(opts: {
  durationSec: number;
  video: { result: SegmentResult; mimeType: string; codecs: string; width: number; height: number; bandwidth: number };
  audio: { result: SegmentResult; mimeType: string; codecs: string; bandwidth: number };
}): string {
  const timeline = (r: SegmentResult, durationSec: number) => {
    const ts = r.timescale ?? 1000;
    const t = r.segments.map((s) => s.baseMediaDecodeTime ?? 0);
    const durations = t.map((v, i) =>
      i < t.length - 1 ? t[i + 1] - v : Math.max(1, Math.round(durationSec * ts) - v),
    );
    // Collapse runs of equal durations into <S ... r="n"/> as the spec allows.
    const runs: { d: number; r: number }[] = [];
    for (const d of durations) {
      const last = runs[runs.length - 1];
      if (last && last.d === d) last.r++;
      else runs.push({ d, r: 0 });
    }
    return {
      ts,
      xml: runs
        .map((run) => `        <S d="${run.d}"${run.r ? ` r="${run.r}"` : ''}/>`)
        .join('\n'),
      total: durations.reduce((a, b) => a + b, 0) / ts,
    };
  };

  const v = timeline(opts.video.result, opts.durationSec);
  const a = timeline(opts.audio.result, opts.durationSec);

  const set = (
    dir: string,
    tl: { ts: number; xml: string },
    mimeType: string,
    repAttrs: string,
  ) => `    <AdaptationSet mimeType="${mimeType}" segmentAlignment="true" startWithSAP="1">
      <SegmentTemplate timescale="${tl.ts}" startNumber="1"
                       initialization="${dir}/init.mp4" media="${dir}/seg-$Number$.m4s">
        <SegmentTimeline>
${tl.xml}
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation ${repAttrs}/>
    </AdaptationSet>`;

  const mpd = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011"
     type="static" mediaPresentationDuration="PT${opts.durationSec}S" minBufferTime="PT4S">
  <Period>
${set('video', v, opts.video.mimeType, `id="video" codecs="${opts.video.codecs}" width="${opts.video.width}" height="${opts.video.height}" bandwidth="${opts.video.bandwidth}"`)}
${set('audio', a, opts.audio.mimeType, `id="audio" codecs="${opts.audio.codecs}" audioSamplingRate="${a.ts}" bandwidth="${opts.audio.bandwidth}"`)}
  </Period>
</MPD>
`;
  console.log(`\ntimeline coverage: video ${v.total.toFixed(1)}s, audio ${a.total.toFixed(1)}s, declared ${opts.durationSec}s`);
  return mpd;
}

async function main() {
  const t0 = Date.now();
  const innertube = await Innertube.create({ cache: new UniversalCache(true) });
  const po = await generateWebPoToken(videoIdBinding(innertube));
  const player = await playerRequest(innertube, VIDEO_ID);

  const serverAbrStreamingUrl = await innertube.session.player?.decipher(
    player.streaming_data?.server_abr_streaming_url,
  );
  const ustreamer =
    player.player_config?.media_common_config?.media_ustreamer_request_config
      ?.video_playback_ustreamer_config;

  console.log(`title: ${player.basic_info?.title}`);
  console.log(`duration: ${player.basic_info?.duration}s`);
  console.log(`server_abr_streaming_url: ${serverAbrStreamingUrl ? 'present' : 'MISSING'}`);
  console.log(`ustreamer config: ${ustreamer ? 'present' : 'MISSING'}`);
  if (!serverAbrStreamingUrl || !ustreamer) throw new Error('video does not offer SABR');

  const formats = player.streaming_data?.adaptive_formats.map(buildSabrFormat) ?? [];
  console.log(`sabr formats: ${formats.length}`);

  const stream = new SabrStream({
    formats,
    serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig: ustreamer,
    poToken: po.poToken,
    clientInfo: {
      clientName: parseInt(
        Constants.CLIENT_NAME_IDS[
          innertube.session.context.client.clientName as keyof typeof Constants.CLIENT_NAME_IDS
        ],
      ),
      clientVersion: innertube.session.context.client.clientVersion,
    },
  });

  stream.on('reloadPlayerResponse', async (ctx) => {
    console.log('! server asked for a player-response reload — handling');
    const fresh = await playerRequest(innertube, VIDEO_ID, ctx);
    const url = await innertube.session.player?.decipher(fresh.streaming_data?.server_abr_streaming_url);
    const cfg = fresh.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
    if (url && cfg) {
      stream.setStreamingURL(url);
      stream.setUstreamerConfig(cfg);
    }
  });

  // Explicit selectors, not preference flags. `preferWebM: false` still handed
  // back audio/webm+opus, which is EBML rather than ISO-BMFF and so cannot be
  // cut into fMP4 segments at all. OwnTube's DASH path emits fMP4, so demand it.
  const isMp4 = (f: any) => (f.mimeType ?? '').includes('mp4');
  const { videoStream, audioStream, selectedFormats } = await stream.start({
    videoFormat: (formats: any[]) =>
      formats.filter((f) => isMp4(f) && f.width && f.height === 360)[0] ??
      formats.filter((f) => isMp4(f) && f.width)[0],
    audioFormat: (formats: any[]) => formats.filter((f) => isMp4(f) && !f.width)[0],
    enabledTrackTypes: EnabledTrackTypes.VIDEO_AND_AUDIO,
  } as any);

  console.log(`\nselected video: ${selectedFormats.videoFormat.mimeType}`);
  console.log(`selected audio: ${selectedFormats.audioFormat.mimeType}`);

  const [video, audio] = await Promise.all([
    segment(videoStream as ReadableStream<Uint8Array>, `${OUT}/video`),
    segment(audioStream as ReadableStream<Uint8Array>, `${OUT}/audio`),
  ]);

  const parseCodec = (mime?: string) => {
    const m = /codecs="?([^"]+)"?/.exec(mime ?? '');
    return { base: (mime ?? '').split(';')[0], codecs: m?.[1] ?? '' };
  };
  const vInfo = parseCodec(selectedFormats.videoFormat.mimeType);
  const aInfo = parseCodec(selectedFormats.audioFormat.mimeType);

  const mpd = buildMpd({
    durationSec: Number(player.basic_info?.duration ?? 0),
    video: {
      result: video,
      mimeType: vInfo.base,
      codecs: vInfo.codecs,
      width: selectedFormats.videoFormat.width ?? 0,
      height: selectedFormats.videoFormat.height ?? 0,
      bandwidth: Number(selectedFormats.videoFormat.bitrate ?? 0),
    },
    audio: {
      result: audio,
      mimeType: aInfo.base,
      codecs: aInfo.codecs,
      bandwidth: Number(selectedFormats.audioFormat.bitrate ?? 0),
    },
  });
  writeFileSync(`${OUT}/manifest.mpd`, mpd);

  const report = (name: string, r: SegmentResult) => {
    const t = r.segments.map((s) => s.baseMediaDecodeTime).filter((x): x is number => x !== undefined);
    const deltas = t.slice(1).map((v, i) => v - t[i]);
    const monotonic = deltas.every((d) => d > 0);
    console.log(
      `${name}: init=${r.initBytes}B  segments=${r.segments.length}  ` +
        `timescale=${r.timescale}  boxes=[${r.boxOrder.join(',')}]  ` +
        `decodeTimeMonotonic=${monotonic}  ` +
        `segDurations(ticks)=${[...new Set(deltas)].slice(0, 5).join('/')}`,
    );
  };
  console.log('');
  report('video', video);
  report('audio', audio);
  console.log(`\nwrote ${OUT}/manifest.mpd  (${Date.now() - t0}ms wall)`);
}

function videoIdBinding(innertube: Innertube): string {
  return innertube.session.context.client.visitorData || VIDEO_ID;
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e);
  process.exit(1);
});
