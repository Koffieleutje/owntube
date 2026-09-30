import { randomBytes } from "node:crypto";

/**
 * Signed-out viewer identity: a random id in an httpOnly cookie, so per-viewer
 * state (seen shorts) lives server-side for everyone instead of the client
 * shipping ever-growing id lists with each request. Carries no personal data
 * and is only minted on a viewer's first write (see `ensureAnonViewerId`).
 */
export const ANON_VIEWER_COOKIE = "owntube_anon";

const ANON_VIEWER_MAX_AGE_SEC = 365 * 24 * 60 * 60;
const ANON_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * Per-request holder shared by every procedure in a tRPC batch, so a batch of
 * several first-time writes mints one id (and one Set-Cookie), not one each.
 */
export type AnonViewer = {
  id: string | null;
  resHeaders?: Headers;
  secure: boolean;
};

export function readAnonViewerId(req?: Request): string | null {
  const header = req?.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== ANON_VIEWER_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return ANON_ID_RE.test(value) ? value : null;
  }
  return null;
}

export function createAnonViewer(
  req?: Request,
  resHeaders?: Headers,
): AnonViewer {
  const proto =
    req?.headers.get("x-forwarded-proto") ??
    (req ? new URL(req.url).protocol.replace(":", "") : "http");
  return {
    id: readAnonViewerId(req),
    resHeaders,
    secure: proto === "https",
  };
}

/**
 * The viewer's anonymous id, minting one (and setting its cookie on the
 * response) if the request carried none. Null when there is no response to set
 * a cookie on (server-side callers).
 */
export function ensureAnonViewerId(anon: AnonViewer): string | null {
  if (anon.id) return anon.id;
  if (!anon.resHeaders) return null;
  const id = randomBytes(16).toString("base64url");
  anon.id = id;
  anon.resHeaders.append(
    "set-cookie",
    `${ANON_VIEWER_COOKIE}=${id}; Path=/; Max-Age=${ANON_VIEWER_MAX_AGE_SEC}; HttpOnly; SameSite=Lax${anon.secure ? "; Secure" : ""}`,
  );
  return id;
}
