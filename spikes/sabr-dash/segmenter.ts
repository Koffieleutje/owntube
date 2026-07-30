import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cuts a fragmented-MP4 byte stream into DASH-servable pieces.
 *
 * SABR delivers fMP4: a header (`ftyp` + `moov`, which carries `mvex` and so is
 * an init segment by construction) followed by repeating `moof` + `mdat` pairs.
 * That maps directly onto DASH `SegmentTemplate`: the header becomes
 * `initialization`, each `moof`+`mdat` pair becomes one numbered `media` segment.
 *
 * This is the whole trick the converter rests on, so it is deliberately dumb:
 * walk boxes, split on the boundaries, write files. No re-muxing, no transcode.
 */
export interface SegmentInfo {
  number: number;
  bytes: number;
  baseMediaDecodeTime?: number;
}

export interface SegmentResult {
  initBytes: number;
  segments: SegmentInfo[];
  /** Box types seen, in order of first appearance — for diagnosis. */
  boxOrder: string[];
  timescale?: number;
}

/** Read a 4-byte big-endian size + 4-char type at `off`, or null if truncated. */
function readBox(buf: Buffer, off: number): { size: number; type: string } | null {
  if (off + 8 > buf.length) return null;
  const size = buf.readUInt32BE(off);
  const type = buf.subarray(off + 4, off + 8).toString('latin1');
  if (!/^[a-zA-Z0-9]{4}$/.test(type) || size < 8) return null;
  if (off + size > buf.length) return null;
  return { size, type };
}

/** `mvhd` timescale, needed for the manifest's segment duration. */
function findTimescale(init: Buffer): number | undefined {
  const idx = init.indexOf('mvhd', 0, 'latin1');
  if (idx < 0) return undefined;
  const version = init.readUInt8(idx + 4);
  // v0: version(1)+flags(3)+created(4)+modified(4) -> timescale
  // v1: version(1)+flags(3)+created(8)+modified(8) -> timescale
  const off = idx + 4 + 4 + (version === 1 ? 16 : 8);
  return off + 4 <= init.length ? init.readUInt32BE(off) : undefined;
}

/** `tfdt` decode time, so we can confirm segments advance monotonically. */
function findBaseMediaDecodeTime(moof: Buffer): number | undefined {
  const idx = moof.indexOf('tfdt', 0, 'latin1');
  if (idx < 0) return undefined;
  const version = moof.readUInt8(idx + 4);
  const off = idx + 8;
  if (version === 1) {
    return off + 8 <= moof.length ? Number(moof.readBigUInt64BE(off)) : undefined;
  }
  return off + 4 <= moof.length ? moof.readUInt32BE(off) : undefined;
}

/**
 * Consume a ReadableStream of fMP4 and write `init.mp4` + `seg-N.m4s` into
 * `outDir`. Buffers incrementally: a segment is emitted as soon as its
 * `moof`+`mdat` pair is complete, which is what a live converter would do.
 */
export async function segment(
  stream: ReadableStream<Uint8Array>,
  outDir: string,
): Promise<SegmentResult> {
  mkdirSync(outDir, { recursive: true });

  let buf = Buffer.alloc(0);
  let init: Buffer | null = null;
  let pendingMoof: Buffer | null = null;
  const segments: SegmentInfo[] = [];
  const boxOrder: string[] = [];
  const headerBoxes: Buffer[] = [];

  const flushBoxes = () => {
    let off = 0;
    for (;;) {
      const box = readBox(buf, off);
      if (!box) break;
      const raw = buf.subarray(off, off + box.size);
      if (!boxOrder.includes(box.type)) boxOrder.push(box.type);

      if (!init) {
        // Everything before the first moof is the initialization segment.
        if (box.type === 'moof') {
          init = Buffer.concat(headerBoxes);
          writeFileSync(join(outDir, 'init.mp4'), init);
          pendingMoof = Buffer.from(raw);
        } else {
          headerBoxes.push(Buffer.from(raw));
        }
      } else if (box.type === 'moof') {
        pendingMoof = Buffer.from(raw);
      } else if (box.type === 'mdat' && pendingMoof) {
        const number = segments.length + 1;
        const segment = Buffer.concat([pendingMoof, raw]);
        writeFileSync(join(outDir, `seg-${number}.m4s`), segment);
        segments.push({
          number,
          bytes: segment.length,
          baseMediaDecodeTime: findBaseMediaDecodeTime(pendingMoof),
        });
        pendingMoof = null;
      }
      off += box.size;
    }
    if (off > 0) buf = buf.subarray(off);
  };

  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf = Buffer.concat([buf, Buffer.from(value)]);
    flushBoxes();
  }
  flushBoxes();

  return {
    initBytes: init?.length ?? 0,
    segments,
    boxOrder,
    timescale: init ? findTimescale(init) : undefined,
  };
}
