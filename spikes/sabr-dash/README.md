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

### Known limitation: long videos stop at ~12 fragments

Short videos convert end to end — `dQw4w9WgXcQ` (213s) pulls complete, 240 MB,
38 fragments. Videos of ~25 minutes and up stop after about 60 seconds of media:

| video | duration | result |
|---|---|---|
| `dQw4w9WgXcQ` | 213s | **complete**, 38 fragments |
| `0e3GPea1Tyg` | 1541s | stops at ~12 fragments (~63s) |
| `Li8SgZcbSOI` | 1484s | stops at ~14 fragments |
| `Y07j3hXAI-g` | 3116s | stops at ~12 fragments |

**This is our bug, not YouTube policy.** yt-dlp downloads `0e3GPea1Tyg` in full
over SABR — 288/288 fragments, 17.4 MB, in 4 seconds — from this host, with the
same client (ANDROID_VR) and the same itag (160), minutes before and after our
attempt fails. Its own state line ends `pot:N`: **no po_token at all**.

```
[sabr:stream] All enabled formats have reached their last expected segment
              at player time 1541208 ms, assuming end of vod.
[SABR State] v:0e3GPea1Tyg c:ANDROID_VR t:1541208 rn:146 act:Y pot:N
             cr:[251:0-9007199254740991, 160:1-288 (0-1541208)]
```

yt-dlp does stall on this video occasionally — one run in three did — but it
succeeds far more often than not, while we fail every time.

#### What the failure looks like

The error is `Cannot proceed with stream: attestation required`, which is what
sent the earlier investigation after po_tokens. Two findings say attestation is
a symptom rather than the cause:

1. **yt-dlp needs no token for this video** (`pot:N` above). ANDROID_VR is
   exempt, and it still gets all 288 fragments.
2. **The demand is provoked by our own request.** googlevideo always names the
   audio track in `preferredAudioFormatIds`, even when that track is being
   discarded for a video-only pull. yt-dlp sends an **empty** preferred list for
   a discarded track. Suppressing ours changes the failure from `attestation
   required` to an ordinary stall — so the server is reacting to being asked to
   serve a track we intend to throw away.

That change is **not** committed: with the audio track no longer served, the
end-of-stream completeness check trips on the discarded format
(`Format 251:: Missing segments: [1..22]`), so it needs the discard path taught
that a suppressed track has nothing to await. It is the strongest lead here.

#### Diffed against a working request

At the exact fragment we die on, yt-dlp's request is:

```
player_time_ms=63273
buffered_ranges=[
  itag 251 (discarded): 0 .. 9007199254740991, segments 0..9007199254740991
  itag 160:             0 .. 63273 ms,         segments 1..12
]
```

Ours matches this — same player time (63272), same video range, same cumulative
shape — once the `bufferedRanges` and timescale fixes below are applied. The
remaining differences are the discarded track's dummy range (we write
`startSegmentIndex` = MAX_INT32 where yt-dlp writes 0) and `ClientAbrState`
fields we never set (`drc_enabled`, `enable_voice_boost`, and
`media_capabilities`, which yt-dlp sends for ANDROID/IOS/ANDROID_VR).

**Setting those did not help, and made things worse**: with them the 213s video
regressed to 0 bytes and `Player response reload requested by server`. They are
reverted. Recorded so the next attempt does not repeat them blind.

#### Attestation does work from this host

Worth separating from the above, because the earlier write-up got it wrong.
Running Brainicism's `bgutil-ytdlp-pot-provider` container here mints a real
integrity token first try:

```
Using challenge from /att/get
Generated IntegrityToken: {"integrityToken":"ULSw64xpJGoe...","estimatedTtlSecs":43200}
```

So the spike's own minter (`minter.ts`) is simply broken, and the difference is
visible in that log line: the provider takes its challenge from
**`https://www.youtube.com/att/get`**, while `minter.ts` follows the companion in
asking Innertube via `getAttestationChallenge`. Not chased further, because no
token is needed to fix the actual bug.

To bring the provider back up:

```bash
docker start bgutil-pot   # or: docker run -d --name bgutil-pot -p 127.0.0.1:4416:4416 \
                          #       brainicism/bgutil-ytdlp-pot-provider
```

#### Next step

Suppress the discarded track from `preferredAudioFormatIds` **and** exempt it
from the end-of-stream segment check. That is a contained change in
`SabrStream`, and it is the only lead that has moved the failure so far.

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
