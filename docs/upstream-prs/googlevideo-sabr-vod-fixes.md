# Draft PR — LuanRT/googlevideo: fix `SabrStream` VOD stalls and add seeking

**Status:** draft for review before submitting to `LuanRT/googlevideo`.
**Source of truth:** `owntube/spikes/sabr-dash/googlevideo-seek.patch`.
**Base:** googlevideo 4.1.1.

---

## Title

`fix(SabrStream): correct buffered-range accounting so long VODs complete; add seek support`

## Summary

`SabrStream` (the headless downloader, not the adapter) stalls partway through
longer VOD downloads and cannot start at a non-zero position. Both come down to
how the client describes its buffered state to the server. This PR fixes five
distinct defects, each verified independently against yt-dlp's SABR
implementation (which downloads the same videos successfully) by decoding the
raw `VideoPlaybackAbrRequest` bytes and diffing field by field.

With these applied, a 1541-second video that previously died after ~12 fragments
now downloads all 288, a 3116-second video downloads all 609, and seeking to an
arbitrary offset works. No po_token is involved.

## Motivation

On a fresh `SabrStream` download of any VOD longer than roughly a minute, the
server serves ~60 seconds of media, then answers every subsequent request with
protocol parts but **no media**, and the stream fails with either "No media
parts or protocol updates received" or "attestation required". Short videos
complete, which made this look like a server-side anti-bot policy — it is not.
yt-dlp downloads the identical videos over SABR from the same host with no
po_token, so the difference is entirely in the request `SabrStream` builds.

## The five fixes

Each is independent and separately justified.

### 1. `bufferedRanges` must accumulate, not send deltas

`buildBufferedRanges()` built ranges from `lastMediaHeaders` and then cleared it,
so each request advertised **only the segments received since the previous
request** — 1–4, then 5–7 (dropping 1–4), then 8–11, each replacing its
predecessor. The server decides what to send next by subtracting what the client
holds from what it needs; a client that keeps forgetting eventually describes a
buffer that cannot be reconciled with its playback position, and the server stops
sending media.

Fixed by accumulating consumed ranges per format for the session lifetime, merged
by the same rule yt-dlp uses: extend the range ending at `sequenceNumber - 1`,
otherwise open a new one (which also keeps the gap a seek leaves as a gap).

### 2. Buffered-range ticks must use `timescale: 1000`

The range carried `startTicks`/`durationTicks` in **milliseconds** but quoted the
media header's `timescale` (commonly 24000), understating every buffered range by
~24×. yt-dlp always pairs millisecond ticks with `timescale: 1000`.

### 3. Playback position must be the buffered-range end, not the sum of segment durations

`getTotalDownloadedDuration()` drifts a few milliseconds past the end of the
buffered range, leaving the client claiming a position outside its own advertised
buffer. Pin `player_time_ms` to the maximum consumed-range end instead.

### 4. `EnabledTrackTypes.VIDEO_ONLY` puts an invalid value on the wire

`VIDEO_ONLY = 2` is sent as `enabled_track_types_bitfield = 2`. SABR has only
`0` (audio+video) and `1` (audio-only); there is no video-only value. yt-dlp
expresses video-only as `0` with the audio track discarded client-side —
selected so the server initializes it, advertised as fully buffered
(`0..MAX_INT`, under the format id the **server** initialized, which may differ
from the one selected), and never named in `preferredAudioFormatIds`. Sending `2`
works briefly, then triggers the same stall.

### 5. Media-header times may live only in `timeRange` ticks

Some player responses (raw `ANDROID_VR`, for one) send `startMs`/`durationMs` as
literal `0` and put the real timing only in `timeRange` ticks. Reading the direct
fields records every segment as zero-length, the advertised position never
advances, and the client re-requests position 0 forever. `timeRange` is now
authoritative when present, and init segments are excluded from consumed-range
accounting.

### 6. Seek support (the original motivation)

The requested start position was reset to `0` on the first loop iteration, before
any format was initialized, discarding both `startAtMs` and a restored state's
position. Fixed, plus synthetic buffered ranges are seeded so the server has a
reason to start where asked.

## Test evidence

Measured on real videos, no po_token:

| video | duration | before | after |
|---|---|---|---|
| `dQw4w9WgXcQ` | 213s | completed | completed |
| `0e3GPea1Tyg` | 1541s | ~12 fragments then stall | **288/288** |
| `Li8SgZcbSOI` | 1484s | ~14 fragments | **288/288** |
| `Y07j3hXAI-g` | 3116s | ~12 fragments | **609/609** |

Seek verified at 30/60/120/180s (first fragment lands within one segment of the
target). Output cross-validated byte-for-byte against yt-dlp's init and media
segments, and ffmpeg decodes the result cleanly (h264 640×360, full duration).

## Compatibility notes

- `SabrStreamState` gains `seededBufferedRanges` and a per-format `consumedRanges`
  (both optional on restore), replacing `cachedBufferedRanges`. Callers that
  persist and restore state across sessions should regenerate captured state.
- `buildBufferedRanges()` no longer mutates `lastMediaHeaders` as a side effect of
  being called; it folds into `consumedRanges` and clears, so a retry re-sends
  exactly what the failed attempt sent.
- No public API signature changes.

## Suggested commit split for review

1. Seek fix (start-position reset) — smallest, self-contained.
2. Cumulative `bufferedRanges` + `timescale: 1000` + position-at-range-end.
3. `VIDEO_ONLY` → bitfield 0 + client-side discard.
4. `timeRange`-authoritative media-header timing.

## Open question for the maintainer

Fix #4 assumes no caller depends on `VIDEO_ONLY` reaching the wire as `2`. If any
does, this should be gated behind an option rather than changed unconditionally —
happy to adjust.
