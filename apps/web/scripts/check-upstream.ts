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
 *  - `listDuration` the trending serializer reported `lengthSeconds: 0` and
 *                  `liveNow: false` for every item while the detail endpoint
 *                  disagreed, which is why Shorts detection still leans on a
 *                  `#shorts` title heuristic.
 *  - `videoStreams` the blunt "is extraction working at all" check; YouTube
 *                  breakage (hotfixes #5818/#5819) killed this outright.
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

const TREND_REGION = process.env.UPSTREAM_CHECK_REGION ?? "NL";

const TIMEOUT_MS = 20_000;

/**
 * Checks that are known to be broken upstream and not yet fixed. They still run
 * and still report, but as `KNOWN` rather than `FAIL`, so the run's exit code
 * stays meaningful for *new* regressions — an alarm that is red from day one is
 * an alarm nobody reads. Removing an entry here is how a fix gets locked in.
 *
 * Currently acknowledged:
 *   listDuration — the trending list serializer drops `lengthSeconds` (and
 *   reports `liveNow: false` for live items, contradicting the detail endpoint).
 *   Tracked as Phase 3.2 in docs/INVIDIOUS-BOUNDARY-PLAN.md.
 */
const KNOWN_FAILING = new Set(
  (process.env.UPSTREAM_CHECK_KNOWN_FAILING ?? "listDuration")
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

async function checkListDurations(): Promise<Result> {
  const list = (await getJson(`/api/v1/trending?region=${TREND_REGION}`)) as {
    videoId?: string;
    lengthSeconds?: number;
  }[];
  if (!Array.isArray(list) || list.length === 0) {
    return {
      name: "listDuration",
      ok: false,
      detail: `trending returned no items for region ${TREND_REGION}`,
    };
  }
  const withDuration = list.filter(
    (v) => typeof v.lengthSeconds === "number" && v.lengthSeconds > 0,
  ).length;
  // Live items legitimately have no duration, so require a majority rather than
  // all — the observed failure was 0 of 15.
  const ok = withDuration > list.length / 2;
  return {
    name: "listDuration",
    ok,
    detail: ok
      ? `${withDuration}/${list.length} trending items have a real duration`
      : `only ${withDuration}/${list.length} trending items have a duration — list serializer is dropping lengthSeconds, so Shorts detection falls back to the '#shorts' title heuristic`,
  };
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
    { names: ["listDuration"], run: checkListDurations },
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
