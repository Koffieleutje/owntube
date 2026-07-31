#!/bin/sh
# OwnTube playback hook → pocket-sessions (PCS). Reports watch state so it
# can be written through to Pocket Casts. All PCS-specifics live HERE — the
# server only knows it runs hooks.
#
# Install: copy into OWNTUBE_HOOKS_DIR (e.g. data/hooks), chmod +x, and set
# in the container env:
#   PCS_PLAYBACK_URL=https://pcs.nedworks.org/api/v1/playback
#   PCS_PLAYBACK_TOKEN=<a PCS bearer token>
#
# PCS applies an ahead-only guard (sticky completion, echo-dropping), so
# this hook is idempotent by construction: live and replay events alike can
# be re-delivered safely. Not configured is not a failure — exit 0 silently.

set -eu

[ -n "${PCS_PLAYBACK_URL:-}" ] || exit 0
[ -n "${PCS_PLAYBACK_TOKEN:-}" ] || exit 0
[ -n "${OT_VIDEO_ID:-}" ] || exit 0

body=$(printf '{"enclosureContains":"%s","positionSeconds":%s,"completed":%s,"durationSeconds":%s}' \
  "$OT_VIDEO_ID" "${OT_POSITION_SECONDS:-0}" "${OT_COMPLETED:-false}" "${OT_DURATION_SECONDS:-0}")

# curl exits 0 on HTTP errors; check the status code ourselves.
raw=$(curl -sS --max-time 20 -w '\n%{http_code}' -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PCS_PLAYBACK_TOKEN" \
  -d "$body" "$PCS_PLAYBACK_URL") || exit 1
code=$(printf '%s' "$raw" | tail -n1)
resp=$(printf '%s' "$raw" | sed '$d')

case "$code" in
  2??) ;;
  *) echo "pcs: HTTP $code for $OT_VIDEO_ID" >&2; exit 1 ;;
esac

# Only speak when something happened: applied writes are worth a log line,
# guarded drops (behind/already-completed/unknown-episode) stay quiet.
case "$resp" in
  *'"applied":true'*) echo "pcs: $OT_EVENT $OT_VIDEO_ID applied (${OT_SOURCE:-live})" ;;
esac
