import { Innertube, UniversalCache, Platform, type Types } from 'youtubei.js';
Platform.shim.eval = async (d: Types.BuildScriptResult, env: Record<string, Types.VMPrimative>) => {
  const p = [];
  if (env.n) p.push(`n: exportedVars.nFunction("${env.n}")`);
  if (env.sig) p.push(`sig: exportedVars.sigFunction("${env.sig}")`);
  return new Function(`${d.output}\nreturn { ${p.join(', ')} }`)();
};
const VIDEO = process.argv[2] ?? 'dQw4w9WgXcQ';
const clients = ['WEB', 'ANDROID', 'IOS', 'TV', 'WEB_EMBEDDED', 'MWEB', 'TV_EMBEDDED'];
const yt = await Innertube.create({ cache: new UniversalCache(true) });
for (const c of clients) {
  try {
    const info: any = await yt.getBasicInfo(VIDEO, c as any);
    const sd = info.streaming_data;
    console.log(
      `${c.padEnd(14)} adaptive=${String(sd?.adaptive_formats?.length ?? 0).padStart(3)}` +
      `  server_abr_url=${sd?.server_abr_streaming_url ? 'YES' : 'no '}` +
      `  ustreamer=${info.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config ? 'YES' : 'no'}`
    );
  } catch (e: any) { console.log(`${c.padEnd(14)} ERROR ${String(e.message).slice(0, 60)}`); }
}
