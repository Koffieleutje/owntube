/**
 * A small server that plays real YouTube videos in a browser over SABR→DASH.
 *
 * Routes:
 *   GET /                                  demo index
 *   GET /watch/:id[?audio=en,fr]           player page (dash.js)
 *   GET /v/:id/manifest.mpd                generated DASH manifest
 *   GET /v/:id/:track/init.mp4             init segment
 *   GET /v/:id/:track/seg-N.m4s            media segment
 *   GET /v/:id/captions/:lang.vtt          WebVTT
 *
 * Deliberately simple: on first manifest request a video is pulled and cut to
 * disk, then served statically. That trades a warm-up delay for free seeking,
 * which is the right shape at single-user scale — a 10-minute video indexes in
 * roughly 20s. Lazy per-segment serving needs a session cache and is a different
 * project; see docs/OWNTUBE-UPSTREAM-PLAN.md stage 7.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { segment, type SegmentResult } from './segmenter.js';
import { fetchCaptions, openSession, pullTrack, type Session } from './sabr.js';

const PORT = Number(process.env.PORT ?? 8899);
const CACHE = process.env.CACHE_DIR ?? 'cache';
const MAX_AUDIO_TRACKS = Number(process.env.MAX_AUDIO_TRACKS ?? 2);

interface TrackBuild {
  name: string;
  result: SegmentResult;
  mimeType: string;
  codecs: string;
  width?: number;
  height?: number;
  bandwidth: number;
  lang?: string;
  label?: string;
}

interface Prepared {
  session: Session;
  tracks: TrackBuild[];
  mpd: string;
}

const prepared = new Map<string, Promise<Prepared>>();

const parseCodec = (mime?: string) => ({
  base: (mime ?? '').split(';')[0],
  codecs: /codecs="?([^"]+)"?/.exec(mime ?? '')?.[1] ?? '',
});

/**
 * `SegmentTimeline`, not a fixed `duration`: SABR's video fragments are not
 * uniform (measured 3.4s–7.0s), so a single duration desynchronises playback.
 */
function timelineXml(r: SegmentResult, durationSec: number) {
  const ts = r.timescale ?? 1000;
  const starts = r.segments.map((s) => s.baseMediaDecodeTime ?? 0);
  const durations = starts.map((v, i) =>
    i < starts.length - 1 ? starts[i + 1] - v : Math.max(1, Math.round(durationSec * ts) - v),
  );
  const runs: { d: number; r: number }[] = [];
  for (const d of durations) {
    const last = runs[runs.length - 1];
    if (last && last.d === d) last.r++;
    else runs.push({ d, r: 0 });
  }
  return {
    ts,
    xml: runs.map((x) => `          <S d="${x.d}"${x.r ? ` r="${x.r}"` : ''}/>`).join('\n'),
  };
}

function buildMpd(session: Session, tracks: TrackBuild[]): string {
  const sets = tracks.map((t) => {
    const tl = timelineXml(t.result, session.durationSec);
    const isVideo = Boolean(t.width);
    const rep = isVideo
      ? `id="${t.name}" codecs="${t.codecs}" width="${t.width}" height="${t.height}" bandwidth="${t.bandwidth}"`
      : `id="${t.name}" codecs="${t.codecs}" audioSamplingRate="${tl.ts}" bandwidth="${t.bandwidth}"`;
    const langAttr = t.lang ? ` lang="${t.lang}"` : '';
    const label = t.label ? `\n      <Label>${t.label}</Label>` : '';
    return `    <AdaptationSet mimeType="${t.mimeType}"${langAttr} segmentAlignment="true" startWithSAP="1">${label}
      <SegmentTemplate timescale="${tl.ts}" startNumber="1"
                       initialization="${t.name}/init.mp4" media="${t.name}/seg-$Number$.m4s">
        <SegmentTimeline>
${tl.xml}
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation ${rep}/>
    </AdaptationSet>`;
  });

  return `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011"
     type="static" mediaPresentationDuration="PT${session.durationSec}S" minBufferTime="PT4S">
  <Period>
${sets.join('\n')}
  </Period>
</MPD>
`;
}

async function prepare(videoId: string, wantLangs: string[]): Promise<Prepared> {
  const session = await openSession(videoId);
  const dir = join(CACHE, videoId);
  mkdirSync(dir, { recursive: true });
  const tracks: TrackBuild[] = [];

  const log = (m: string) => console.log(`[${videoId}] ${m}`);
  log(`"${session.title}" ${session.durationSec}s — ${session.audioTracks.length} audio track(s), ${session.captions.length} caption track(s)`);

  // Video.
  {
    const t0 = Date.now();
    const { stream, format } = await pullTrack(session, { height: 360 });
    const result = await segment(stream, join(dir, 'video'));
    const c = parseCodec(format.mimeType);
    tracks.push({
      name: 'video',
      result,
      mimeType: c.base,
      codecs: c.codecs,
      width: format.width,
      height: format.height,
      bandwidth: Number(format.bitrate ?? 0),
    });
    log(`video ${format.height}p: ${result.segments.length} segments in ${Date.now() - t0}ms`);
  }

  // Audio: the requested languages, else the first N tracks.
  const chosen = wantLangs.length
    ? session.audioTracks.filter((a) =>
        wantLangs.some((l) => a.trackId === l || a.language === l),
      )
    : session.audioTracks.slice(0, MAX_AUDIO_TRACKS);

  for (const track of chosen.length ? chosen : session.audioTracks.slice(0, 1)) {
    const t0 = Date.now();
    const name = `audio-${track.trackId.replace(/[^\w.-]/g, '_')}`;
    const { stream, format } = await pullTrack(session, {
      height: null,
      audioTrackId: track.trackId,
    });
    const result = await segment(stream, join(dir, name));
    const c = parseCodec(format.mimeType);
    tracks.push({
      name,
      result,
      mimeType: c.base,
      codecs: c.codecs,
      bandwidth: Number(format.bitrate ?? 0),
      lang: track.language,
      label: track.label,
    });
    log(`audio ${track.trackId}: ${result.segments.length} segments in ${Date.now() - t0}ms`);
  }

  const mpd = buildMpd(session, tracks);
  writeFileSync(join(dir, 'manifest.mpd'), mpd);
  return { session, tracks, mpd };
}

function getPrepared(videoId: string, langs: string[]): Promise<Prepared> {
  const key = `${videoId}|${langs.join(',')}`;
  let p = prepared.get(key);
  if (!p) {
    p = prepare(videoId, langs).catch((e) => {
      prepared.delete(key);
      throw e;
    });
    prepared.set(key, p);
  }
  return p;
}

const VIDEO_ID = /^[\w-]{6,20}$/;
const TRACK = /^[\w.-]{1,40}$/;

function playerPage(videoId: string, p: Prepared, langs: string[]): string {
  const q = langs.length ? `?audio=${langs.join(',')}` : '';
  const tracks = p.session.captions
    .map(
      (c, i) =>
        `      <track kind="subtitles" srclang="${c.languageCode}" label="${c.name.replace(/"/g, '')}"
             src="/v/${videoId}/captions/${encodeURIComponent(c.languageCode)}.vtt"${i === 0 ? ' default' : ''}>`,
    )
    .join('\n');
  const audioList = p.tracks
    .filter((t) => !t.width)
    .map((t) => `<code>${t.lang ?? t.name}</code>`)
    .join(' ');

  return `<!doctype html>
<meta charset="utf-8">
<title>${p.session.title}</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 900px; padding: 0 1rem; }
  video { width: 100%; background: #000; border-radius: 8px; }
  .meta { color: #555; margin: .75rem 0; }
  code { background: #f3f3f3; padding: .1rem .35rem; border-radius: 3px; }
  #log { font: 12px ui-monospace, monospace; white-space: pre-wrap; background: #fafafa;
         border: 1px solid #eee; padding: .75rem; border-radius: 6px; max-height: 11rem; overflow: auto; }
</style>
<h1>${p.session.title}</h1>
<video id="v" controls></video>
<div class="meta">
  ${p.session.durationSec}s &middot; audio: ${audioList || 'default'} &middot;
  ${p.session.captions.length} caption track(s) &middot;
  <a href="/v/${videoId}/manifest.mpd">manifest</a>
</div>
<div id="log"></div>
<script src="/dash.all.min.js"></script>
<script>
  const log = (m) => { document.getElementById('log').textContent += m + '\\n'; };
  const video = document.getElementById('v');
  ${tracks ? `video.insertAdjacentHTML('beforeend', ${JSON.stringify(tracks)});` : ''}
  const player = dashjs.MediaPlayer().create();
  player.on('error', (e) => log('ERROR ' + JSON.stringify(e.error)));
  player.on('streamInitialized', () => {
    const a = player.getTracksFor('audio');
    log('streamInitialized; audio tracks: ' + a.length);
    a.forEach((t, i) => log('  [' + i + '] lang=' + t.lang + ' label=' + (t.labels?.[0]?.text ?? '-')));
  });
  player.on('playbackStarted', () => log('playbackStarted'));
  player.initialize(video, '/v/${videoId}/manifest.mpd', false);
</script>
`;
}

const DEMOS = [
  { id: 'dQw4w9WgXcQ', why: '6 caption tracks, single audio' },
  { id: '0e3GPea1Tyg', why: '17 caption tracks, 24 audio languages' },
];

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);
  const langs = (url.searchParams.get('audio') ?? '').split(',').filter(Boolean);
  const send = (code: number, type: string, body: any) => {
    res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*' });
    res.end(body);
  };

  try {
    if (url.pathname === '/') {
      return send(200, 'text/html; charset=utf-8',
        `<!doctype html><meta charset="utf-8"><title>SABR→DASH demo</title>
<style>body{font:15px/1.6 system-ui,sans-serif;margin:3rem auto;max-width:640px}</style>
<h1>SABR → DASH demo</h1><p>First load pulls and segments the video, so expect a short delay.</p><ul>` +
        DEMOS.map((d) => `<li><a href="/watch/${d.id}">${d.id}</a> — ${d.why}</li>`).join('') +
        `</ul><p>Any id works: <code>/watch/&lt;videoId&gt;?audio=en,fr</code></p>`);
    }

    if (url.pathname === '/dash.all.min.js') {
      return send(200, 'application/javascript',
        readFileSync('node_modules/dashjs/dist/modern/umd/dash.all.min.js'));
    }

    if (parts[0] === 'watch' && VIDEO_ID.test(parts[1] ?? '')) {
      const p = await getPrepared(parts[1], langs);
      return send(200, 'text/html; charset=utf-8', playerPage(parts[1], p, langs));
    }

    if (parts[0] === 'v' && VIDEO_ID.test(parts[1] ?? '')) {
      const videoId = parts[1];

      if (parts[2] === 'manifest.mpd') {
        const p = await getPrepared(videoId, langs);
        return send(200, 'application/dash+xml', p.mpd);
      }

      if (parts[2] === 'captions' && parts[3]?.endsWith('.vtt')) {
        const lang = decodeURIComponent(parts[3].slice(0, -4));
        const p = await getPrepared(videoId, langs);
        const track = p.session.captions.find((c) => c.languageCode === lang);
        if (!track) return send(404, 'text/plain', 'no such caption track');
        const file = join(CACHE, videoId, `captions-${lang.replace(/[^\w-]/g, '_')}.vtt`);
        // Never cache an empty body: a blocked fetch would otherwise poison the
        // cache and keep serving 0 bytes long after the cause is fixed.
        if (!existsSync(file) || readFileSync(file, 'utf8').trim() === '') {
          writeFileSync(file, await fetchCaptions(videoId, track));
        }
        return send(200, 'text/vtt; charset=utf-8', readFileSync(file));
      }

      if (TRACK.test(parts[2] ?? '') && parts[3]) {
        const file = join(CACHE, videoId, parts[2], parts[3]);
        if (!existsSync(file)) return send(404, 'text/plain', 'no such segment');
        res.writeHead(200, {
          'content-type': parts[3].endsWith('.mp4') ? 'video/mp4' : 'video/iso.segment',
          'access-control-allow-origin': '*',
        });
        return createReadStream(file).pipe(res);
      }
    }

    send(404, 'text/plain', 'not found');
  } catch (e: any) {
    console.error(e);
    send(500, 'text/plain', `error: ${e?.message ?? e}`);
  }
}).listen(PORT, () => console.log(`SABR→DASH demo on http://localhost:${PORT}`));
