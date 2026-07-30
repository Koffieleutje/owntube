# Draft PR — invidious-companion: SABR→DASH connector (proof of concept)

**Status:** draft / POC for review. Lives on branch `nedworks/sabr-poc` in the
local companion tree (`/usr/local/src/invidious-companion-sabr`), based on our
running `2026.07.29-dvrfix-captionfix` build.
**Not yet proposed to `iv-org/invidious-companion`** — this is a spike to decide
whether the approach is worth productionising.

---

## Title

`feat: SABR→DASH connector — serve DASH for SABR-only videos, server-side`

## What it does

Adds routes that serve ordinary DASH (manifest + init + numbered media segments)
for a video by pulling YouTube's SABR protocol server-side and cutting the
fragmented-MP4 stream on `moof` boundaries. Segmentation only — no re-muxing, no
transcode, no ffmpeg.

```
GET /sabr/:videoId/manifest.mpd[?check=]     DASH manifest
GET /sabr/:videoId/:track/:file[?check=]     init.mp4 / seg-N.m4s
```

The point: as YouTube moves formats to SABR-only, the companion's existing
`/api/manifest/dash` path (which relies on plain `adaptiveFormats` byte ranges)
loses coverage. This regains it without pushing SABR onto the clients — the TV
app in particular can't easily run a SABR player. Clients keep speaking DASH.

## Why it belongs in the companion specifically

The connector needs exactly what the companion already is: a long-lived,
authenticated youtubei.js session with a valid visitorData, behind the same
`SERVER_VERIFY_REQUESTS` boundary as every other companion route. It reuses the
session's visitorData and the existing `verifyRequest()` signing. Nothing new is
exposed to the public internet that wasn't already.

## How it works

1. **Session** (`src/lib/sabr/session.ts`). Fetches the player response with a
   **clean per-client `ANDROID_VR` call**, borrowing only the companion session's
   visitorData. This is load-bearing: a player response fetched through a blended
   youtubei.js session identity gets its streaming session classified as suspect
   and cut off after ~60s of media. One coherent client identity streams
   hour-long videos to completion, with no po_token (ANDROID_VR is exempt).
2. **Pull** (`SabrStream` from the vendored googlevideo). Video-only and each
   audio track pulled separately, format selectors pinning MP4 so the fMP4 can be
   segmented.
3. **Segment** (`src/lib/sabr/segmenter.ts`). Walks boxes, splits the header
   (`ftyp`+`moov`) as the init segment and each `moof`+`mdat` as a numbered media
   segment, into memory.
4. **Serve** (`src/routes/sabrRoutes.ts`). Builds a `SegmentTimeline` manifest
   (SABR fragments are non-uniform, 3.4–7.0s, so a fixed `duration` desyncs), and
   serves segments from an LRU in-memory cache. On first manifest request the
   video is pulled and cut (~15s warm-up for a 25-minute video at 360p) in
   exchange for free seeking.

## Test evidence (this branch, containerised)

- 25-minute video: manifest in 15s, **288 video + 155 audio** segments; the
  concatenated init + first segment is valid fMP4, and **ffmpeg decodes the
  served bytes cleanly** (h264 640×360, full 1541.2s duration, 0 warnings).
- Out-of-range segment → 404; invalid video id → 400.
- With `SERVER_VERIFY_REQUESTS=true`: unsigned and forged `check` → 400; a valid
  `check` → 200 and is embedded into every segment URL in the manifest; signed
  segment fetch → 200.

## Dependency handling

The connector needs a patched `googlevideo` (five VOD/seek fixes — see the
companion PR draft `googlevideo-sabr-vod-fixes.md`). Until those are upstream and
released, the built library is **vendored** at `vendor/googlevideo/` (MIT,
attribution and regeneration steps in its README) and mapped via `gv/` in
`deno.json`. Once upstream releases, swap the vendor for a normal
`jsr:@luanrt/googlevideo` pin and delete the directory.

## Config

All optional, sensible defaults:

| env | default | meaning |
|---|---|---|
| `SABR_VIDEO_HEIGHT` | 360 | video representation to build |
| `SABR_MAX_AUDIO_TRACKS` | 2 | audio tracks to build per video |
| `SABR_CACHE_VIDEOS` | 2 | prepared videos held in memory (LRU) |

## Known limitations (POC scope)

- **Single video quality.** One height per manifest; no quality ladder. DASH
  expects one, SABR picks per session — a real version advertises 2–3
  representations and opens a session per rung.
- **Original audio only.** The raw ANDROID_VR response lists only the original
  audio track; dubbed languages are unavailable on this path. Recovering them
  needs a different exempt client or an attested WEB session — untested.
- **Whole-video warm-up.** Pulls and cuts the entire video on first request
  rather than serving segments lazily. Fine at single-household scale; a public
  instance wants a streaming session cache keyed by (video, position).
- **Memory cache.** In-process, lost on restart. A persistent cache is a separate
  piece of work.
- **Captions** still route through the existing companion caption path (the
  `timedtext` base_url is IP-blocked); unchanged here.

## Files

```
src/lib/sabr/session.ts      clean per-client player call + track pulling
src/lib/sabr/segmenter.ts    fMP4 -> init + numbered segments (in memory)
src/routes/sabrRoutes.ts     manifest + segment routes, verifyRequest-gated
vendor/googlevideo/          patched MIT library, mapped via gv/ in deno.json
src/routes/index.ts          + app.route("/sabr", sabrRoutes)
deno.json                    + gv/ and @bufbuild/protobuf/wire import maps
```

## Question for maintainers before productionising

Is server-side SABR→DASH a direction invidious-companion wants to own, given the
project is moving toward client-side SABR (iv-org/invidious#5814)? If not, this
can live as a separate companion-adjacent service that depends on the same
session — the code is self-contained enough to lift out. Either way the
googlevideo fixes stand on their own and are worth upstreaming regardless.
