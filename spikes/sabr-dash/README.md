# SABR → DASH spike

A throwaway proof that a headless server can pull YouTube's SABR protocol and
re-serve it as ordinary DASH. Not production code, not wired to OwnTube, not
built by CI. It exists to answer questions that were otherwise guesses in
`docs/OWNTUBE-UPSTREAM-PLAN.md` stage 7.

```bash
pnpm install
pnpm exec tsx main.ts dQw4w9WgXcQ        # pull + segment + write dash-out/manifest.mpd
pnpm exec tsx verify-timeline.ts         # check the manifest against the media
pnpm exec tsx resilience-test.ts         # repeat / concurrency / watchdog
pnpm exec tsx resume-test.ts             # snapshot + resume a session
pnpm exec tsx seek-fork-test.ts          # seek, needs googlevideo-seek.patch applied
pnpm exec tsx seek-test.ts               # earlier failed attempts, kept as evidence
pnpm exec tsx probe.ts                   # which Innertube clients expose SABR
```

Node 20 + pnpm 9. `pnpm install` pulls `googlevideo`, `youtubei.js`,
`bgutils-js`, `jsdom` — all MIT, so nothing here constrains OwnTube's licence.

## Demo server

`server.ts` plays real videos in a browser over SABR→DASH, with captions and
multi-track audio.

```bash
CAPTIONS_PROXY=https://owntube-media.home.nedworks.org pnpm exec tsx server.ts
# then open http://localhost:8899/watch/dQw4w9WgXcQ
```

| route | |
|---|---|
| `/watch/:id[?audio=en,fr]` | dash.js player page with caption `<track>`s |
| `/v/:id/manifest.mpd` | generated manifest (one AdaptationSet per track) |
| `/v/:id/:track/{init.mp4,seg-N.m4s}` | segments |
| `/v/:id/captions/:lang.vtt` | WebVTT |

Verified end to end on `dQw4w9WgXcQ` (213s): manifest built in ~10s (38 video + 22 audio
segments), **ffmpeg decodes the served HTTP manifest to 5,326 frames / 213.04s
with zero warnings**, and captions return real VTT (en 4,263 B, de-DE 3,781 B).

On first request a video is pulled and cut to disk, then served statically —
trading a warm-up delay for free seeking.

### Captions need the companion

Google IP-blocks the `timedtext` `base_url`: HTTP **200 with zero bytes** and
`content-type: text/html`, regardless of `fmt` (vtt/srv3/json3), with or without
a po_token, on every client. `getTranscript()` fails too. So `CAPTIONS_PROXY`
delegates to OwnTube's existing `/captions` route, which works because it goes
through invidious-companion.

**Captions are therefore a reason the companion cannot simply be dropped.**

### Long videos: SOLVED

Every video that stalled now downloads completely, verified in one session:

| video | duration | before | after |
|---|---|---|---|
| `0e3GPea1Tyg` | 1541s | 12 fragments, "attestation required" | **288/288, 6s** |
| `Li8SgZcbSOI` | 1484s | 14 fragments | **288/288, 7s** |
| `Y07j3hXAI-g` | 3116s | 12 fragments | **609/609, 19s** |
| `dQw4w9WgXcQ` | 213s | worked | still works |

No po_token involved. Three causes stacked on top of each other, found by
decoding our own request bytes with yt-dlp's proto classes and diffing against
its successful request at the same playback position:

1. **Player-response provenance — the big one.** youtubei.js's
   `getBasicInfo(id, 'ANDROID_VR')` carries its WEB session into the call, and
   the GVS classifies the resulting streaming session as suspect: it serves
   ~60s of media, sends a `SabrContextUpdate` (which it never sends yt-dlp),
   then stops serving and demands attestation. A hand-rolled `/youtubei/v1/player`
   call with a pure ANDROID_VR context — borrowing only the visitorData, which
   is required (`LOGIN_REQUIRED` without it) — streams freely. See
   `raw-vr-test.ts`.
2. **`EnabledTrackTypes.VIDEO_ONLY` sends 2 on the wire, a value SABR does not
   have.** The protocol knows audio+video (0) and audio-only (1); yt-dlp
   expresses video-only as 0 with the audio track discarded client-side:
   selected so the server initializes it, advertised as fully buffered
   (0..MAX, the server's *own* chosen format id — it may initialize a different
   format than selected, observed 140 -> 251), never named in
   `preferredAudioFormatIds`.
3. **Media-header times were read from the wrong field.** Raw player responses
   send `startMs`/`durationMs` as literal zeroes with the real values only in
   `timeRange` ticks. Trusting the zeroes records every segment as zero-length,
   so the client re-requests position 0 until the server gives up. `timeRange`
   is authoritative when present; init segments are skipped entirely.

All three fixes are in `googlevideo-seek.patch` (which is now a misnomer — it
carries the seek fix, the cumulative `bufferedRanges` fix, the timescale fix,
and these). Regression: 213s conversion 0 timeline mismatches, seek works at
30/60/120/180s, the youtubei.js path still completes on short videos.

**Consequences for the converter design:**

- The player response must be fetched with a clean per-client context, not
  through a shared youtubei.js session. (An attested WEB session may also work —
  untested — but the raw ANDROID_VR call needs no BotGuard at all.)
- No po_token machinery is required for VOD via ANDROID_VR.
- The `minter.ts` / bgutil / companion-token investigations below are therefore
  **background, not blockers**. Kept for when YouTube tightens ANDROID_VR.

## What it proves

**Conversion works, and it is segmentation rather than transcoding.** SABR
delivers `ftyp`+`moov` then repeating `moof`+`mdat`, which *is* DASH's
init-plus-media model. `segmenter.ts` is ~130 lines of box walking. No ffmpeg —
ffmpeg is not even installed on the host this ran on.

**Non-uniform fragments are a non-issue.** Video fragments are irregular (29
distinct durations across 38 fragments; audio has 2). `SegmentTimeline` handles
it, and `verify-timeline.ts` proves the manifest agrees with the media:

```
video: 38 segments checked, 0 mismatches | distinct durations=29 (NON-UNIFORM) | total=213.00s
audio: 22 segments checked, 0 mismatches | distinct durations=2  (NON-UNIFORM) | total=213.00s
TIMELINE EXACT: every segment start matches its media decode time
```

**Cross-validated against an independent implementation.** Against yt-dlp's SABR
branch (Python, PR #13515) on the same video and formats:

| | result |
|---|---|
| init segments (video 1229 B, audio 1019 B) | **byte-identical** |
| media bytes | **byte-identical** over the full extent yt-dlp downloaded |
| segment counts | **38 video / 22 audio** — matches its `frag 38/38`, `22/22` |

**Cost is low.** ~7 s wall for a 213 s video (~30× realtime). Earlier yt-dlp
measurement on the same host: 3.03 CPU-seconds for 213 s of video, ≈1.4% of one
core at realtime. The Invidious maintainer's "requires a beefier server" concern
is calibrated for public instances; at single-user scale it does not bite.

**Resilience held up.** 6/6 sequential pulls with no retry, 6/6 with retry (none
needed), 4/4 concurrent in 6.4 s at 239 MB RSS, and the watchdog aborts cleanly
on an impossible stall budget.

## Playback — verified with a real DASH client

The output is not merely well-formed; ffmpeg's DASH demuxer consumes it and
decodes every frame.

```
$ ffprobe manifest.mpd
format_name=dash   duration=213.000000   nb_streams=2
  h264  640x360  25/1
  aac   44100Hz  2ch

$ ffmpeg -i manifest.mpd -f null -
frame= 5326 ... time=00:03:33.04     # zero warnings at -v warning
```

| check | result |
|---|---|
| full decode | **5,326 video frames, 0 warnings**, 213.04s |
| audio decode | **9,177 AAC frames** = 213.06s — A/V agree within 0.02s |
| seek to 120s, decode 5s | clean, no warnings — exercises the non-uniform `SegmentTimeline` |
| extract a frame at 150s | a real 203 KB PNG of actual video content |

Caveat worth stating: ffmpeg's DASH demuxer is *a* DASH client, not *the* one you
ship to. dash.js, Shaka and ExoPlayer each have their own strictness, so this
does not guarantee browser or TV playback. But it is an independent
implementation reading the manifest, fetching init + segments, and decoding —
which is a far stronger claim than the structural validation that preceded it.

Reproduce with `apt-get install ffmpeg`, then run ffprobe/ffmpeg **from inside**
`dash-out/` — relative segment URLs resolve against the working directory.

## Seeking — solved, via a two-line fix to googlevideo

`googlevideo-seek.patch` adds a `startAtMs` option to `SabrStream` and makes
seeking work headlessly:

```
baseline (no startAtMs)   -> first segment at   0.0s
startAtMs= 30000 ( 30s)   -> first segment at  24.6s  SEEK WORKS
startAtMs= 60000 ( 60s)   -> first segment at  55.4s  SEEK WORKS
startAtMs=120000 (120s)   -> first segment at 114.7s  SEEK WORKS
startAtMs=180000 (180s)   -> first segment at 178.9s  SEEK WORKS
```

Landing slightly *before* each target is correct — the server returns the segment
containing the seek point so a decoder can start from the preceding keyframe.

### The actual bug

```ts
abrState.playerTimeMs = this.mainFormat ? getTotalDownloadedDuration(this.mainFormat) : 0;
```

On the **first** iteration no format is initialized, so `mainFormat` is null and
the position is unconditionally reset to **0** — discarding both `startAtMs` and
a restored state's own position, before the request is even built. Changing the
fallback from `0` to the requested start position is the whole fix.

This is arguably an upstream bug in its own right: it is also why a restored
state only "worked" when its `initializedFormatsMap` happened to make
`mainFormat` non-null.

### The second half

A `playerTimeMs` on its own is *not* a seek instruction — the server serves from
the end of what the client claims to hold. So when `startAtMs` is set on a fresh
session, the patch also synthesises the buffered ranges that justify it:

```ts
formatId: { itag: f.itag, lastModified: f.lastModified, xtags: f.xtags }
```

That `formatId` matters. A `BufferedRange` without one is meaningless, and every
earlier attempt from *outside* the library omitted it — `SabrFormat` has no
`.formatId` property, it carries the FormatId fields inline.

### Why this could not be done from outside

`restoreState` only accepts state it produced itself, and the internal
`downloadedSegments` / `lastMediaHeaders` must agree with any buffered ranges you
assert. Four external attempts are preserved in `seek-test.ts` and
`seek2-test.ts` — including one using *real* indexed segment boundaries — and all
either started at 0 or stalled the server. Being inside the library is what makes
the state coherent.

### Upstreaming

The patch is small, additive and fixes a real bug. Worth offering to
`LuanRT/googlevideo` (MIT) rather than carrying: it is the difference between a
permanent fork and a merged feature. Note the working tree also carries a
`SABR_TRACE` debug log, stripped from this patch.

## Previously: what it did NOT prove — seeking

`SabrStream` cannot seek **as shipped**. Four attempts from outside the library,
all recorded in `seek-test.ts`, `seek2-test.ts` and `resume-test.ts`:

| attempt | result |
|---|---|
| `start({ state: { playerTimeMs } })` | ignored — starts at 0. `restoreState` rejects a partial state |
| snapshot a live session, resume it | works, but lands where the snapshot stopped (20.7 s), not the requested 120 s |
| clear `cachedBufferedRanges` + `downloadedSegments` | starts at 0 |
| synthesise a `cachedBufferedRanges` claiming 0→T buffered | server serves nothing; "Stream stalled 5 times, aborting" |

`grep -c seek` in `SabrStream.d.ts` returns **0**. `playerTimeMs` describes where
a session *is*, not where you want it to go.

Seek lives in the sibling export, `SabrStreamingAdapter` (`lastPlayerTimeSecs`,
driven by a 12-method `SabrPlayerAdapter` whose `getPlayerTime()` is the seek
mechanism). But its own doc says:

> Sets up request/response interceptors so we can send proper SABR requests
> (**UMP response parsing must be done in the player adapter**).

So the two exports trade off exactly the thing a converter needs:

| | UMP parsed for you | seek |
|---|---|---|
| `SabrStream` | yes | **no** |
| `SabrStreamingAdapter` | **no** | yes |

Neither gives headless + seek out of the box. That is the single most important
correction this spike produced.

## po_token is not required (here, today)

`potoken-test.ts` runs SABR with and without BotGuard attestation:

```
WEB           no po_token: WORKS  2 segments, init=true
ANDROID       no po_token: WORKS  2 segments, init=true
IOS           no po_token: WORKS  2 segments, init=true
TV            no po_token: WORKS  2 segments, init=true
MWEB          no po_token: WORKS  2 segments, init=true
WEB_EMBEDDED  no po_token: WORKS  2 segments, init=true
WEB         WITH po_token: WORKS  2 segments, init=true
```

Three caveats, all of which matter more than the result:

- **This is one IP.** po_token enforcement tracks IP reputation, and datacenter
  ranges are treated far more harshly than a home connection. "Not needed here"
  is not "not needed anywhere".
- **It can change without notice.** YouTube tightens this periodically; yt-dlp's
  SABR branch still documents a PO Token as required for `web`.
- **Only short unauthenticated VOD pulls were tested** (2 segments). Longer
  sessions may trip `streamProtectionStatus`, which `SabrStream` tracks and this
  test did not inspect.

So: do not build po_token in as mandatory, but keep the ability to mint one and
attach it lazily when the server objects. `SabrStream.setPoToken()` exists for
exactly that, and attestation is cheap anyway — **263ms**, then cacheable.

## Other findings worth keeping

- **`stream.abort()`, never `reader.cancel()`.** Cancelling the reader leaves
  SabrStream writing into a closed controller, which it retries ten times per
  segment. A naive converter hits this immediately.
- **Resume must stay inside one session.** Pairing a captured state with a
  freshly created session fails with `sabr.media_serving_enforcement_id_error`.
  The player response, deciphered URL and state have to be cached together.
- **Resume does not resend the init segment** — the server assumes the client
  still has it. A parser waiting for `ftyp`/`moov` will hang forever.
- **Format preference flags are not enough.** `preferWebM: false` still returned
  `audio/webm; codecs="opus"` (EBML, not ISO-BMFF), which the segmenter cannot
  cut at all. Pass an explicit `audioFormat` selector.
- **Every client exposes SABR** — `probe.ts` shows WEB, ANDROID, IOS, TV, MWEB,
  WEB_EMBEDDED and TV_EMBEDDED all return `server_abr_streaming_url`. There is no
  "SABR video" to hunt for; SABR is available today alongside the byte-range
  formats, which YouTube simply has not withdrawn yet.
- **`getBasicInfo` works where a hand-rolled NavigationEndpoint call did not** —
  the latter silently returned no `server_abr_streaming_url`.
