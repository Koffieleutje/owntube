/**
 * po_token minting, following invidious-companion — the implementation on this
 * host whose tokens YouTube actually accepts.
 *
 * Three things differ from the naive `BG.PoToken.generate()` approach the spike
 * used first, and all three look load-bearing:
 *
 *  - **The DOM has an origin.** BotGuard is attesting a browser. A bare `new
 *    JSDOM()` is `about:blank` with a jsdom user agent; the challenge is issued
 *    to a page claiming to be youtube.com, so that is what it must look like.
 *  - **The challenge comes from Innertube**, via `getAttestationChallenge`,
 *    rather than from BotGuard's own endpoint.
 *  - **One minter, two tokens.** YouTube binds tokens either to the session
 *    (visitorData) or to a single video, and the two are used in different
 *    places: the content token attests the `player` request, the session token
 *    attests streaming.
 */
import { JSDOM } from 'jsdom';
import { BG, GOOG_API_KEY, USER_AGENT, buildURL } from 'bgutils-js';
import type { Innertube } from 'youtubei.js';

export interface Minter {
  visitorData: string;
  /** Bind to a videoId for player requests, or to visitorData for streaming. */
  mint(binding: string): Promise<string>;
}

export async function createMinter(innertube: Innertube): Promise<Minter> {
  const visitorData = innertube.session.context.client.visitorData;
  if (!visitorData) throw new Error('no visitorData');

  const dom = new JSDOM(
    '<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>',
    { url: 'https://www.youtube.com/', referrer: 'https://www.youtube.com/', userAgent: USER_AGENT },
  );

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    origin: dom.window.origin,
  });
  if (!Reflect.has(globalThis, 'navigator')) {
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator });
  }

  const challenge = await innertube.getAttestationChallenge('ENGAGEMENT_TYPE_UNBOUND');
  if (!challenge.bg_challenge) throw new Error('no attestation challenge');

  const interpreterUrl =
    challenge.bg_challenge.interpreter_url
      .private_do_not_access_or_else_trusted_resource_url_wrapped_value;
  const vm = await (await fetch(`https:${interpreterUrl}`)).text();
  if (!vm) throw new Error('could not load BotGuard VM');
  new Function(vm)();

  const botguard = await BG.BotGuardClient.create({
    program: challenge.bg_challenge.program,
    globalName: challenge.bg_challenge.global_name,
    globalObj: globalThis,
  });

  const webPoSignalOutput: any[] = [];
  const botguardResponse = await botguard.snapshot({ webPoSignalOutput });

  const res = await fetch(buildURL('GenerateIT', true), {
    method: 'POST',
    headers: {
      'content-type': 'application/json+protobuf',
      'x-goog-api-key': GOOG_API_KEY,
      'x-user-agent': 'grpc-web-javascript/0.1',
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify(['O43z0dpjhgX20SCx4KAo', botguardResponse]),
  });
  const integrityToken = (await res.json()) as any[];
  if (process.env.MINT_DEBUG) {
    console.log('[mint] GenerateIT status', res.status, JSON.stringify(integrityToken).slice(0, 300));
  }

  const minter = await BG.WebPoMinter.create(
    { integrityToken: integrityToken[0] },
    webPoSignalOutput,
  );

  return { visitorData, mint: (binding: string) => minter.mintAsWebsafeString(binding) };
}
