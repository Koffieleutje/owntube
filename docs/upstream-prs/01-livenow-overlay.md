# PR 1 — Detect livestreams from the thumbnail time-status overlay

**Status: SUBMITTED as [iv-org/invidious#5844](https://github.com/iv-org/invidious/pull/5844)**
on 2026-07-30, from branch `fix/livestream-thumbnail-overlay` on `mdbraber/invidious`.

The body actually submitted differs from the draft below: it carries the
AI disclosure `AI_POLICY.md` requires (exact model + tool), and the
cross-references use real PR numbers. Read the PR for the submitted text.

## Proposed title

    fix(extractors): detect livestreams from the thumbnail time-status overlay

## Proposed body

`VideoRendererParser` decides `liveNow` solely from a `"LIVE"` entry in
`videoRenderer.badges`. YouTube no longer always sends one: on the trending feed
`badges` is absent entirely, and the only live marker is the thumbnail's
time-status overlay, which carries `{"style": "LIVE", "text": "LIVE"}` where a
duration would otherwise be.

The result is that the list and detail endpoints contradict each other for the
same video id — `/api/v1/trending` reports `liveNow: false` while
`/api/v1/videos/<id>` reports `liveNow: true`.

This is especially visible because trending *is* the livestreams feed now:
`fetch_trending` browses the livestreams channel because YouTube removed the
aggregated trending page (#5397). So in practice nearly every trending item is
affected.

### Reproduction

Against an instance on `9d1291a0`, region NL:

```
$ curl -s '<instance>/api/v1/trending?region=NL' | jq -r '.[] | "\(.videoId) liveNow=\(.liveNow)"'
BRha0tJtI8s liveNow=false
qEcVsczCkBw liveNow=false
...

$ curl -s '<instance>/api/v1/videos/BRha0tJtI8s' | jq .liveNow
true
```

14 of 15 trending items disagreed with their own detail endpoint. After the
patch, 0 of 15.

The raw InnerTube payload for those items shows why — no `badges` key at all:

```json
{
  "videoId": "BRha0tJtI8s",
  "badges": null,
  "lengthText": null,
  "thumbnailOverlays": [
    { "thumbnailOverlayTimeStatusRenderer": { "style": "LIVE", "text": { "simpleText": "LIVE" } } }
  ],
  "viewCountText": { "simpleText": "6,091 watching" }
}
```

### Notes for reviewers

- Existing `badges` parsing is untouched; the overlay is read as an additional
  source, so instances still get `liveNow` from a `"LIVE"` badge where YouTube
  sends one.
- `length_seconds` deliberately needs no equivalent change: the overlay text is
  `"LIVE"`, which `decode_length_seconds` already reduces to `0` — correct for a
  stream with no fixed duration.
- Verified no false positives: a channel's videos tab (60 items), search (20,
  2 genuinely live) and popular (40) were unchanged by the patch, cross-checked
  against `/api/v1/videos` per item.
- This also fixes Invidious' own web UI, which renders the same `liveNow`.

## Patch

```diff
diff --git a/src/invidious/yt_backend/extractors.cr b/src/invidious/yt_backend/extractors.cr
index 6be88070..9a3511ae 100644
--- a/src/invidious/yt_backend/extractors.cr
+++ b/src/invidious/yt_backend/extractors.cr
@@ -156,6 +156,22 @@ private module Parsers
         end
       end
 
+      # A livestream no longer necessarily carries a "LIVE" entry in `badges`.
+      # On the trending feed — which is the livestreams feed since YouTube
+      # removed the aggregated trending page — `badges` is absent altogether and
+      # the only marker is the thumbnail's time-status overlay, which reads
+      # `{"style": "LIVE", "text": "LIVE"}` in place of a duration.
+      #
+      # Without this, every item on that feed is serialised as
+      # `liveNow: false`, directly contradicting `/api/v1/videos` for the same
+      # video id. (`length_seconds` needs no equivalent fix: the overlay text is
+      # "LIVE", which `decode_length_seconds` already reduces to 0 — correct for
+      # a stream with no fixed duration.)
+      is_live_overlay = item_contents["thumbnailOverlays"]?.try &.as_a.any? do |overlay|
+        overlay.dig?("thumbnailOverlayTimeStatusRenderer", "style").try &.as_s == "LIVE"
+      end
+      badges |= VideoBadges::LiveNow if is_live_overlay
+
       SearchVideo.new({
         title:              title,
         id:                 video_id,
```
