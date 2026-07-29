/**
 * OwnTube companion — public RSS mirror.
 *
 *   POST /publish                          push feed snapshots (Bearer PUBLISH_SECRET)
 *   GET  /rss/<kind>/<slug>.audio.xml      podcast RSS, audio enclosures (Basic Auth)
 *   GET  /rss/<kind>/<slug>.video.xml      podcast RSS, video enclosures (Basic Auth)
 *   GET  /                                 HTML index of all feeds       (Basic Auth)
 *   GET  /opml.xml                         OPML of all feeds             (Basic Auth)
 *   GET  /health                           liveness (no auth)
 *
 * Feed metadata is public-behind-basic-auth; the `<enclosure>` media only
 * streams on the LAN (that origin is unreachable off-LAN), so putting the LAN
 * creds in a podcast app URL (https://user:pass@host/rss/...) is enough.
 */
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { FeedStore } from "./store.ts";
import {
  type FeedSnapshot,
  type Variant,
  renderRss,
  xmlEscape,
} from "./render.ts";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const PUBLISH_SECRET = process.env.PUBLISH_SECRET ?? "";
const RSS_USER = process.env.RSS_USER ?? "";
const RSS_PASS = process.env.RSS_PASS ?? "";
const MAX_BODY_BYTES = 32 * 1024 * 1024;

if (!PUBLISH_SECRET || !RSS_USER || !RSS_PASS) {
  process.stderr.write(
    "companion: PUBLISH_SECRET, RSS_USER and RSS_PASS must be set\n",
  );
  process.exit(1);
}

const store = new FeedStore(DATA_DIR);

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function checkBearer(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? safeEqual(m[1], PUBLISH_SECRET) : false;
}

function checkBasicAuth(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  const m = header.match(/^Basic\s+(.+)$/i);
  if (!m) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], "base64").toString("utf8");
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  // Evaluate both to keep timing independent of which half is wrong.
  const userOk = safeEqual(user, RSS_USER);
  const passOk = safeEqual(pass, RSS_PASS);
  return userOk && passOk;
}

function requireBasicAuth(res: http.ServerResponse): void {
  res.writeHead(401, {
    "www-authenticate": 'Basic realm="OwnTube", charset="UTF-8"',
    "content-type": "text/plain; charset=utf-8",
  });
  res.end("authentication required\n");
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isFeedSnapshot(v: unknown): v is FeedSnapshot {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.kind === "string" &&
    typeof f.slug === "string" &&
    typeof f.title === "string" &&
    typeof f.updatedAt === "number" &&
    Array.isArray(f.items)
  );
}

function selfUrl(req: http.IncomingMessage): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ||
    "https";
  const host = (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host || "";
  return `${proto}://${host}${req.url ?? ""}`;
}

function sendXml(res: http.ServerResponse, body: string, status = 200): void {
  res.writeHead(status, {
    "content-type": "application/rss+xml; charset=utf-8",
    "cache-control": "public, max-age=300",
  });
  res.end(body);
}

async function handlePublish(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!checkBearer(req)) {
    res.writeHead(401, { "content-type": "text/plain" });
    res.end("unauthorized\n");
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse((await readBody(req)).toString("utf8"));
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("invalid json\n");
    return;
  }
  const feeds = (payload as { feeds?: unknown })?.feeds;
  if (!Array.isArray(feeds) || !feeds.every(isFeedSnapshot)) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("expected { feeds: FeedSnapshot[] }\n");
    return;
  }
  const { upserted } = store.replaceAll(feeds as FeedSnapshot[]);
  const items = (feeds as FeedSnapshot[]).reduce((n, f) => n + f.items.length, 0);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, feeds: upserted, items }));
}

/** Parse `/rss/<kind>/<slug>.<variant>.xml`. */
function parseRssPath(
  pathname: string,
): { kind: string; slug: string; variant: Variant } | null {
  const m = pathname.match(/^\/rss\/([^/]+)\/(.+)\.(audio|video)\.xml$/);
  if (!m) return null;
  return {
    kind: decodeURIComponent(m[1]),
    slug: decodeURIComponent(m[2]),
    variant: m[3] as Variant,
  };
}

function feedUrl(kind: string, slug: string, variant: Variant): string {
  return `/rss/${encodeURIComponent(kind)}/${encodeURIComponent(slug)}.${variant}.xml`;
}

function renderIndexHtml(): string {
  const rows = store.list();
  const items = rows
    .map((r) => {
      const a = feedUrl(r.kind, r.slug, "audio");
      const v = feedUrl(r.kind, r.slug, "video");
      return `<li><strong>${xmlEscape(r.title)}</strong> <span class="kind">${xmlEscape(r.kind)}</span> · ${r.feed.items.length} items<br><a href="${a}">audio</a> · <a href="${v}">video</a></li>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>OwnTube feeds</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem}
h1{font-size:1.4rem}ul{list-style:none;padding:0}li{padding:.6rem 0;border-bottom:1px solid #8883}
.kind{font-size:.75rem;opacity:.6;text-transform:uppercase}a{margin-right:.3rem}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}</style></head>
<body><h1>OwnTube feeds</h1><p><a href="/opml.xml">OPML</a> · ${rows.length} feeds</p>
<ul>\n${items}\n</ul></body></html>\n`;
}

function renderOpml(req: http.IncomingMessage): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ||
    "https";
  const host = (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host || "";
  const base = `${proto}://${host}`;
  const outlines = store
    .list()
    .flatMap((r) =>
      (["audio", "video"] as Variant[]).map((variant) => {
        const url = `${base}${feedUrl(r.kind, r.slug, variant)}`;
        const text = `${r.title} (${variant})`;
        return `    <outline type="rss" text="${xmlEscape(text)}" title="${xmlEscape(text)}" xmlUrl="${xmlEscape(url)}"/>`;
      }),
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0"><head><title>OwnTube feeds</title></head>
<body>\n${outlines}\n</body></opml>\n`;
}

const server = http.createServer((req, res) => {
  void (async () => {
    const method = req.method ?? "GET";
    const pathname = (req.url ?? "/").split("?")[0];

    if (method === "GET" && pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok\n");
      return;
    }

    if (method === "POST" && pathname === "/publish") {
      await handlePublish(req, res);
      return;
    }

    // Everything below is Basic-Auth guarded.
    if (method === "GET" || method === "HEAD") {
      if (!checkBasicAuth(req)) {
        requireBasicAuth(res);
        return;
      }

      const rss = parseRssPath(pathname);
      if (rss) {
        const feed = store.get(rss.kind, rss.slug);
        if (!feed) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("feed not found\n");
          return;
        }
        sendXml(res, renderRss(feed, rss.variant, { selfUrl: selfUrl(req) }));
        return;
      }

      if (pathname === "/opml.xml") {
        res.writeHead(200, { "content-type": "text/x-opml; charset=utf-8" });
        res.end(renderOpml(req));
        return;
      }

      if (pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderIndexHtml());
        return;
      }
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  })().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`companion request failed: ${message}\n`);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("internal error\n");
  });
});

server.listen(PORT, () => {
  process.stdout.write(`companion listening on :${PORT} (data: ${DATA_DIR})\n`);
});
