/**
 * Removes metadata from uploaded images by walking the file's own structure, with no decoder and no dependency: EXIF holds GPS positions, device
 * serial numbers and timestamps, which nobody uploading a selfie or a certificate means to hand over. Pixels are not touched. A file whose
 * structure does not hold together is refused, since we could not say what is left in it. Bytes after the end of the image go too.
 */
export class ImageStructureError extends Error {}
const bad = (what: string) => new ImageStructureError(`Malformed ${what}`);

const asciiAt = (b: Buffer, at: number, s: string) => b.toString('latin1', at, at + s.length) === s;

/** Orientation from an Exif segment, 1 to 8, if it says. Without it a phone photo would come out sideways. */
function exifOrientation(seg: Buffer): number | null {
  if (!asciiAt(seg, 0, 'Exif\0\0') || seg.length < 14) return null;
  const le = asciiAt(seg, 6, 'II');
  if (!le && !asciiAt(seg, 6, 'MM')) return null;
  const u16 = (at: number) => (le ? seg.readUInt16LE(at) : seg.readUInt16BE(at));
  const u32 = (at: number) => (le ? seg.readUInt32LE(at) : seg.readUInt32BE(at));
  const ifd = 6 + u32(10);
  if (ifd + 2 > seg.length) return null;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > seg.length) return null;
    if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : null; }
  }
  return null;
}

/** An Exif segment holding the orientation and nothing else. */
function orientationSegment(value: number): Buffer {
  const body = Buffer.alloc(6 + 8 + 2 + 12 + 4);
  body.write('Exif\0\0', 0, 'latin1');
  body.write('II', 6, 'latin1');
  body.writeUInt16LE(42, 8);
  body.writeUInt32LE(8, 10);
  body.writeUInt16LE(1, 14);
  body.writeUInt16LE(0x0112, 16);
  body.writeUInt16LE(3, 18);
  body.writeUInt32LE(1, 20);
  body.writeUInt16LE(value, 24);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

export function stripJpeg(buf: Buffer): Buffer {
  const out: Buffer[] = [buf.subarray(0, 2)];
  let at = 2; let orientation: number | null = null; let placed = false;
  const placeOrientation = () => { if (!placed && orientation) out.push(orientationSegment(orientation)); placed = true; };
  for (;;) {
    if (at + 2 > buf.length) throw bad('JPEG');
    if (buf[at] !== 0xff) throw bad('JPEG');
    let m = at + 1;
    while (buf[m] === 0xff && m < buf.length) m++; // fill bytes
    const marker = buf[m];
    if (marker === undefined) throw bad('JPEG');
    if (marker === 0xd9) { placeOrientation(); out.push(Buffer.from([0xff, 0xd9])); return Buffer.concat(out); }
    if (marker === 0xda) {
      // Entropy-coded data, which may hold more scans. Everything up to the last end-of-image marker is image; anything after it is not.
      const end = buf.lastIndexOf(Buffer.from([0xff, 0xd9]));
      if (end < m) throw bad('JPEG');
      placeOrientation();
      out.push(buf.subarray(at, end + 2));
      return Buffer.concat(out);
    }
    if (m + 3 > buf.length) throw bad('JPEG');
    const len = buf.readUInt16BE(m + 1);
    if (len < 2 || m + 1 + len > buf.length) throw bad('JPEG');
    const seg = buf.subarray(m + 3, m + 1 + len);
    const keep = (() => {
      if (marker === 0xe0) return true;                                     // JFIF
      if (marker === 0xe1) { orientation ??= exifOrientation(seg); return false; } // Exif, XMP
      if (marker === 0xe2) return asciiAt(seg, 0, 'ICC_PROFILE\0');         // colour, nothing about anyone
      if (marker >= 0xe3 && marker <= 0xef) return false;                   // maker notes, IPTC, Adobe
      if (marker === 0xfe) return false;                                    // comment
      return true;
    })();
    if (keep) {
      if (marker !== 0xe0) placeOrientation();
      out.push(buf.subarray(at, m + 1 + len));
    }
    at = m + 1 + len;
  }
}

const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
export function stripPng(buf: Buffer): Buffer {
  const out: Buffer[] = [buf.subarray(0, 8)];
  for (let at = 8; ;) {
    if (at + 12 > buf.length) throw bad('PNG');
    const len = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const end = at + 12 + len;
    if (end > buf.length) throw bad('PNG');
    if (!PNG_DROP.has(type)) out.push(buf.subarray(at, end));
    if (type === 'IEND') return Buffer.concat(out);
    at = end;
  }
}

const VP8X_XMP = 0x04; const VP8X_EXIF = 0x08;
export function stripWebp(buf: Buffer): Buffer {
  if (buf.length < 12) throw bad('WebP');
  const riffEnd = 8 + buf.readUInt32LE(4);
  if (riffEnd > buf.length) throw bad('WebP');
  const chunks: Buffer[] = [];
  for (let at = 12; at < riffEnd;) {
    if (at + 8 > riffEnd) throw bad('WebP');
    const type = buf.toString('latin1', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const end = at + 8 + size + (size % 2);
    if (end > riffEnd) throw bad('WebP');
    if (type === 'VP8X') {
      const copy = Buffer.from(buf.subarray(at, end));
      copy[8] = copy[8]! & ~(VP8X_XMP | VP8X_EXIF);
      chunks.push(copy);
    } else if (type !== 'EXIF' && type !== 'XMP ') chunks.push(buf.subarray(at, end));
    at = end;
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.from(buf.subarray(0, 12));
  head.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([head, body]);
}

/** The bytes to store for this detected type. Formats that are not images pass through. */
export function stripMetadata(buf: Buffer, contentType: string): Buffer {
  if (contentType === 'image/jpeg') return stripJpeg(buf);
  if (contentType === 'image/png') return stripPng(buf);
  if (contentType === 'image/webp') return stripWebp(buf);
  return buf;
}
