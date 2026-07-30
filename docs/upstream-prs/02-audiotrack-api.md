# PR 2 — Expose `audioTrack` on `adaptiveFormats`

**Status: SUBMITTED as [iv-org/invidious#5845](https://github.com/iv-org/invidious/pull/5845)**
on 2026-07-30, from branch `feat/api-audio-track` on `mdbraber/invidious`.

The body actually submitted differs from the draft below: it carries the
AI disclosure `AI_POLICY.md` requires (exact model + tool), and the
cross-references use real PR numbers. Read the PR for the submitted text.

## Proposed title

    feat(api): expose audioTrack on adaptiveFormats

## Proposed body

Videos with multi-language audio carry an `audioTrack` object on each audio entry
of `streamingData.adaptiveFormats`, holding the language id (e.g. `"en-US.4"`), a
human-readable `displayName`, and whether the track is the original audio.

Invidious already parses and uses all three: `Invidious::Routes::API::Manifest`
reads `audioTrack["id"]`, `audioTrack["audioIsDefault"]` and
`audioTrack["displayName"]` to label and order the audio `AdaptationSet`s of the
DASH manifest. But `/api/v1/videos` drops it, so an API consumer has no way to
tell one audio track from another.

Clients are left to scrape it back out of the stream URL query string —
`xtags=acont%3Ddubbed%3Alang%3Dfr` — which is undocumented, changes without
notice, and fails silently when it does.

This emits the same three fields the manifest route already relies on, each only
when present, in the same passthrough style as the neighbouring `colorInfo` and
`captionTrack` fields.

### Result

On a 24-language video (`0e3GPea1Tyg`), `adaptiveFormats[]` audio entries now
carry:

```json
{"id": "en-US.4",   "displayName": "English (US) original", "audioIsDefault": true}
{"id": "fr.3",      "displayName": "French",                "audioIsDefault": false}
{"id": "zh-Hans.3", "displayName": "Chinese (Simplified)",  "audioIsDefault": false}
{"id": "zh-Hant.3", "displayName": "Chinese (Traditional)", "audioIsDefault": false}
```

24 distinct ids, all named, exactly one flagged as the original.

Single-audio videos carry no `audioTrack` at all and so gain no field, which is
correct — there is no second track to distinguish.

### Notes for reviewers

- Additive and optional throughout: each field is emitted only when YouTube
  supplies it, so no existing response changes shape unless the video actually
  has multi-language audio.
- `audioTrack` mirrors YouTube's own field name, and the nested-object shape
  mirrors what `manifest.cr` already consumes.
- Happy to add an API-documentation entry if wanted — say where it should go.
- One caveat worth flagging: consumers should not fold the language id's track
  discriminator (`en-US.4` → `en-US`) and then key on the *primary* subtag. Doing
  that merges `zh-Hans` with `zh-Hant`, which are different dubs. We hit exactly
  that bug downstream.

## Patch

```diff
diff --git a/src/invidious/jsonify/api_v1/video_json.cr b/src/invidious/jsonify/api_v1/video_json.cr
index e02e0617..b7658165 100644
--- a/src/invidious/jsonify/api_v1/video_json.cr
+++ b/src/invidious/jsonify/api_v1/video_json.cr
@@ -150,6 +150,23 @@ module Invidious::JSONify::APIv1
               json.field "audioSampleRate", fmt["audioSampleRate"].as_s.to_i if fmt.has_key?("audioSampleRate")
               json.field "audioChannels", fmt["audioChannels"] if fmt.has_key?("audioChannels")
 
+              # Multi-language audio. Only present when a video carries more than
+              # one audio track. The same data already drives the DASH manifest
+              # (see `Invidious::Routes::API::Manifest`), but was never exposed on
+              # the API, leaving clients to scrape `xtags` out of the stream URL.
+              if audio_track = fmt["audioTrack"]?
+                json.field "audioTrack" do
+                  json.object do
+                    # Language tag with a track discriminator, e.g. "en-US.4".
+                    json.field "id", audio_track["id"] if audio_track["id"]?
+                    # Human-readable label, e.g. "English (original)".
+                    json.field "displayName", audio_track["displayName"] if audio_track["displayName"]?
+                    # True for the video's original (undubbed) audio.
+                    json.field "audioIsDefault", audio_track["audioIsDefault"] if audio_track["audioIsDefault"]?
+                  end
+                end
+              end
+
               # Extra misc stuff
               json.field "colorInfo", fmt["colorInfo"] if fmt.has_key?("colorInfo")
               json.field "captionTrack", fmt["captionTrack"] if fmt.has_key?("captionTrack")
```
