/**
 * Session helpers shared by the CLI spike and the demo server.
 *
 * A "session" is the player response plus the SABR streaming URL and ustreamer
 * config. These must stay together: pairing a captured stream state with a
 * freshly created session fails with `sabr.media_serving_enforcement_id_error`.
 *
 * The player response is fetched with a **clean per-client innertube call**, not
 * through a shared youtubei.js session. This is load-bearing, not style: a
 * player response obtained via `getBasicInfo(id, client)` carries the WEB
 * session it was created under, and the GVS classifies the resulting streaming
 * session as suspect — it serves ~60 seconds of media, then stops and demands
 * attestation. The same videos stream to completion when the player call
 * presents one coherent client identity. No po_token is involved either way;
 * ANDROID_VR is exempt (see the README's "Long videos: SOLVED").
 *
 * youtubei.js is still used for one thing: a throwaway bootstrap session to
 * obtain a visitorData, without which the player call answers LOGIN_REQUIRED.
 */
import { Innertube } from 'youtubei.js';
import { SabrStream } from 'googlevideo/sabr-stream';
import { buildSabrFormat, EnabledTrackTypes } from 'googlevideo/utils';

export interface CaptionTrack {
  languageCode: string;
  name: string;
  kind?: string;
  baseUrl: string;
}

export interface AudioTrack {
  /** YouTube's own id, e.g. "fr.3"; "default" when a video has one track. */
  trackId: string;
  language?: string;
  isDubbed?: boolean;
  label: string;
}

export interface Session {
  videoId: string;
  title: string;
  durationSec: number;
  formats: any[];
  url: string;
  ustreamer: string;
  clientInfo: Record<string, unknown>;
  userAgent: string;
  captions: CaptionTrack[];
  audioTracks: AudioTrack[];
}

/**
 * The one client this spike speaks as. Everything — the player call's context,
 * its user-agent header, and the ClientInfo echoed inside every SABR request —
 * comes from this single definition, because a session whose parts disagree
 * about who it is gets cut off after ~60s of media.
 */
const CLIENT = {
  name: 'ANDROID_VR',
  id: 28,
  version: '1.65.10',
  userAgent:
    'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
  context: {
    clientName: 'ANDROID_VR',
    clientVersion: '1.65.10',
    deviceMake: 'Oculus',
    deviceModel: 'Quest 3',
    androidSdkVersion: 32,
    osName: 'Android',
    osVersion: '12L',
    hl: 'en',
    gl: 'US',
  },
  clientInfo: {
    clientName: 28,
    clientVersion: '1.65.10',
    deviceMake: 'Oculus',
    deviceModel: 'Quest 3',
    osName: 'Android',
    osVersion: '12L',
    androidSdkVersion: 32,
  },
};

/**
 * visitorData from a throwaway session, cached process-wide. Only the id itself
 * is reused — the player call below shares nothing else with the session that
 * produced it.
 */
let cachedVisitorData: string | null = null;
async function getVisitorData(): Promise<string> {
  if (cachedVisitorData) return cachedVisitorData;
  const bootstrap = await Innertube.create({ retrieve_player: false });
  const vd = bootstrap.session.context.client.visitorData;
  if (!vd) throw new Error('no visitorData from bootstrap session');
  cachedVisitorData = vd;
  return vd;
}

export async function openSession(videoId: string): Promise<Session> {
  const visitorData = await getVisitorData();

  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': CLIENT.userAgent,
      'x-youtube-client-name': String(CLIENT.id),
      'x-youtube-client-version': CLIENT.version,
      'x-goog-visitor-id': visitorData,
    },
    body: JSON.stringify({
      context: { client: { ...CLIENT.context, visitorData } },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });
  const player: any = await res.json();

  const status = player?.playabilityStatus?.status;
  if (status !== 'OK') {
    throw new Error(`${videoId}: playability ${status}: ${player?.playabilityStatus?.reason ?? ''}`);
  }

  // ANDROID_VR streaming URLs need no deciphering (no JS player involved).
  const url = player?.streamingData?.serverAbrStreamingUrl;
  const ustreamer =
    player?.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig
      ?.videoPlaybackUstreamerConfig;
  if (!url || !ustreamer) throw new Error(`${videoId}: no SABR streaming url / ustreamer config`);

  // buildSabrFormat reads the raw camelCase player JSON directly; only drc and
  // the audio-track id need aliasing to its snake_case fallbacks.
  const formats = (player.streamingData.adaptiveFormats ?? []).map((f: any) =>
    buildSabrFormat({
      ...f,
      is_drc: f.isDrc,
      audio_track: f.audioTrack
        ? { id: f.audioTrack.id, audio_is_default: f.audioTrack.audioIsDefault }
        : undefined,
    } as any),
  );

  // One entry per distinct audio track, keyed the way YouTube keys them.
  const seen = new Map<string, AudioTrack>();
  for (const f of formats.filter((x: any) => !x.width)) {
    const trackId = f.audioTrackId ?? f.language ?? 'default';
    if (seen.has(trackId)) continue;
    const lang = f.language ?? trackId.split('.')[0];
    seen.set(trackId, {
      trackId,
      language: lang,
      isDubbed: f.isDubbed,
      label: f.isDubbed ? `${lang} (dubbed)` : lang,
    });
  }

  return {
    videoId,
    title: player?.videoDetails?.title ?? videoId,
    durationSec: parseInt(player?.videoDetails?.lengthSeconds ?? '0'),
    formats,
    url,
    ustreamer,
    clientInfo: CLIENT.clientInfo,
    userAgent: CLIENT.userAgent,
    captions: (
      player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
    ).map((c: any) => ({
      languageCode: c.languageCode,
      name: c.name?.simpleText ?? c.name?.runs?.[0]?.text ?? c.languageCode,
      kind: c.kind,
      baseUrl: c.baseUrl,
    })),
    audioTracks: [...seen.values()],
  };
}

export interface PullSelection {
  /** Video height to pull, or null for audio-only. */
  height?: number | null;
  /** Audio track id, when pulling audio. */
  audioTrackId?: string;
  /** Seek position; needs the googlevideo patch. */
  startAtMs?: number;
  maxRetries?: number;
}

/**
 * Pull one track as a stream of fMP4 bytes.
 *
 * `enabledTrackTypes` narrows what the server sends, but the *format selectors*
 * are what actually pin the container — preference flags alone will still hand
 * back WebM/Opus, which cannot be cut into fMP4 segments.
 */
export async function pullTrack(
  session: Session,
  sel: PullSelection,
): Promise<{ stream: ReadableStream<Uint8Array>; format: any; abort: () => void }> {
  const stream = new SabrStream({
    formats: session.formats,
    serverAbrStreamingUrl: session.url,
    videoPlaybackUstreamerConfig: session.ustreamer,
    clientInfo: session.clientInfo as any,
    // Node's fetch announces itself as "node"; present the client we claim to be.
    fetch: (input: any, init?: any) =>
      fetch(input, {
        ...init,
        headers: { ...(init?.headers ?? {}), 'user-agent': session.userAgent },
      }),
  });

  const isMp4 = (f: any) => (f.mimeType ?? '').includes('mp4');
  const audioFor = (fs: any[]) => {
    const audio = fs.filter((f) => isMp4(f) && !f.width);
    if (!sel.audioTrackId) {
      // The default track, explicitly: taking the first entry picks whichever
      // dub the server lists first.
      return audio.find((f) => !f.isDubbed && !f.isDrc) ?? audio.find((f) => !f.isDubbed) ?? audio[0];
    }
    return (
      audio.find((f) => (f.audioTrackId ?? f.language ?? 'default') === sel.audioTrackId) ?? audio[0]
    );
  };
  const videoFor = (fs: any[]) => {
    const video = fs.filter((f) => isMp4(f) && f.width);
    if (!sel.height) return video[0];
    return video.find((f) => f.height === sel.height) ?? video[0];
  };

  const wantVideo = sel.height !== null;
  const res = await stream.start({
    videoFormat: videoFor,
    audioFormat: audioFor,
    enabledTrackTypes: wantVideo ? EnabledTrackTypes.VIDEO_ONLY : EnabledTrackTypes.AUDIO_ONLY,
    ...(sel.startAtMs ? { startAtMs: sel.startAtMs } : {}),
    ...(sel.maxRetries !== undefined ? { maxRetries: sel.maxRetries } : {}),
  } as any);

  return {
    stream: (wantVideo ? res.videoStream : res.audioStream) as ReadableStream<Uint8Array>,
    format: wantVideo ? res.selectedFormats.videoFormat : res.selectedFormats.audioFormat,
    abort: () => {
      try {
        stream.abort();
      } catch {
        /* already stopped */
      }
    },
  };
}

/**
 * Pull a whole track, restarting across stalls.
 *
 * With the session fix a single pass normally completes even on hour-long
 * videos, so this is a safety net rather than the workhorse it used to be: a
 * transient stall (yt-dlp hits them on occasion too) costs one restart instead
 * of the whole pull, because the seek patch lets a fresh session open at the
 * last segment received.
 *
 * Yields fMP4 bytes as one continuous stream: the init segment from the first
 * pass only, then media from each pass in order.
 */
export async function pullTrackResilient(
  videoId: string,
  sel: PullSelection,
  opts: { maxRestarts?: number; onProgress?: (m: string) => void } = {},
): Promise<ReadableStream<Uint8Array>> {
  const maxRestarts = opts.maxRestarts ?? 3;
  const log = opts.onProgress ?? (() => {});

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let startAtMs = 0;
      let sentInit = false;
      let lastDecodeSec = 0;
      let durationSec = 0;

      for (let attempt = 0; attempt <= maxRestarts; attempt++) {
        const session = await openSession(videoId);
        durationSec = session.durationSec;
        const { stream } = await pullTrack(session, { ...sel, startAtMs, maxRetries: sel.maxRetries ?? 3 });

        let buf = Buffer.alloc(0);
        let inInit = !sentInit;
        let timescale = 0;
        let got = 0;
        const reader = stream.getReader();

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf = Buffer.concat([buf, Buffer.from(value)]);

            // Emit whole boxes, dropping the init segment on restarts (the
            // server does not resend it, but a partial buffer might straddle it).
            let off = 0;
            for (;;) {
              if (off + 8 > buf.length) break;
              const size = buf.readUInt32BE(off);
              const type = buf.subarray(off + 4, off + 8).toString('latin1');
              if (!/^[a-zA-Z0-9]{4}$/.test(type) || size < 8 || off + size > buf.length) break;
              const raw = buf.subarray(off, off + size);

              if (type === 'moov') {
                const i = raw.indexOf('mvhd', 0, 'latin1');
                if (i >= 0) {
                  const v = raw.readUInt8(i + 4);
                  timescale = raw.readUInt32BE(i + 4 + 4 + (v === 1 ? 16 : 8));
                }
              }
              if (type === 'moof') {
                inInit = false;
                got++;
                const i = raw.indexOf('tfdt', 0, 'latin1');
                if (i >= 0 && timescale) {
                  const v = raw.readUInt8(i + 4);
                  const t = v === 1 ? Number(raw.readBigUInt64BE(i + 8)) : raw.readUInt32BE(i + 8);
                  lastDecodeSec = t / timescale;
                }
              }

              const isInitBox = type === 'ftyp' || type === 'moov' || type === 'sidx';
              if (!isInitBox || !sentInit) controller.enqueue(new Uint8Array(raw));
              off += size;
            }
            if (off > 0) buf = buf.subarray(off);
          }
          sentInit = true;
          log(`pass ${attempt + 1}: +${got} segments, reached ${lastDecodeSec.toFixed(0)}s/${durationSec}s`);
        } catch (e: any) {
          sentInit = sentInit || !inInit;
          log(`pass ${attempt + 1}: stalled at ${lastDecodeSec.toFixed(0)}s/${durationSec}s after ${got} segments`);
        }

        // Done when we are within a segment of the end, or made no progress.
        if (lastDecodeSec >= durationSec - 12) break;
        if (got === 0) {
          log(`pass ${attempt + 1}: no progress, giving up at ${lastDecodeSec.toFixed(0)}s`);
          break;
        }
        // Resume just past the last segment we actually received.
        startAtMs = Math.round((lastDecodeSec + 0.5) * 1000);
      }

      controller.close();
    },
  });
}

/**
 * Captions cannot be fetched directly from a plain server.
 *
 * Google IP-blocks the `timedtext` `base_url`: every request returns HTTP 200
 * with **zero bytes** and `content-type: text/html`, regardless of `fmt` or
 * client. Measured on 2026-07-30 across vtt/srv3/json3.
 *
 * This is the same block OwnTube already works around by routing captions
 * through invidious-companion — so rather than re-solving it, delegate to that
 * working endpoint. Set `CAPTIONS_PROXY` to an OwnTube media origin; unset,
 * this tries direct and will almost certainly get an empty body.
 *
 * Worth noting for the plan: it means captions are a reason the companion cannot
 * simply be dropped.
 */
export async function fetchCaptions(videoId: string, track: CaptionTrack): Promise<string> {
  const proxy = process.env.CAPTIONS_PROXY;
  if (proxy) {
    const url = new URL(`/captions/${encodeURIComponent(videoId)}`, proxy);
    url.searchParams.set('label', track.name);
    const res = await fetch(url.toString());
    const body = await res.text();
    if (res.ok && body.trim()) return body;
    throw new Error(`captions ${track.languageCode}: proxy HTTP ${res.status}, ${body.length}b`);
  }

  const url = new URL(track.baseUrl);
  url.searchParams.set('fmt', 'vtt');
  const res = await fetch(url.toString());
  const body = await res.text();
  if (!body.trim()) {
    throw new Error(
      `captions ${track.languageCode}: empty body (Google IP-block). Set CAPTIONS_PROXY.`,
    );
  }
  return body;
}
