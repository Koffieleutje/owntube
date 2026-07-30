# Upstream PRs for iv-org/invidious — SUBMITTED 2026-07-30

| PR | title | branch |
|---|---|---|
| [#5844](https://github.com/iv-org/invidious/pull/5844) | fix(extractors): detect livestreams from the thumbnail time-status overlay | `fix/livestream-thumbnail-overlay` |
| [#5845](https://github.com/iv-org/invidious/pull/5845) | feat(api): expose audioTrack on adaptiveFormats | `feat/api-audio-track` |
| [#5846](https://github.com/iv-org/invidious/pull/5846) | feat(api): expose isShort on list items | `feat/api-is-short` |

All three branch independently off `origin/master` (`9d1291a0`) and are pushed to
`mdbraber/invidious`.

## `AI_POLICY.md` compliance

iv-org **permits** AI-assisted contributions under conditions
([AI_POLICY.md](https://github.com/iv-org/invidious/blob/master/AI_POLICY.md)).
Each PR body and each commit message therefore discloses:

- **Exact model:** Claude Opus 5, model ID `claude-opus-5[1m]`
- **Tool:** Claude Code, Anthropic's agentic CLI

and states plainly what verification was performed, and that @mdbraber is the
submitter and solely responsible.

**Outstanding obligation.** The policy also requires that *"Any new code touching
any of the actual functions of Invidious MUST BE thoroughly tested by the Human
MANUALLY."* What the PRs claim is exactly what happened: the patches were built,
deployed to a live instance, measured before/after on live data, and are running
in production. They do **not** claim a manual human code review that has not
happened — read the three diffs yourself (they are 16, 17 and 28 lines) so the
accountability the policy assigns you is real.

The files below are the pre-submission drafts, kept for the reasoning. Each has a
proposed title, body, reproduction evidence, and the patch.

Why bother: the fork is five patches deep and every merged PR is one fewer patch
to rebase forever (see Phase 4 in `../INVIDIOUS-BOUNDARY-PLAN.md`). Upstreaming
is a cost reduction, not a safety requirement — the fork is safe without it.

## Assessment at submission time

| # | patch | kind | confidence |
|---|---|---|---|
| [#5844](https://github.com/iv-org/invidious/pull/5844) | [`01-livenow-overlay.md`](01-livenow-overlay.md) | bug fix | **high** — reproducible on any trending fetch, affects upstream's own web UI |
| [#5845](https://github.com/iv-org/invidious/pull/5845) | [`02-audiotrack-api.md`](02-audiotrack-api.md) | API addition | medium — clean, but adds a field, so upstream may want an API-doc change too |
| [#5846](https://github.com/iv-org/invidious/pull/5846) | [`03-isshort-api.md`](03-isshort-api.md) | API addition | medium — same, plus it answers an existing upstream TODO |

Submit **1 first and on its own**. It is a pure bug fix with no API surface, so
it should be uncontroversial, and how upstream handles it is a cheap signal for
how they will handle 2 and 3.

**#5844 and #5846 conflict with each other** — both insert a `thumbnailOverlays`
read just after the `badges` loop in `VideoRendererParser`. Each applies cleanly
to `master` on its own, so whichever merges second needs a one-hunk rebase. Both
PR bodies say so and cross-reference each other. #5846's branch is the standalone
form, so it does not depend on #5844 merging first.

**CI had not started** at submission time (0 contexts, pending) — iv-org gates
workflow runs on first-time contributors, so a maintainer has to release them.

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

## Follow-ups now that they are open

1. Read the three diffs yourself — the policy makes you solely responsible, and
   they are small (16, 17, 28 lines).
2. Expect a naming question on #5845 and #5846. `audioTrack` mirrors YouTube's own
   field name; `isShort` mirrors the existing `isUpcoming` / `isNew` style. Both
   bodies offer an API-documentation entry if wanted.
3. Whichever of #5844 / #5846 is reviewed second may need the one-hunk rebase;
   both bodies already offer it.
4. If they ask for #5844 and #5846 to be combined, both bodies invite that.
