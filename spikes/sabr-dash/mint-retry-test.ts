/**
 * Is attestation flaky rather than refused?
 *
 * invidious-companion wraps its minting in a retry with backoff, so a single
 * null integrity token proves nothing. Try repeatedly from a fresh session each
 * time and count.
 */
import { Innertube, USER_AGENT_UNUSED } from 'youtubei.js';
import { BG, GOOG_API_KEY, USER_AGENT, buildURL } from 'bgutils-js';
import { JSDOM } from 'jsdom';

const ATTEMPTS = parseInt(process.env.ATTEMPTS ?? '6');
let ok = 0;

for (let i = 1; i <= ATTEMPTS; i++) {
  try {
    const innertube = await Innertube.create({
      enable_session_cache: false,
      retrieve_player: false,
      user_agent: USER_AGENT,
    });
    const visitorData = innertube.session.context.client.visitorData!;

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
    const url = challenge.bg_challenge!.interpreter_url
      .private_do_not_access_or_else_trusted_resource_url_wrapped_value;
    new Function(await (await fetch(`https:${url}`)).text())();

    const botguard = await BG.BotGuardClient.create({
      program: challenge.bg_challenge!.program,
      globalName: challenge.bg_challenge!.global_name,
      globalObj: globalThis,
    });
    const webPoSignalOutput: any[] = [];
    const snapshot = await botguard.snapshot({ webPoSignalOutput });

    const res = await fetch(buildURL('GenerateIT', true), {
      method: 'POST',
      headers: {
        'content-type': 'application/json+protobuf',
        'x-goog-api-key': GOOG_API_KEY,
        'x-user-agent': 'grpc-web-javascript/0.1',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(['O43z0dpjhgX20SCx4KAo', snapshot]),
    });
    const body: any = await res.json();

    if (body[0]) {
      ok++;
      const minter = await BG.WebPoMinter.create({ integrityToken: body[0] }, webPoSignalOutput);
      console.log(`attempt ${i}: ACCEPTED (integrityToken len ${String(body[0]).length})`);
      console.log(`  VISITOR_DATA=${visitorData}`);
      console.log(`  SESSION_POTOKEN=${await minter.mintAsWebsafeString(visitorData)}`);
      break;
    }
    console.log(`attempt ${i}: rejected (null integrity token)`);
  } catch (e: any) {
    console.log(`attempt ${i}: error ${e?.message ?? e}`);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(`\n${ok}/${ATTEMPTS} accepted`);
