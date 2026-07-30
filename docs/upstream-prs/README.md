# Draft upstream PRs for iv-org/invidious

**Nothing here has been submitted.** These are drafts for review before anything
is opened upstream. Each file has a proposed title, a body, the reproduction
evidence, and the exact patch.

Why bother: the fork is five patches deep and every merged PR is one fewer patch
to rebase forever (see Phase 4 in `../INVIDIOUS-BOUNDARY-PLAN.md`). Upstreaming
is a cost reduction, not a safety requirement — the fork is safe without it.

## Ready to submit

| # | patch | kind | confidence |
|---|---|---|---|
| 1 | [`01-livenow-overlay.md`](01-livenow-overlay.md) | bug fix | **high** — reproducible on any trending fetch, affects upstream's own web UI |
| 2 | [`02-audiotrack-api.md`](02-audiotrack-api.md) | API addition | medium — clean, but adds a field, so upstream may want an API-doc change too |
| 3 | [`03-isshort-api.md`](03-isshort-api.md) | API addition | medium — same, plus it answers an existing upstream TODO |

Submit **1 first and on its own**. It is a pure bug fix with no API surface, so
it should be uncontroversial, and how upstream handles it is a cheap signal for
how they will handle 2 and 3.

**All three verified to apply cleanly to `origin/master`** (`git apply --check`
in a throwaway worktree at `9d1291a0`). One caveat: 1 and 3 both insert a
`thumbnailOverlays` read just after the `badges` loop in `VideoRendererParser`,
so they conflict *with each other* — whichever merges second needs a one-hunk
rebase. PR 3's patch here is the standalone form, rebased off PR 1, so it does
not depend on 1 being merged first.

## Deliberately not drafted

- **`fix(captions): route API caption fetch through invidious-companion`** — our
  patch redirects to the companion unconditionally, which is wrong for instances
  without one. Upstreamable only after being rewritten to fall back when no
  companion is configured. Worth doing; it is a real bug (Invidious' own
  timedtext fetch is IP-blocked by Google).
- **`fix: do not mark every lockup channel video as upcoming`** and
  **`fix: recover views/date for collaboration videos`** — both predate this
  work and neither has a live reproducer any more; no channel tried exercised
  those paths. Do not submit a bug fix you cannot demonstrate.
- **The two local-infrastructure commits** (`nedworks-rebuild.sh`,
  `Dockerfile.nedworks`) — deployment-specific, never upstream.
- **The four invidious-companion DVR fixes** — a different repository
  (iv-org/invidious-companion#249); clean patches already exist in
  `/usr/local/src/invidious-companion-dvrfix`.

## Before submitting any of these

1. Re-read iv-org's contributing guide; they have opinions about commit style
   and may want an API-documentation change alongside 2 and 3.
2. Rebase onto current `master` — these were authored against `9d1291a0`.
3. Check for an existing issue or PR covering the same ground and reference it.
4. For 2 and 3, expect a question about naming. `audioTrack` mirrors YouTube's
   own field name; `isShort` mirrors the existing `isUpcoming` / `isNew` style.
