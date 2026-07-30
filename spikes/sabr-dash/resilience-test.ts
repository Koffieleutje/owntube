import { pull } from './resilient.js';

const VIDEO = process.argv[2] ?? 'dQw4w9WgXcQ';
const line = (s: string) => console.log(s);

async function seekTest() {
  line('\n== seek: can a converter start mid-video instead of pulling everything?');
  for (const atMs of [0, 60_000, 150_000]) {
    const r = await pull({ videoId: VIDEO, maxSegments: 2, startAtMs: atMs || undefined, quiet: true });
    const got = r.firstDecodeTimeSec;
    const want = atMs / 1000;
    const ok = r.ok && got !== undefined && Math.abs(got - want) < 12;
    line(
      `   start=${String(want).padStart(5)}s -> first segment at ${got?.toFixed(1) ?? 'n/a'}s ` +
        `${ok ? 'OK' : 'MISS'}  (${r.segments.length} segs, ${r.attemptsUsed} attempt(s), ${r.wallMs}ms)`,
    );
  }
}

async function repeatTest(n: number) {
  line(`\n== repeat: ${n} sequential pulls, 1 attempt each (no retry) — raw flakiness`);
  let ok = 0;
  const errs: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await pull({ videoId: VIDEO, maxSegments: 2, attempts: 1, quiet: true });
    if (r.ok) ok++;
    else errs.push(r.errors.join('; '));
    process.stdout.write(r.ok ? '.' : 'X');
  }
  line(`\n   ${ok}/${n} succeeded`);
  for (const e of [...new Set(errs)].slice(0, 3)) line(`   failure: ${e}`);
  return { ok, n };
}

async function retryTest(n: number) {
  line(`\n== same, but with retry+backoff (3 attempts) — does resilience help?`);
  let ok = 0;
  let retried = 0;
  for (let i = 0; i < n; i++) {
    const r = await pull({ videoId: VIDEO, maxSegments: 2, attempts: 3, quiet: true });
    if (r.ok) ok++;
    if (r.attemptsUsed > 1) retried++;
    process.stdout.write(r.ok ? (r.attemptsUsed > 1 ? 'r' : '.') : 'X');
  }
  line(`\n   ${ok}/${n} succeeded, ${retried} needed a retry`);
}

async function concurrencyTest(n: number) {
  line(`\n== concurrency: ${n} simultaneous sessions`);
  const t0 = Date.now();
  const rs = await Promise.all(
    Array.from({ length: n }, () => pull({ videoId: VIDEO, maxSegments: 2, attempts: 2, quiet: true })),
  );
  const ok = rs.filter((r) => r.ok).length;
  const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);
  line(`   ${ok}/${n} succeeded in ${Date.now() - t0}ms, RSS ${mem}MB`);
  const stalls = rs.reduce((a, r) => a + r.stalls, 0);
  const reloads = rs.reduce((a, r) => a + r.reloads, 0);
  line(`   stalls=${stalls} reloads=${reloads}`);
}

async function stallWatchdogTest() {
  line('\n== watchdog: an impossibly short stall timeout must abort, not hang');
  const t0 = Date.now();
  const r = await pull({ videoId: VIDEO, maxSegments: 50, stallMs: 1, attempts: 1, quiet: true });
  line(
    `   ok=${r.ok} stalls=${r.stalls} wall=${Date.now() - t0}ms ` +
      `err=${r.errors[0]?.slice(0, 60) ?? 'none'}`,
  );
}

await seekTest();
await repeatTest(6);
await retryTest(6);
await concurrencyTest(4);
await stallWatchdogTest();
