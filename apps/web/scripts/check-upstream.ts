/**
 * Upstream contract canary. Run from the canary Docker sidecar or manually via
 * `pnpm check:upstream`. Exits non-zero if any check fails, so any scheduler
 * surfaces it.
 *
 * Every assertion here corresponds to a regression that actually happened and
 * went unnoticed:
 *
 *  - `provenance`  Invidious was rebuilt from plain upstream master on
 *                  2026-07-23, silently dropping all local patches. Captions
 *                  stayed broken for a week because nothing looked. Invidious
 *                  embeds the git branch at build time, so this one assertion
 *                  catches *any* lost patch rather than one symptom at a time.
 *  - `captions`    the patch above; also the Google timedtext IP block, which
 *                  returns a "Sorry…" HTML page as HTTP 200 text/vtt.
 *  - `byteRanges`  `adaptiveFormats[].init`/`.index` are what the synthesized
 *                  HLS/DASH manifests are built from; without them /hls and
 *                  /dash 502 and playback silently falls back.
 *  - `listLiveFlag` the trending serializer reported `liveNow: false` for every
 *                  item while the detail endpoint said `liveNow: true` for the
 *                  same ids. Root cause: YouTube stopped putting a "LIVE" entry
 *                  in `videoRenderer.badges`, moving it to the thumbnail's
 *                  time-status overlay, which Invidious did not read. Fixed on
 *                  the fork; this check keeps it fixed.
 *  - `shortsFlag`   `isShort` on list items is a fork patch (Phase 3.3). Shorts
 *                  cannot be identified any other way: YouTube stopped
 *                  reporting a real duration for them and the parsers
 *                  substitute an approximate 60s, so length cannot separate a
 *                  Short from a genuine 60-second upload.
 *  - `sabrExposure` the share of *non-live* videos that no longer carry
 *                  `init`/`index` byte ranges. YouTube is migrating to SABR,
 *                  which addresses media by player time rather than byte range;
 *                  an SABR-only video cannot back OwnTube's synthesized DASH/HLS
 *                  at all. This is an early-warning counter, not a defect: at
 *                  the time of writing it is 0%. When it starts climbing there
 *                  is lead time to act instead of discovering it as broken
 *                  playback. See docs/OWNTUBE-UPSTREAM-PLAN.md stage 7.
 *  - `listDuration` that *non-live* list items carry a real duration. It only
 *                  covers non-live items on purpose — trending is the
 *                  livestreams feed now, and `lengthSeconds: 0` is correct for
 *                  a stream.
 *  - `videoStreams` the blunt "is extraction working at all" check; YouTube
 *                  breakage (hotfixes #5818/#5819) killed this outright.
 *  - `audioTracks` `adaptiveFormats[].audioTrack` is a fork patch (Phase 3.1).
 *                  Without it OwnTube cannot tell one audio language from
 *                  another, and the URL-scraping it used to fall back on has
 *                  been deleted — so losing this field is silent and total.
 *
 * Deliberately talks to the upstreams over HTTP rather than importing the proxy
 * layer: the point is to observe what Invidious/companion actually return, not
 * what OwnTube makes of it.
 */

const INVIDIOUS_BASE = (
  process.env.INVIDIOUS_BASE_URL ?? "http://invidious:3000"
).replace(/\/+$/, "");

/**
 * Branch the deployed Invidious image must report. See the Invidious fork
 * workflow: images are built only from `nedworks/integration` via
 * `nedworks-rebuild.sh`; anything else means the local patches are missing.
 * Set empty to skip (e.g. when running against a stock upstream instance).
 */
const EXPECTED_BRANCH =
  process.env.INVIDIOUS_EXPECTED_BRANCH ?? "nedworks/integration";

/** A stable, long-standing video with captions and adaptive formats. */
const PROBE_VIDEO_ID = process.env.UPSTREAM_CHECK_VIDEO_ID ?? "haxkWC6MgcQ";

/**
 * A video with many dubbed audio tracks, for the `audioTracks` check. Needs to
 * be a separate probe: the main one is single-audio and legitimately carries no
 * `audioTrack` at all.
 */
const MULTI_AUDIO_VIDEO_ID =
  process.env.UPSTREAM_CHECK_MULTI_AUDIO_VIDEO_ID ?? "0e3GPea1Tyg";

/**
 * A channel with a populated Shorts tab, for the `shortsFlag` check. MrBeast:
 * high-volume and long-lived, so the tab is unlikely to empty out.
 */
const SHORTS_CHANNEL_ID =
  process.env.UPSTREAM_CHECK_SHORTS_CHANNEL_ID ?? "UCX6OQ3DkcsbYNE6H8uQQuVA";

const TREND_REGION = process.env.UPSTREAM_CHECK_REGION ?? "NL";

/** How many trending items to cross-check against the detail endpoint. */
const SAMPLE_SIZE = Number(process.env.UPSTREAM_CHECK_SAMPLE_SIZE ?? "6");

/**
 * Share of non-live videos allowed to lack byte ranges before `sabrExposure`
 * fails. Not zero: a single video with incomplete extraction should not page
 * anyone. Measured 0/23 on 2026-07-30, so anything approaching this threshold is
 * a real trend rather than noise.
 */
const SABR_EXPOSURE_FAIL_RATIO = Number(
  process.env.UPSTREAM_CHECK_SABR_FAIL_RATIO ?? "0.25",
);

const TIMEOUT_MS = 20_000;

/**
 * Checks that are known to be broken upstream and not yet fixed. They still run
 * and still report, but as `KNOWN` rather than `FAIL`, so the run's exit code
 * stays meaningful for *new* regressions — an alarm that is red from day one is
 * an alarm nobody reads. Removing an entry here is how a fix gets locked in.
 *
 * Currently acknowledged: none. `listDuration` used to be listed here on the
 * belief that the list serializer dropped `lengthSeconds`. That was a
 * misdiagnosis — see Phase 3.2 in docs/INVIDIOUS-BOUNDARY-PLAN.md. Durations
 * were fine; the real defect was `liveNow`, and the old check failed only
 * because trending is now a livestreams feed where a zero duration is correct.
 */
const KNOWN_FAILING = new Set(
  (process.env.UPSTREAM_CHECK_KNOWN_FAILING ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

type Result = {
  name: string;
  ok: boolean;
  detail: string;
  /** Skipped checks are reported but never fail the run. */
  skipped?: boolean;
};

async function getJson(path: string): Promise<unknown> {
  const r = await fetch(`${INVIDIOUS_BASE}${path}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function checkProvenance(): Promise<Result> {
  if (!EXPECTED_BRANCH) {
    return {
      name: "provenance",
      ok: true,
      skipped: true,
      detail: "INVIDIOUS_EXPECTED_BRANCH empty — not checking build provenance",
    };
  }
  const stats = (await getJson("/api/v1/stats")) as {
    software?: { branch?: string; version?: string };
  };
  const branch = stats.software?.branch ?? "(none)";
  const version = stats.software?.version ?? "(none)";
  return {
    name: "provenance",
    ok: branch === EXPECTED_BRANCH,
    detail:
      branch === EXPECTED_BRANCH
        ? `branch=${branch} version=${version}`
        : `branch=${branch} (expected ${EXPECTED_BRANCH}) version=${version} — image built from the wrong tree; local patches are MISSING`,
  };
}

/** A good VTT starts with WEBVTT and has at least one cue timing. */
function looksLikeUsableVtt(body: string): boolean {
  const t = body.trimStart();
  return t.toUpperCase().startsWith("WEBVTT") && t.includes("-->");
}

async function checkCaptions(): Promise<Result> {
  const listed = (await getJson(
    `/api/v1/captions/${encodeURIComponent(PROBE_VIDEO_ID)}`,
  )) as { captions?: { label?: string }[] };
  const label = listed.captions?.[0]?.label;
  if (!label) {
    return {
      name: "captions",
      ok: false,
      detail: `no caption tracks listed for ${PROBE_VIDEO_ID}`,
    };
  }
  const url = `${INVIDIOUS_BASE}/api/v1/captions/${encodeURIComponent(
    PROBE_VIDEO_ID,
  )}?label=${encodeURIComponent(label)}`;

  // A redirect means the companion patch is in place (the companion holds a
  // po_token and isn't IP-blocked). Following it and validating the body covers
  // the non-patched case too, so this passes either way when captions work.
  const head = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const redirected = head.status >= 300 && head.status < 400;
  await head.body?.cancel?.();

  const full = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = full.ok ? await full.text() : "";
  const usable = looksLikeUsableVtt(body);
  const cues = usable ? (body.match(/-->/g) ?? []).length : 0;
  return {
    name: "captions",
    ok: usable,
    detail: usable
      ? `'${label}' ${cues} cues, ${redirected ? "via companion redirect" : "served by Invidious directly"}`
      : `'${label}' unusable (HTTP ${full.status}, ${body.length}b, redirect=${redirected}) — Google timedtext block or the companion patch is gone`,
  };
}

async function checkVideoStreamsAndByteRanges(): Promise<Result[]> {
  const v = (await getJson(
    `/api/v1/videos/${encodeURIComponent(PROBE_VIDEO_ID)}`,
  )) as {
    title?: string;
    adaptiveFormats?: { type?: string; init?: string; index?: string }[];
  };
  const formats = v.adaptiveFormats ?? [];
  const streams: Result = {
    name: "videoStreams",
    ok: formats.length > 0 && Boolean(v.title),
    detail:
      formats.length > 0
        ? `${formats.length} adaptive formats, title present`
        : "no adaptive formats — extraction is broken",
  };

  const indexed = formats.filter((f) => f.init && f.index);
  const audioIndexed = indexed.filter((f) =>
    (f.type ?? "").toLowerCase().startsWith("audio/"),
  ).length;
  const videoIndexed = indexed.length - audioIndexed;
  return [
    streams,
    {
      name: "byteRanges",
      ok: audioIndexed > 0 && videoIndexed > 0,
      detail:
        audioIndexed > 0 && videoIndexed > 0
          ? `${videoIndexed} video + ${audioIndexed} audio formats carry init+index`
          : `only ${videoIndexed} video / ${audioIndexed} audio carry init+index — /hls and /dash will 502`,
    },
  ];
}

/**
 * `adaptiveFormats[].audioTrack` — the Phase 3.1 fork patch. Invidious parses
 * this for its own DASH manifest but upstream still does not serialise it, so
 * this check is really a provenance check with teeth: it fails if the patch is
 * lost *or* if YouTube stops supplying the data.
 *
 * Asserts more than presence. A multi-language video must yield at least two
 * distinct track ids (one id for every track would mean the tracks are
 * indistinguishable, which is the state this patch existed to fix) and exactly
 * one track flagged as the original.
 */
async function checkAudioTracks(): Promise<Result> {
  const v = (await getJson(
    `/api/v1/videos/${encodeURIComponent(MULTI_AUDIO_VIDEO_ID)}`,
  )) as {
    adaptiveFormats?: {
      type?: string;
      audioTrack?: {
        id?: string;
        displayName?: string;
        audioIsDefault?: boolean;
      };
    }[];
  };
  const audio = (v.adaptiveFormats ?? []).filter((f) =>
    (f.type ?? "").toLowerCase().startsWith("audio/"),
  );
  const tracks = audio.map((f) => f.audioTrack).filter(Boolean);
  const ids = new Set(tracks.map((t) => t?.id).filter(Boolean));
  const named = tracks.filter((t) => t?.displayName).length;
  const originals = new Set(
    audio
      .filter((f) => f.audioTrack?.audioIsDefault)
      .map((f) => f.audioTrack?.id),
  );

  if (tracks.length === 0) {
    return {
      name: "audioTracks",
      ok: false,
      detail:
        `${MULTI_AUDIO_VIDEO_ID}: none of ${audio.length} audio formats carry ` +
        "audioTrack — the fork patch is missing, or the video lost its dubs",
    };
  }
  const ok = ids.size >= 2 && named === tracks.length && originals.size === 1;
  return {
    name: "audioTracks",
    ok,
    detail: ok
      ? `${ids.size} distinct audio tracks, all named, 1 flagged original`
      : `${ids.size} distinct ids / ${named} of ${tracks.length} named / ` +
        `${originals.size} flagged original — expected >=2 ids, all named, exactly 1 original`,
  };
}

/**
 * `isShort` on list items — the Phase 3.3 fork patch. Checked against a
 * channel's Shorts tab, where every item is a Short by construction, so the
 * expected answer is unambiguous: all of them flagged.
 *
 * Deliberately not satisfied by the duration: those items all report the
 * approximate 60s the parser substitutes, which is exactly the signal this
 * field exists to replace.
 */
async function checkShortsFlag(): Promise<Result> {
  const page = (await getJson(
    `/api/v1/channels/${encodeURIComponent(SHORTS_CHANNEL_ID)}/shorts`,
  )) as { videos?: { videoId?: string; isShort?: boolean }[] };
  const videos = page.videos ?? [];
  if (videos.length === 0) {
    return {
      name: "shortsFlag",
      ok: false,
      skipped: true,
      detail: `${SHORTS_CHANNEL_ID} returned no shorts — cannot tell a lost patch from an empty tab`,
    };
  }
  const flagged = videos.filter((v) => v.isShort === true).length;
  const ok = flagged === videos.length;
  return {
    name: "shortsFlag",
    ok,
    detail: ok
      ? `all ${videos.length} items on the shorts tab are flagged isShort`
      : `only ${flagged}/${videos.length} shorts-tab items are flagged isShort — the fork patch is missing or the parser changed`,
  };
}

/**
 * How many non-live videos have stopped carrying `init`/`index` byte ranges.
 *
 * OwnTube synthesizes its own DASH and HLS from those ranges, so a video without
 * them cannot be played by the current architecture — `/dash` and `/hls` 502 and
 * playback falls back. YouTube's SABR rollout is the reason this would change,
 * since SABR addresses media by player time instead.
 *
 * Live streams are excluded because they are legitimately segment-addressed and
 * never carry byte ranges; counting them would peg this at ~100% and tell us
 * nothing. That exclusion depends on `liveNow` being correct on list items,
 * which is what `listLiveFlag` guards.
 */
async function checkSabrExposure(): Promise<Result> {
  // Deliberately NOT trending: trending is the livestreams feed since YouTube
  // removed the aggregated trending page, so it is ~100% live and yields no
  // measurable sample. `popular` is broad VOD; the channel uploads tab tops it
  // up if an instance has popular disabled.
  const popular = (await getJson("/api/v1/popular").catch(() => [])) as {
    videoId?: string;
  }[];
  const ids = (Array.isArray(popular) ? popular : [])
    .map((v) => v.videoId)
    .filter((id): id is string => Boolean(id));

  if (ids.length < SAMPLE_SIZE) {
    const page = (await getJson(
      `/api/v1/channels/${encodeURIComponent(SHORTS_CHANNEL_ID)}/videos`,
    ).catch(() => ({}))) as { videos?: { videoId?: string }[] };
    for (const v of page.videos ?? []) {
      if (v.videoId && !ids.includes(v.videoId)) ids.push(v.videoId);
    }
  }
  ids.splice(SAMPLE_SIZE * 2);

  let nonLive = 0;
  let withoutRanges = 0;
  const bare: string[] = [];
  for (const id of ids) {
    const detail = (await getJson(
      `/api/v1/videos/${encodeURIComponent(id)}`,
    ).catch(() => null)) as {
      liveNow?: boolean;
      adaptiveFormats?: { init?: string; index?: string }[];
    } | null;
    if (!detail || detail.liveNow === true) continue;
    const formats = detail.adaptiveFormats ?? [];
    if (formats.length === 0) continue;
    nonLive++;
    if (!formats.some((f) => f.init && f.index)) {
      withoutRanges++;
      bare.push(id);
    }
  }

  if (nonLive === 0) {
    return {
      name: "sabrExposure",
      ok: true,
      skipped: true,
      detail:
        "no non-live videos in the sample — cannot measure byte-range availability",
    };
  }
  const ratio = withoutRanges / nonLive;
  return {
    name: "sabrExposure",
    ok: ratio <= SABR_EXPOSURE_FAIL_RATIO,
    detail:
      withoutRanges === 0
        ? `0/${nonLive} non-live videos lack byte ranges — no SABR exposure`
        : `${withoutRanges}/${nonLive} non-live videos lack byte ranges (${Math.round(ratio * 100)}%)${
            ratio > SABR_EXPOSURE_FAIL_RATIO
              ? " — SABR migration is reaching us; see OWNTUBE-UPSTREAM-PLAN.md stage 7"
              : ""
          }: ${bare.slice(0, 3).join(", ")}`,
  };
}

/**
 * Trending list items, checked against the detail endpoint for the same ids.
 *
 * Two distinct assertions, deliberately separated because they used to be
 * conflated into one that measured the wrong thing:
 *
 *  - `listLiveFlag` — a list item's `liveNow` must agree with `/api/v1/videos`
 *    for the same id. Disagreement is the real, previously-missed defect.
 *  - `listDuration` — only *non-live* items must carry a duration. Trending is
 *    the livestreams feed since YouTube removed the aggregated trending page, so
 *    `lengthSeconds: 0` on a live item is correct, not a regression. The old
 *    check required a majority of *all* items to have a duration and so failed
 *    permanently for a reason that was never a bug.
 */
async function checkTrendingListItems(): Promise<Result[]> {
  const list = (await getJson(`/api/v1/trending?region=${TREND_REGION}`)) as {
    videoId?: string;
    lengthSeconds?: number;
    liveNow?: boolean;
  }[];
  if (!Array.isArray(list) || list.length === 0) {
    const detail = `trending returned no items for region ${TREND_REGION}`;
    return [
      { name: "listLiveFlag", ok: false, detail },
      { name: "listDuration", ok: false, detail },
    ];
  }

  // Sampled rather than exhaustive: one detail fetch per item is slow, and a
  // systematic flag bug shows up in any sample.
  const sample = list.filter((v) => v.videoId).slice(0, SAMPLE_SIZE);
  const compared: { live: boolean; listLive: boolean; len: number }[] = [];
  for (const item of sample) {
    const detail = (await getJson(
      `/api/v1/videos/${encodeURIComponent(item.videoId as string)}`,
    ).catch(() => null)) as { liveNow?: boolean } | null;
    if (!detail) continue;
    compared.push({
      live: detail.liveNow === true,
      listLive: item.liveNow === true,
      len: typeof item.lengthSeconds === "number" ? item.lengthSeconds : 0,
    });
  }

  const disagree = compared.filter((c) => c.live !== c.listLive).length;
  const liveFlag: Result = {
    name: "listLiveFlag",
    ok: compared.length > 0 && disagree === 0,
    detail:
      compared.length === 0
        ? "no trending item could be cross-checked against the detail endpoint"
        : disagree === 0
          ? `${compared.length} sampled items agree with the detail endpoint on liveNow`
          : `${disagree}/${compared.length} sampled items disagree with the detail endpoint on liveNow — the list serializer is losing the live flag`,
  };

  const nonLive = compared.filter((c) => !c.live);
  const withDuration = nonLive.filter((c) => c.len > 0).length;
  const duration: Result =
    nonLive.length === 0
      ? {
          name: "listDuration",
          ok: true,
          skipped: true,
          detail: `all ${compared.length} sampled trending items are live, so there is no non-live duration to check`,
        }
      : {
          name: "listDuration",
          ok: withDuration === nonLive.length,
          detail:
            withDuration === nonLive.length
              ? `${withDuration}/${nonLive.length} non-live trending items carry a duration`
              : `only ${withDuration}/${nonLive.length} non-live trending items have a duration — the list serializer is dropping lengthSeconds`,
        };

  return [liveFlag, duration];
}

async function run(): Promise<void> {
  /**
   * Names are declared, not derived from the function identifier: a thrown check
   * must report the same name as a returned one, or `KNOWN_FAILING` silently
   * stops matching exactly when things are broken. One entry may cover several
   * results (`videoStreams` + `byteRanges` share a fetch).
   */
  const checks: {
    names: string[];
    run: () => Promise<Result | Result[]>;
  }[] = [
    { names: ["provenance"], run: checkProvenance },
    { names: ["captions"], run: checkCaptions },
    {
      names: ["videoStreams", "byteRanges"],
      run: checkVideoStreamsAndByteRanges,
    },
    { names: ["audioTracks"], run: checkAudioTracks },
    { names: ["shortsFlag"], run: checkShortsFlag },
    { names: ["sabrExposure"], run: checkSabrExposure },
    {
      names: ["listLiveFlag", "listDuration"],
      run: checkTrendingListItems,
    },
  ];

  const results: Result[] = [];
  for (const check of checks) {
    try {
      const r = await check.run();
      results.push(...(Array.isArray(r) ? r : [r]));
    } catch (e) {
      const message = (e as Error).message;
      for (const name of check.names) {
        results.push({ name, ok: false, detail: `threw: ${message}` });
      }
    }
  }

  console.log(`upstream check against ${INVIDIOUS_BASE}`);
  for (const r of results) {
    const known = !r.ok && !r.skipped && KNOWN_FAILING.has(r.name);
    const tag = r.skipped ? "SKIP" : r.ok ? "PASS" : known ? "KNOWN" : "FAIL";
    console.log(`  [${tag.padEnd(5)}] ${r.name.padEnd(14)} ${r.detail}`);
  }

  // A check listed as known-failing that starts passing is worth surfacing —
  // it means the upstream fix landed and the entry should be removed so the
  // regression can't come back unnoticed.
  const fixed = results.filter((r) => r.ok && KNOWN_FAILING.has(r.name));
  for (const r of fixed) {
    console.log(
      `\nNOTE: '${r.name}' is listed as known-failing but PASSED — remove it from UPSTREAM_CHECK_KNOWN_FAILING to lock the fix in.`,
    );
  }

  const failed = results.filter(
    (r) => !r.ok && !r.skipped && !KNOWN_FAILING.has(r.name),
  );
  const acknowledged = results.filter(
    (r) => !r.ok && !r.skipped && KNOWN_FAILING.has(r.name),
  );
  if (failed.length > 0) {
    console.error(
      `\n${failed.length} upstream check(s) FAILED: ${failed
        .map((f) => f.name)
        .join(", ")}`,
    );
    process.exit(1);
  }
  console.log(
    acknowledged.length > 0
      ? `\nall upstream checks passed (${acknowledged.length} known-failing: ${acknowledged
          .map((f) => f.name)
          .join(", ")})`
      : "\nall upstream checks passed",
  );
}

run().catch((e) => {
  console.error("upstream check crashed:", e);
  process.exit(1);
});
