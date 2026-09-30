#!/bin/sh
# Deploy the VISIONOS companion image and put production OwnTube on SABR VOD fallback.
# Every step is reversible; see the ROLLBACK section at the end. Run as root on the host.
set -eu
NEW=nedworks/invidious-companion:2026.09.23-master-8ea6aec
OLD=nedworks/invidious-companion:2026.09.23-camoufox-471fa2e
STAMP=$(date +%Y%m%d-%H%M%S)

echo "== 1. companion: $OLD -> $NEW"
cd /var/data/config/invidious
cp docker-compose.yml "docker-compose.yml.bak-sabrvod-$STAMP"
sed -i "s#image: $OLD#image: $NEW#" docker-compose.yml
grep -n 'image: nedworks/invidious-companion' docker-compose.yml
docker compose up -d invidious-companion
for i in $(seq 1 40); do
  [ "$(docker inspect invidious-companion --format '{{.State.Health.Status}}')" = healthy ] && { echo "companion healthy"; break; }
  sleep 3
done
docker inspect invidious-companion --format 'image={{.Config.Image}} health={{.State.Health.Status}}'

echo "== 2. owntube: INVIDIOUS_COMPANION_SABR_VOD=fallback (needs the code from main 3e9338d)"
cd /var/data/config/owntube
cp docker-compose.yml "docker-compose.yml.bak-sabrvod-$STAMP"
cp .env ".env.bak-sabrvod-$STAMP"
grep -q 'INVIDIOUS_COMPANION_SABR_VOD' docker-compose.yml || \
  sed -i 's#^      INVIDIOUS_DIRECT_HLS_SEGMENTS: ${INVIDIOUS_DIRECT_HLS_SEGMENTS:-false}#&\n      INVIDIOUS_COMPANION_SABR_VOD: ${INVIDIOUS_COMPANION_SABR_VOD:-off}#' docker-compose.yml
grep -q '^INVIDIOUS_COMPANION_SABR_VOD=' .env || printf '\n# VOD via the companion SABR connector: off | fallback | always (docs/LIVE-AND-DVR-PLAYBACK.md)\nINVIDIOUS_COMPANION_SABR_VOD=fallback\n' >> .env
grep -n 'SABR_VOD' docker-compose.yml .env
docker tag owntube-owntube:latest "owntube-owntube:pre-sabr-$STAMP"
docker compose build owntube
docker compose up -d owntube
for i in $(seq 1 40); do
  [ "$(docker inspect owntube --format '{{.State.Health.Status}}')" = healthy ] && { echo "owntube healthy"; break; }
  sleep 3
done
docker exec owntube sh -c 'echo "SABR_VOD in container: $INVIDIOUS_COMPANION_SABR_VOD"'

echo "== 3. checks"
M=https://owntube-media.home.nedworks.org
# fallback mode: an ordinary VOD must still be byte-range (vp9, no /sabr/ paths)
curl -s "$M/dash/aqz-KE-bpKQ/manifest.mpd?video=vp9" | grep -oE 'codecs="[^"]*"' | sort -u | head -3
curl -s "$M/dash/aqz-KE-bpKQ/manifest.mpd?video=vp9" | grep -c '/sabr/' || true   # expect 0
# live: pick any liveNow video id and check the live manifest still comes back dynamic
# curl -s "$M/dash/<liveId>/live.mpd" | head -c 300

cat <<'ROLLBACK'
== ROLLBACK (each step independent)
 - OwnTube back to non-SABR: set INVIDIOUS_COMPANION_SABR_VOD=off in /var/data/config/owntube/.env,
   then: cd /var/data/config/owntube && docker compose up -d owntube      (no rebuild needed)
 - OwnTube code rollback: docker tag owntube-owntube:pre-sabr-<STAMP> owntube-owntube:latest && docker compose up -d owntube
 - companion back: cd /var/data/config/invidious && sed -i 's#2026.09.23-master-8ea6aec#2026.09.23-camoufox-471fa2e#' docker-compose.yml && docker compose up -d invidious-companion
ROLLBACK
