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

## Dependency handling

The connector needs a patched `googlevideo` (five VOD/seek fixes — see the
companion PR draft `googlevideo-sabr-vod-fixes.md`). Until those are upstream and
released, the built library is **vendored** at `vendor/googlevideo/` (MIT,
attribution and regeneration steps in its README) and mapped via `gv/` in
`deno.json`. Once upstream releases, swap the vendor for a normal
`jsr:@luanrt/googlevideo` pin and delete the directory.

## Session modes

Two ways to obtain a streaming session, in preference order:

1. **WEB + po_token** (`SABR_POT_URL` set). Full format list — every height and
   every dubbed audio track. **The GVS token must be bound to the video id, not
   to visitorData.** A visitorData-bound token is accepted and then rejected
   ~60s in with `streamProtectionStatus: 3` (token seen, judged invalid), which
   is indistinguishable from having no token until you read the status code.
   This one detail is what unlocked dubs and the ladder.
2. **ANDROID_VR, no token.** Exempt from attestation, needs no provider, but
   lists only the original audio track. Used automatically when no provider is
   configured or minting fails; the fallback is logged.

Any provider speaking the bgutil `POST /get_pot {content_binding}` shape works;
tested against `brainicism/bgutil-ytdlp-pot-provider`.

## Config

| env | default | meaning |
|---|---|---|
| `SABR_POT_URL` | *(unset)* | po_token provider; unset ⇒ ANDROID_VR fallback |
| `SABR_SEED_HEIGHT` | 360 | height indexed up front |
| `SABR_MAX_HEIGHT` | 1080 | ceiling on advertised renditions |
| `SABR_SEGMENT_WAIT_MS` | 30000 | how long a segment request waits |
| `SABR_RETAIN_SEGMENTS` | 12 | segments kept behind the playhead |
| `SABR_READER_IDLE_MS` | 45000 | idle reader abort |
| `SABR_SESSION_TTL_MS` | 4h | player-response reuse |

## Test evidence

- **Ladder + dubs**: `?audio=de,fr` on a 25-minute video yields
  `mode=web+pot, 6 renditions, 24 audio tracks`, a 6-rendition video
  AdaptationSet (144–1080) and German/French audio sets with labels.
- **Shared timeline is sound**: fragment boundaries are identical across
  heights (288 fragments, **0.0000s drift** 144p vs 720p). Verified end to end —
  a lazily-pulled 720p decodes clean at 1280×720 and its actual tfdt deltas
  (91091, 127127) match the manifest's `<S d=…>` exactly.
- **Lazy + progressive**: first 720p segment served **4.9s** after the first
  request for that rendition; `seg-200` served while the track was still
  filling.
- **Fallback**: with the provider unreachable the session drops to ANDROID_VR,
  logs why, and still serves the video.
- **Edge cases**: unknown rendition → 404, bad video id → 400, segment before
  manifest → 404. With `SERVER_VERIFY_REQUESTS=true`: unsigned/forged `check` →
  400; valid `check` → 200 and embedded in every segment URL.
- ffmpeg decodes served bytes cleanly (h264, full 1541.2s duration).

## Nothing is cached

Manifests are built from the `sidx` index carried in each track's init segment,
and segments come from short-lived readers positioned in a live SABR stream,
retaining a small window behind the playhead. Idle readers are aborted — so
abandoning playback stops the download rather than quietly fetching the rest of
the video.

The earlier design cached whole videos. Random access turned out to cost
**39–88ms**, so storing ~83MB per watched video to avoid it was never a good
trade, and it made the cache directory a watch history with the content
attached.

| | cached design | on demand |
|---|---|---|
| manifest, 25-min video | 36.6s (5.1s after sidx) | **0.25s** |
| seek | ~10ms (if cached) | **46–187ms** |
| sequential read | ~10ms | **11–47ms** |
| mid-playback bitrate switch | whole second track pulled | **523ms** |
| stored per watched video | up to ~83MB | **nothing** |

## Session choice is measured, not assumed

ANDROID_VR is preferred; WEB+pot is used only when a dubbed track is requested.
On the same video: indexing **69ms vs 4.1s**, seeks **27–115ms vs ~4s**. Paying
60× latency for dubs nobody asked for was the wrong default.

## Live and post-live DVR

Delegated to the companion's existing `/api/manifest/dash/id`.

This is pragmatic, not a protocol limit — worth stating plainly because it is
easy to conclude otherwise. **SABR does carry live**, and yt-dlp implements it:
~180 references to broadcast handling, with head tracking, end detection, deep
rewind, seekable-range and target-duration logic. `SabrStream`, the headless
downloader used here, has none of that and simply stalls (verified against a
live stream). Meanwhile YouTube publishes a native *dynamic* DASH manifest for
live (verified: 894KB, `type="dynamic"`, 8 representations) and the companion
route already serves it, including the fresh-token handling post-live DVR
needs. Reimplementing the subsystem would be substantial work to arrive back
where we already are.

Delegation triggers on the live flag **or** a missing `sidx`, so a post-live
recording that does carry an index is served here as ordinary VOD rather than
being excluded by its label.

## Whole-file download

`GET /sabr/:videoId/download?itag=` delegates to `/latest_version`, which
serves a progressive file through the videoplayback proxy with Range support —
the shape a podcast app fetching an RSS enclosure wants.

- `itag=140` (audio) **works**: HTTP 206, range honoured. This is the podcast
  case.
- `itag=18` (muxed video) redirects, but googlevideo answers **403**. Not yet
  diagnosed — the companion's player response comes from a TV client, which may
  not carry a usable muxed format. Open.

Muxing the separate SABR video and audio tracks here would need a real muxer,
which is why this delegates rather than assembling anything.

## Remaining limitations

- **Muxed video download 403s** (above). Audio-only downloads work.
- **No live via SABR** — delegated, see above.
- A **cold seek** costs 46–187ms versus ~10ms from a warm cache. Deliberate.

## Files

```
src/lib/sabr/session.ts      WEB+pot / ANDROID_VR sessions + track pulling
src/lib/sabr/reader.ts       sidx parsing, positioned readers, reader pool
src/routes/sabrRoutes.ts     manifest + segment routes, verifyRequest-gated
vendor/googlevideo/          patched MIT library, mapped via gv/ in deno.json
src/routes/index.ts          + app.route("/sabr", sabrRoutes)
deno.json                    + gv/ import map, + sabr-cache in --allow-write
```

## Question for maintainers before productionising

Is server-side SABR→DASH a direction invidious-companion wants to own, given the
project is moving toward client-side SABR (iv-org/invidious#5814)? If not, this
can live as a separate companion-adjacent service that depends on the same
session — the code is self-contained enough to lift out. Either way the
googlevideo fixes stand on their own and are worth upstreaming regardless.
