/**
 * Session helpers shared by the CLI spike and the demo server.
 *
 * A "session" is the player response plus the deciphered SABR streaming URL and
 * ustreamer config. These must stay together: pairing a captured stream state
 * with a freshly created session fails with
 * `sabr.media_serving_enforcement_id_error`.
 */
import { JSDOM } from 'jsdom';
import { BG, type BgConfig } from 'bgutils-js';
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
  clientInfo: { clientName: number; clientVersion: string };
  captions: CaptionTrack[];
  audioTracks: AudioTrack[];
  /** Minted lazily — see README: not required from a residential IP. */
  poToken?: string;
  innertube: Innertube;
}

let cachedPoToken: { token: string; at: number } | null = null;

/** BotGuard attestation. Only called when the server actually objects. */
export async function mintPoToken(binding: string): Promise<string> {
  if (cachedPoToken && Date.now() - cachedPoToken.at < 10 * 60_000) return cachedPoToken.token;
  const dom = new JSDOM();
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const cfg: BgConfig = {
    fetch: (i: any, x?: RequestInit) => fetch(i, x),
    globalObj: globalThis,
    identifier: binding,
    requestKey: 'O43z0dpjhgX20SCx4KAo',
  };
  const challenge = await BG.Challenge.create(cfg);
  if (!challenge) throw new Error('no BotGuard challenge');
  new Function(challenge.interpreterJavascript.privateDoNotAccessOrElseSafeScriptWrappedValue!)();
  const res = await BG.PoToken.generate({
    program: challenge.program,
    globalName: challenge.globalName,
    bgConfig: cfg,
  });
  cachedPoToken = { token: res.poToken!, at: Date.now() };
  return res.poToken!;
}

export async function openSession(videoId: string, client = 'WEB'): Promise<Session> {
  const innertube = await Innertube.create({ cache: new UniversalCache(true) });
  const info: any = await innertube.getBasicInfo(videoId, client as any);

  // Attest up front. A default-track pull needs no po_token from a residential
  // IP, but selecting a *non-default* audio track (a dubbed language) makes the
  // server escalate `streamProtectionStatus` to 2 and stop sending media — and by
  // then the stream has already failed, too late to attach one reactively.
  // Attestation costs ~260ms and is cached process-wide, so pay it once.
  let poToken: string | undefined;
  try {
    poToken = await mintPoToken(innertube.session.context.client.visitorData || videoId);
  } catch {
    // Non-fatal: the default track still works without one.
  }

  const url = await innertube.session.player?.decipher(
    info.streaming_data?.server_abr_streaming_url,
  );
  const ustreamer =
    info.player_config?.media_common_config?.media_ustreamer_request_config
      ?.video_playback_ustreamer_config;
  if (!url || !ustreamer) throw new Error(`${videoId}: no SABR streaming url / ustreamer config`);

  const formats = (info.streaming_data?.adaptive_formats ?? []).map(buildSabrFormat);

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
    title: info.basic_info?.title ?? videoId,
    durationSec: info.basic_info?.duration ?? 0,
    formats,
    url,
    ustreamer,
    clientInfo: {
      clientName: parseInt(
        Constants.CLIENT_NAME_IDS[
          innertube.session.context.client.clientName as keyof typeof Constants.CLIENT_NAME_IDS
        ],
      ),
      clientVersion: innertube.session.context.client.clientVersion,
    },
    captions: (info.captions?.caption_tracks ?? []).map((c: any) => ({
      languageCode: c.language_code,
      name: c.name?.text ?? c.language_code,
      kind: c.kind,
      baseUrl: c.base_url,
    })),
    audioTracks: [...seen.values()],
    poToken,
    innertube,
  };
}

export interface PullSelection {
  /** Video height to pull, or null for audio-only. */
  height?: number | null;
  /** Audio track id, when pulling audio. */
  audioTrackId?: string;
  /** Seek position; needs the googlevideo-seek patch. */
  startAtMs?: number;
  /**
   * Low when restarting across stalls: the default of 10 costs ~60s of retries
   * before a stall is even reported, and a long video needs many restarts.
   */
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
    ...(session.poToken ? { poToken: session.poToken } : {}),
    clientInfo: session.clientInfo,
  });

  stream.on('streamProtectionStatusUpdate', async (status: any) => {
    // Attest only when told to, then let the caller retry.
    if ((status?.status ?? 0) >= 2 && !session.poToken) {
      session.poToken = await mintPoToken(session.videoId);
      stream.setPoToken(session.poToken);
    }
  });

  const isMp4 = (f: any) => (f.mimeType ?? '').includes('mp4');
  const audioFor = (fs: any[]) => {
    const audio = fs.filter((f) => isMp4(f) && !f.width);
    if (!sel.audioTrackId) return audio[0];
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
 * A single `SabrStream` does not survive a long video: on a 1541s video it
 * delivers ~12 segments, then the server stops sending media and the library
 * burns its ten retries and gives up. Stock googlevideo 4.1.1 behaves
 * identically, so this is not something the seek patch introduced — but the seek
 * patch is what lets us recover, because we can open a fresh session positioned
 * at the last segment we received.
 *
 * yt-dlp survives the same video (its suite has `test_vod_stall` and
 * `test_reload`), which is what suggested restart-on-stall rather than
 * retry-in-place.
 *
 * Yields fMP4 bytes as one continuous stream: the init segment from the first
 * pass only, then media from each pass in order.
 */
export async function pullTrackResilient(
  videoId: string,
  sel: PullSelection,
  opts: { maxRestarts?: number; onProgress?: (m: string) => void } = {},
): Promise<ReadableStream<Uint8Array>> {
  const maxRestarts = opts.maxRestarts ?? 12;
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
        const { stream } = await pullTrack(session, { ...sel, startAtMs, maxRetries: sel.maxRetries ?? 1 });

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
 * with **zero bytes** and `content-type: text/html`, and it does so regardless of
 * `fmt`, of an attached po_token, or of client. youtubei.js' `getTranscript()`
 * fails too. Measured on 2026-07-30 across vtt/srv3/json3 with and without a
 * token.
 *
 * This is the same block OwnTube already works around by routing captions
 * through invidious-companion, which holds a po_token — so rather than
 * re-solving it, delegate to that working endpoint. Set `CAPTIONS_PROXY` to an
 * OwnTube media origin; unset, this tries direct and will almost certainly get
 * an empty body.
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
