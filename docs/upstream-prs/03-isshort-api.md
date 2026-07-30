# PR 3 — Expose `isShort` on list items

**Status: SUBMITTED as [iv-org/invidious#5846](https://github.com/iv-org/invidious/pull/5846)**
on 2026-07-30, from branch `feat/api-is-short` on `mdbraber/invidious`.

The body actually submitted differs from the draft below: it carries the
AI disclosure `AI_POLICY.md` requires (exact model + tool), and the
cross-references use real PR numbers. Read the PR for the submitted text.

## Proposed title

    feat(api): expose isShort on list items

## Proposed body

Three parsers know for certain that an item is a Short and then discard the fact:

- `ShortsLockupViewModelParser` and `ReelItemRendererParser` only ever run on a
  shorts renderer, so every item they produce is a Short by construction.
- `VideoRendererParser` reads a thumbnail overlay whose text is the literal
  `"SHORTS"` in place of a duration. Its own TODO asks for this:
  `# TODO: Add some sort of metadata for the type of video (normal, live, premiere, shorts)`.

All three emit `VideoBadges::None`, so nothing downstream can tell a Short from a
normal video.

What makes that costly is the duration. YouTube no longer reports a real one for
Shorts, and these parsers substitute an approximate 60s
(`# NOTE: The actual duration is not provided by Youtube anymore`). So the only
signals left to a client are a length indistinguishable from a genuine
60-second upload, and a `#shorts` title tag that is a convention rather than
metadata.

Measured: all 48 items on a channel's Shorts tab report exactly
`lengthSeconds: 60`. And on a live search, 4 of 20 results carried `#shorts` in
the title while running between 8 and 27 minutes — so neither signal works.

This adds a `Shorts` badge, sets it in all three parsers, and serialises it as
`isShort` alongside the existing `isUpcoming` / `isNew` / `is4k` flags.

### Result

- Channel Shorts tab: 48/48 items `isShort: true` (previously no field).
- Channel videos tab: 0/60 — no false positives.
- Search: the `#shorts`-titled long videos correctly report `isShort: false`.

### Notes for reviewers

- `Shorts` is **appended** to the `VideoBadges` flags enum rather than inserted,
  since these are bit values and reordering would change the meaning of any
  already-persisted badge set.
- Naming follows the existing serialised flags (`isUpcoming`, `isNew`, `is4k`).
- This does not attempt to fix the fabricated 60s duration; that is a separate
  question (the parser's own TODO suggests `-1`), and the flag is what clients
  actually need to branch on.
- Happy to add an API-documentation entry if wanted.
- **Overlaps with PR 1** (`fix(extractors): detect livestreams from the thumbnail
  time-status overlay`): both insert a `thumbnailOverlays` read immediately after
  the `badges` loop in `VideoRendererParser`. Each applies cleanly to `master` on
  its own, but whichever merges second needs a one-hunk rebase. They are
  independent changes, so they are offered as separate PRs rather than bundled —
  say the word if you would rather have one.

## Patch

```diff
diff --git a/src/invidious/helpers/serialized_yt_data.cr b/src/invidious/helpers/serialized_yt_data.cr
index 17dff566..95663d9a 100644
--- a/src/invidious/helpers/serialized_yt_data.cr
+++ b/src/invidious/helpers/serialized_yt_data.cr
@@ -9,6 +9,9 @@ enum VideoBadges
   VR180
   VR360
   ClosedCaptions
+  # Appended rather than inserted: these are @[Flags] bit values, and reordering
+  # would silently change the meaning of any already-stored badge set.
+  Shorts
 end
 
 struct SearchVideo
@@ -133,6 +136,11 @@ struct SearchVideo
       json.field "isVr360", self.badges.vr360?
       json.field "is3d", self.badges.three_d?
       json.field "hasCaptions", self.badges.closed_captions?
+      # Whether YouTube served this as a Short. Worth stating outright: the
+      # duration cannot be used to infer it, because YouTube no longer reports a
+      # real one for Shorts and the parsers substitute an approximate 60s — so a
+      # genuine 60-second upload is otherwise indistinguishable from a Short.
+      json.field "isShort", self.badges.shorts?
     end
   end
 
diff --git a/src/invidious/yt_backend/extractors.cr b/src/invidious/yt_backend/extractors.cr
index b2226e74..9d836c84 100644
--- a/src/invidious/yt_backend/extractors.cr
+++ b/src/invidious/yt_backend/extractors.cr
@@ -156,6 +156,18 @@ private module Parsers
         end
       end
 
+      # A Short is marked by the thumbnail's time-status overlay, which carries
+      # the literal text "SHORTS" where a duration would be. The length branch
+      # above already special-cases it — approximating 60s, because YouTube no
+      # longer reports a real duration for Shorts — but then discards the *fact*,
+      # leaving clients to re-derive it from that approximated length or from a
+      # "#shorts" title tag. Neither works: a genuine 60-second upload looks
+      # identical, and the tag is only a convention.
+      is_shorts_overlay = item_contents["thumbnailOverlays"]?.try &.as_a.any? do |overlay|
+        overlay.dig?("thumbnailOverlayTimeStatusRenderer", "text", "simpleText").try &.as_s == "SHORTS"
+      end
+      badges |= VideoBadges::Shorts if is_shorts_overlay
+
       SearchVideo.new({
         title:              title,
         id:                 video_id,
@@ -609,6 +621,8 @@ private module Parsers
 
       duration = (minutes*60 + seconds)
 
+      # Shorts is certain here rather than inferred: this parser only ever runs
+      # on a reel renderer, which YouTube uses exclusively for Shorts.
       SearchVideo.new({
         title:              title,
         id:                 video_id,
@@ -621,7 +635,7 @@ private module Parsers
         premiere_timestamp: Time.unix(0),
         author_verified:    false,
         author_thumbnail:   nil,
-        badges:             VideoBadges::None,
+        badges:             VideoBadges::Shorts,
       })
     end
 
@@ -872,6 +886,10 @@ private module Parsers
       # TODO: Maybe use -1 as an error value and handle that on the frontend?
       duration = 60_i32
 
+      # Shorts is certain here rather than inferred: this parser only ever runs
+      # on a shorts renderer. Without the badge, the approximated 60s above is
+      # the only hint a client has left, and it cannot be told apart from a real
+      # 60-second upload.
       SearchVideo.new({
         title:              title,
         id:                 video_id,
@@ -884,7 +902,7 @@ private module Parsers
         premiere_timestamp: Time.unix(0),
         author_verified:    false,
         author_thumbnail:   nil,
-        badges:             VideoBadges::None,
+        badges:             VideoBadges::Shorts,
       })
     end
 
```
