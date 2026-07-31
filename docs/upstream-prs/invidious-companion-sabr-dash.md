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

## Verified by an independent DASH client

Everything below was checked with **ffmpeg** against the connector over HTTP —
not with curl — so it exercises manifest parsing, `SegmentTimeline`, segment
addressing and decode the way a player does.

**VOD** (`dQw4w9WgXcQ`), what the client actually sees:

```
0,h264,video,256,144      6,aac,audio
1,h264,video,426,240      7..11,webvtt,subtitle   (5 caption tracks)
2,h264,video,640,360
3,h264,video,854,480
4,h264,video,1280,720
5,h264,video,1920,1080
```

- decodes 20s from the start, clean
- **seeks to 150s** and decodes 15s, clean — exercises the shared timeline and
  on-demand random access
- extracts a real frame at 180s (904KB PNG)

**Live**: 6 video rungs to 1080p plus 2 AAC tracks, decodes 15s clean, real
frame extracted (625KB).

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

## Live and post-live DVR — working, and deliberately not via SABR

Verified end to end against a live broadcast: all 8 media representations
return real media through the connector, and ffmpeg decodes both **1080p h264**
and **AAC audio** cleanly.

**SABR is the wrong tool here, and the reference players say so.** kira and
FreeTube both play live through `SabrStreamingAdapter`, which for a broadcast
skips the ABR request loop entirely and fetches the segment URLs the manifest
hands it (`SabrStreamingAdapter.ts`, the `source/yt_live_broadcast` branch).
Live is manifest-driven per-segment fetching, not an adaptive-bitrate stream.
An attempt to add a broadcast path to `SabrStream` got media flowing at the
protocol level but never into an output stream; it is preserved on the fork's
`live-sabr-wip` branch, and what it established is written up there.

So live proxies YouTube's own manifest instead. That manifest is already
exactly what a player needs — `type="dynamic"`, a `SegmentList` per
representation — and the only obstacle is that its `BaseURL`s are absolute
googlevideo addresses, IP-locked to this server. Each is rewritten to a local
path; the relative `<SegmentURL media="sq/…"/>` entries are left untouched
because DASH resolves them against it.

Two details that are easy to get wrong:

- The rewrite must be **path-style**. A query-style proxy URL is discarded by
  DASH's relative resolution, so the segment paths would not survive.
- The `check` parameter travels **in the path** for the same reason.

Live segments are self-initializing (`ftyp`+`moov`+`moof`+`mdat` each), so
there is no init-segment handling. The manifest is re-fetched every 20s, since
a live one advances and its URLs expire.

## Whole-file download

`GET /sabr/:videoId/download?itag=` delegates to `/latest_version`, which serves
a progressive file through the videoplayback proxy with Range support — the
shape a podcast app fetching an RSS enclosure wants.

- **`itag=140` (audio) works reliably**: HTTP 206, ranges honoured, including
  mid-file ranges for resumption. This is the podcast case.
- **`itag=18` (muxed video) is intermittent**: it returns 403 from googlevideo
  in bursts. This happens through the untouched `/latest_version` route too, so
  it is pre-existing companion behaviour rather than something this connector
  introduces. Resolving the format here from an *uncached* player response was
  tried — testing whether the rotating po_token explained it, as it does for the
  DVR fix — and made no difference, so that theory is wrong. Reverted rather
  than kept.
- A video with no muxed format returns 400; an unknown itag returns 404.

Muxing the separate SABR tracks here would need a real muxer, which is why this
delegates rather than assembling anything.

## Remaining limitations

- **Muxed video download is intermittent** (above); audio is reliable.
- A **cold seek** costs ~50ms rather than being instant from a cache. Deliberate.

## Files

```
src/lib/sabr/session.ts      WEB+pot / ANDROID_VR sessions + track pulling
src/lib/sabr/reader.ts       sidx parsing, positioned readers, reader pool
src/lib/sabr/live.ts         native dynamic manifest proxying for broadcasts
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
