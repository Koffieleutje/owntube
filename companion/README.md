# OwnTube companion

A tiny public RSS mirror for a LAN-only OwnTube. The home OwnTube **pushes**
self-contained feed snapshots here; this service stores them and renders podcast
RSS. Every `<enclosure>` URL points back at the LAN media origin
(`/media/<id>.m4a` / `.mp4`), so the feed *metadata* is public (behind Basic
Auth) while the media only streams on the LAN.

```
LAN owntube ──POST /publish (Bearer)──▶ companion (spiff, owntube.nedworks.org)
                                          └ GET /rss/<kind>/<slug>.{audio,video}.xml  (Basic Auth)
podcast app ──(LAN/VPN)──▶ owntube /media/<id>   ◀── enclosure URLs
```

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/publish` | Bearer `PUBLISH_SECRET` | Replace the full feed set with the pushed snapshots |
| GET | `/rss/<kind>/<slug>.audio.xml` | Basic | Podcast RSS, m4a enclosures |
| GET | `/rss/<kind>/<slug>.video.xml` | Basic | Podcast RSS, mp4 enclosures |
| GET | `/` | Basic | HTML index of all feeds |
| GET | `/opml.xml` | Basic | OPML of every feed (both variants) |
| GET | `/health` | none | Liveness |

Feed `kind` ∈ `playlist`, `queue`, `saved`, `subscriptions`, `tag`, `channel`.

Subscribe in a podcast app with the credentials inline:

```
https://<RSS_USER>:<RSS_PASS>@owntube.nedworks.org/rss/playlist/<slug>.audio.xml
```

## Config (env)

| Var | Required | Default | |
| --- | --- | --- | --- |
| `PUBLISH_SECRET` | yes | — | Must match the home side's `OWNTUBE_PUBLISH_SECRET` |
| `RSS_USER` / `RSS_PASS` | yes | — | Basic Auth for the feeds |
| `PORT` | no | `8080` | |
| `DATA_DIR` | no | `/data` | SQLite location |

## Run

```sh
cp .env.example .env   # fill in the secrets
docker compose up -d --build
```

Local dev (needs Node ≥ 22 for `.ts` execution, or use `npx tsx`):

```sh
npm install
PUBLISH_SECRET=x RSS_USER=me RSS_PASS=pw DATA_DIR=./data npm start
npm test    # render unit tests
```

## Deploy on spiff

Lives at `/var/docker/owntube-companion/` on spiff, fronted by its
caddy-docker-proxy (`caddy` external network, `caddy` label prefix — see
`docker-compose.yml`). Public TLS is provisioned automatically by Caddy. The
companion does its own HTTP Basic Auth, so it deliberately does **not** import
spiff's `auth` (authelia) snippet — a login portal would break podcast-client
credentials.

```sh
# from the owntube repo on naggon:
rsync -az --delete --exclude node_modules --exclude data --exclude '*.db*' \
  companion/ root@spiff.nedworks.org:/var/docker/owntube-companion/
# create /var/docker/owntube-companion/.env on spiff (PUBLISH_SECRET must match
# the home side's OWNTUBE_PUBLISH_SECRET; RSS_USER/RSS_PASS guard the feeds)
ssh root@spiff.nedworks.org 'cd /var/docker/owntube-companion && docker compose up -d --build'
curl -sf https://owntube.nedworks.org/health   # -> ok
```
