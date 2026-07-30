/**
 * Does the manifest's SegmentTimeline actually agree with the media?
 *
 * Non-uniform fragments are only "handled" if a player following the manifest
 * lands on the right bytes. So: walk the SegmentTimeline, compute each segment's
 * expected start time, then read the real `tfdt` baseMediaDecodeTime out of the
 * segment file on disk and compare. Any drift means seeks would land wrong.
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

function tfdt(buf: Buffer): number | undefined {
  const i = buf.indexOf('tfdt', 0, 'latin1');
  if (i < 0) return undefined;
  const version = buf.readUInt8(i + 4);
  const off = i + 8;
  if (version === 1) return Number(buf.readBigUInt64BE(off));
  return buf.readUInt32BE(off);
}

const doc = new JSDOM(fs.readFileSync('dash-out/manifest.mpd', 'utf8'), {
  contentType: 'text/xml',
}).window.document;

let allOk = true;
for (const set of [...doc.querySelectorAll('AdaptationSet')]) {
  const tpl = set.querySelector('SegmentTemplate')!;
  const timescale = Number(tpl.getAttribute('timescale'));
  const media = tpl.getAttribute('media')!;
  const kind = set.getAttribute('mimeType')!.split('/')[0];

  // Expand <S d= r=> into a flat duration list, exactly as a player would.
  const durations: number[] = [];
  for (const s of [...set.querySelectorAll('S')]) {
    const d = Number(s.getAttribute('d'));
    const r = Number(s.getAttribute('r') ?? 0);
    for (let i = 0; i <= r; i++) durations.push(d);
  }

  let expected = 0;
  let mismatches = 0;
  let checked = 0;
  const uniq = new Set(durations);
  for (let i = 0; i < durations.length; i++) {
    const file = 'dash-out/' + media.replace('$Number$', String(i + 1));
    if (!fs.existsSync(file)) continue;
    const actual = tfdt(fs.readFileSync(file));
    checked++;
    if (actual !== expected) {
      mismatches++;
      if (mismatches <= 3)
        console.log(`   seg ${i + 1}: manifest says ${expected}, media says ${actual} (drift ${actual! - expected})`);
    }
    expected += durations[i];
  }
  const totalSec = durations.reduce((a, b) => a + b, 0) / timescale;
  console.log(
    `${kind}: ${checked} segments checked, ${mismatches} mismatches | ` +
      `distinct durations=${uniq.size} (${uniq.size === 1 ? 'uniform' : 'NON-UNIFORM'}) | ` +
      `timeline total=${totalSec.toFixed(2)}s`,
  );
  if (mismatches) allOk = false;
}
console.log(allOk ? '\nTIMELINE EXACT: every segment start matches its media decode time' : '\nDRIFT DETECTED');
