# Feeds

Podcast feeds for OwnTube, in two halves that talk over one HTTP call.

```
pusher ──POST /publish (Bearer)──▶ server (public: owntube.nedworks.org)
                                       │
                                       ├── /<feed>.rss        Basic Auth, per user
                                       ├── /chapters/<id>.json public
                                       └── /icon.png          public (cover art)
```

**`pusher/`** builds every user's feed snapshots from the OwnTube database and
POSTs them to the server. Its entrypoint lives here, but it deliberately imports
the web app's server modules — building a snapshot means reading the app's
SQLite database through its own schema and reusing its feed/RSS logic, and
reimplementing that would be a second source of truth for what a feed contains.
Run it with `pnpm --filter web push:feeds`.

**`server/`** is the public mirror. It holds no OwnTube logic: it stores what it
is given and renders RSS from it. It runs on a public host precisely because
podcast apps and directories cannot reach the LAN — and it serves chapters and
cover art unauthenticated for the same reason, since clients fetch those bare,
without the feed's credentials.

Not to be confused with **invidious-companion**, an unrelated third-party
service this repo also talks to (media and captions). The word "companion" in
`docs/` and `apps/` refers to that one.
