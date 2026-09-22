# Live and post-live DVR playback

How OwnTube plays live broadcasts and ended-but-not-yet-VOD streams, why each
piece is shaped the way it is, and how to test, debug, deploy and roll back.
Written 2026-09-21, when this started working end to end.

## Summary

| stream state | Invidious says | OwnTube route | source of segments |
|---|---|---|---|
| **live** | `liveNow: true` | `/dash/<id>/live.mpd` + `/dash/<id>/live/<rep>/…` | companion `/sabr` (YouTube's own live manifest, ANDROID_VR session) |
| **post-live DVR** (ended, not yet converted) | `isPostLiveDvr: true` | `/dash/<id>/manifest.mpd` (falls back) + `/dvr/<id>/<rep>/<sq>` | companion `/api/manifest/dash` (YouTube.js SegmentTemplate) |
| VOD | — | `/hls`, `/dash/<id>/manifest.mpd` (synthesized) | companion `/videoplayback` |

Both live paths depend on invidious-companion. OwnTube never calls YouTube's
InnerTube API itself: that stays behind the companion (see
`INVIDIOUS-BOUNDARY-PLAN.md`). The companion build we run carries our own
patches; see `PATCHES.md` in the companion repo.

## Live: what doesn't work, and what does

Probed from the server's IP; don't re-try these without a reason to think
YouTube changed:

- **Invidious `hlsUrl`**: sometimes present for a live stream (it depends on
  which YouTube client the companion fell back to), but its segments 403 when
  fetched from the server.
- **Companion `/api/manifest/dash` for live**: 200 with an empty
  `<Period/>` and `mediaPresentationDuration="PTNaNS"`. Live formats have no
  byte ranges, so there is nothing to build from.
- **WEB-client live format URLs** (`c=WEB`, `rqh=1`, `sefc=1`): 403 on every
  path. YouTube wants SABR for these.
- **iOS client**: no manifests at all; its plain format URLs carry no PO token
  and work for ~30–45 s, then 403 for good.
- **TV / ANDROID_VR without a visitorData**: "Sign in to confirm you're not a
  bot".
- **ANDROID_VR + visitorData, HLS**: manifest yes, segments 403.
- **ANDROID_VR + visitorData, DASH: works.** `dashManifestUrl` is a
  `type="dynamic"` manifest, 4 h rewind window, H.264 + AAC to 1080p60, and
  its segments (`<BaseURL>sq/<N>/lmt/1`) keep serving.

The companion's `/sabr/<id>/manifest.mpd` (`src/lib/sabr/live.ts`) fetches that
manifest from an ANDROID_VR session and rewrites each `<BaseURL>` to
`live/<check>/<index>/` on the companion, whose
`/sabr/<id>/live/<check>/<rep>/*` route proxies to the IP-locked googlevideo
address.

## Live: the OwnTube side

`apps/web/src/server/services/dash/live-manifest.ts` fetches the companion's
manifest (signed with `check=`, 2 s coalescing cache) and reshapes it before
dash.js sees it. Each transform fixes something that on its own stopped
playback:

1. **BaseURLs → `/dash/<id>/live/<index>/`.** The browser only ever talks to
   our media origin, like `/dvr`. Root-relative, so the relative
   `sq/N/lmt/1` segment paths resolve beneath it.
2. **`SegmentList` → `SegmentTemplate media="sq/$Number$/lmt/1"`.** dash.js's
   SegmentList support ignores the `SegmentTimeline`: it maps time to segment
   by `startNumber` and a fixed duration, and YouTube's per-Representation
   lists carry no `startNumber`. It fetched from the oldest segment while the
   playhead sat at the live edge. The template goes through dash.js's normal
   live path, and the manifest shrinks from ~1.1 MB to ~4 KB.
3. **Timeline anchoring.** YouTube's manifest is a sliding window re-anchored
   on every fetch: `Period@start` and `presentationTimeOffset` both equal the
   oldest segment's time and the first `<S>` has no `t`. YouTube means that
   timeline to start at `presentationTimeOffset` (a segment's `tfdt` is exactly
   `sq × 5 s`); dash.js starts an untimed timeline at 0, which put every segment
   hours before its media. We rebase to `Period@start=0`,
   `presentationTimeOffset=0` with an explicit first `t`, so presentation time
   equals media time and stays stable while the window slides.
4. **An explicit init segment.** Without `initialization`, dash.js requests the
   BaseURL itself, which googlevideo answers with a whole media segment. The
   template names `init`, served by `/dash/<id>/live/<rep>/init` as the
   `ftyp`+`moov` of the newest segment (live segments are self-initializing),
   cached per representation for 10 min.

If the manifest doesn't have the expected shape, `segmentListToTemplate`
returns null and the route answers 502 rather than serve something dash.js will
mis-play.

Segments: `/dash/<id>/live/<rep>/sq/<n>/lmt/<n>` → companion. The companion
only serves segments for a manifest it currently holds, so a 404 (e.g. after a
companion restart) re-fetches the manifest and retries once.

Player side:

- `buildWatchPlayback` (`lib/pick-playback.ts`) always returns `dash-live` for
  `isLive`, even when Invidious offers an `hlsUrl`.
- The payload stays `mode: "hls"` with the `.mpd` as `src`;
  `video-player.tsx` sends a live manifest (`isLiveDashManifestUrl`) to
  `LiveBlock`, which runs dash.js with a quality menu.
- `useDashPlayback` turns off two VOD tricks when the source is the live
  manifest: fast switching and the cheap-rung fast seek. Both *replace*
  buffered media; on live they knocked out the segment under the playhead at
  startup, dash.js moved on without re-fetching it, and playback never began.
- With no resume point the hook passes `NaN`, not `0`, as the start time. For a
  dynamic manifest `0` means the oldest listed segment.

## Post-live DVR

An ended broadcast that YouTube hasn't converted to VOD yet has no
byte-range-indexed formats, so `/hls` and the synthesized `/dash` can't be
built. `/dash/<id>/manifest.mpd` then falls back to the companion's own
`/api/manifest/dash` (a static SegmentTemplate manifest built by YouTube.js)
and rewrites its segment URLs to `/dvr/<id>/<rep>/<sq>`
(`server/services/dash/dvr-manifest.ts`). `/dvr` resolves the current upstream
URL per request from a 60 s cache of that manifest, and re-fetches it on a 403,
since the po_token in those URLs ages out.

This needs our companion patches: `*.c.youtube.com` segment hosts, forwarding
the `X-Head-*` headers YouTube.js reads for the segment count, and an uncached
player response for live/DVR.

## Configuration

| where | setting | why |
|---|---|---|
| OwnTube | `INVIDIOUS_COMPANION_SECRET_KEY` | signs `check=`; must equal the companion's `SERVER_SECRET_KEY` (16 chars). Without it every companion request 400s. |
| OwnTube | `INVIDIOUS_COMPANION_INTERNAL_URL` | optional; server-side companion fetches skip the public hop. Falls back to `INVIDIOUS_PUBLIC_BASE_URL`. |
| companion | `SERVER_VERIFY_REQUESTS=true` | guards `/sabr`, `/api/manifest/dash`, captions with `check=` |
| companion | `SABR_LIVE_MANIFEST_TTL_MS=5000` | how often it re-fetches YouTube's live manifest. The 20 s default holds the live edge back: dash.js only plays segments the manifest lists. |

The dev container reads `.env` at creation. A container created before a key
was added to `.env` doesn't have it; recreate it (`docker compose -f
docker-compose.dev.yml up -d`), a `restart-dev` isn't enough.

## Testing

Unit and route tests: `live-manifest.test.ts`, `app/dash/live-route.test.ts`,
`dvr-manifest.test.ts`, `pick-playback.test.ts`.

**A live video**: anything with `liveNow: true` in
`/api/v1/videos/<id>`. Check the chain:

```bash
M=https://owntube-media.home.nedworks.org   # or owntube-dev-media
curl -s $M/dash/<id>/live.mpd | head -c 600        # SegmentTemplate, Period start PT0S
curl -s -o seg $M/dash/<id>/live/1/sq/<n>/lmt/1    # then read its tfdt: must be n × 5 s
```

**A DVR video** only exists for a few hours after a stream ends. To find one:
list channels that are live now (Invidious
`/api/v1/search?q=live&type=video&features=live`), take the recently ended
entries of their `/api/v1/channels/<ucid>/streams` ("… hours ago"), and check
each for `isPostLiveDvr: true` in `/api/v1/videos/<id>`. Long sports and news
streams are the likeliest.

**In a browser** (Playwright's Chromium decodes H.264/AAC): open the watch page,
click the centre of the player (headless Chromium blocks unmuted autoplay), and
sample `currentTime`, `readyState`, `buffered` and
`getVideoPlaybackQuality().totalVideoFrames`. Healthy live: `readyState` 4,
`currentTime` advancing 5 s per 5 s, buffer ahead of the playhead.

## Debugging notes

What found the bugs above, in order of usefulness:

- **Check a segment's `tfdt` against the requested `sq`.** A companion bug
  returned the newest segment for *every* request (a decoded `check` compared
  against the encoded path left the segment path empty); two different `sq`
  returning the same bytes gave it away immediately.
- **Instrument MSE on the real page** with Playwright `addInitScript`: wrap
  `MediaSource.addSourceBuffer`, `SourceBuffer.appendBuffer`/`remove` and log
  `buffered` on `updateend`. Shows exactly what lands in the buffer and when.
- **A standalone harness** (a tiny server that serves the manifest through the
  real transform functions, plus dash.js from `node_modules`) separates manifest
  problems from app/player problems. It played long before the watch page did,
  which pointed at the hook, not the manifest.
- A `check` of `-` (no signature) hides bugs that only a percent-encoded real
  signature triggers. Test with the real key.

## Deploy and roll back

Prod OwnTube builds from the working tree (`/var/data/config/owntube`,
`docker compose build owntube && docker compose up -d owntube`); dev
hot-reloads from the same checkout. Before a prod build, tag the running image
for rollback, e.g. `docker tag owntube-owntube:latest
owntube-owntube:pre-<change>-<date>`.

The companion runs from `/var/data/config/invidious/docker-compose.yml`; its
image, rollback tags and build procedure are in the companion repo's
`PATCHES.md`. Swapping it affects prod Invidious and both OwnTubes: run the
smoke checks (VOD manifest, captions, `/videoplayback` range, `/sabr` live
manifest and segments) before and after.
