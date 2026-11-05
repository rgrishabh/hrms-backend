/** Small images with a real structure, and metadata a test can look for. Not decodable pictures: the code under test only walks their structure. */
const be32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const le32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const be16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };

export const GPS_MARK = 'GPS-19.0760N-72.8777E';

const pngChunk = (type: string, data: Buffer) => Buffer.concat([be32(data.length), Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const TINY_PNG = Buffer.concat([PNG_SIG, pngChunk('IHDR', Buffer.alloc(13, 1)), pngChunk('IDAT', Buffer.alloc(8, 2)), pngChunk('IEND', Buffer.alloc(0))]);
export const PNG_WITH_METADATA = Buffer.concat([PNG_SIG, pngChunk('IHDR', Buffer.alloc(13, 1)), pngChunk('tEXt', Buffer.from(`Comment\0${GPS_MARK}`)), pngChunk('eXIf', Buffer.from(GPS_MARK)),
  pngChunk('iTXt', Buffer.from(GPS_MARK)), pngChunk('tIME', Buffer.from('2026...')), pngChunk('IDAT', Buffer.alloc(8, 2)), pngChunk('IEND', Buffer.alloc(0)), Buffer.from(`trailing ${GPS_MARK}`)]);

const seg = (marker: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), be16(body.length + 2), body]);
/** Exif in big-endian TIFF order with an orientation and a mark standing for everything else in there. */
export const exif = (orientation: number, mark = GPS_MARK) => {
  const entry = Buffer.concat([be16(0x0112), be16(3), be32(1), be16(orientation), be16(0)]);
  return seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from('MM', 'latin1'), be16(42), be32(8), be16(1), entry, be32(0), Buffer.from(mark)]));
};
const SCAN = Buffer.concat([Buffer.from([0xff, 0xda]), be16(8), Buffer.alloc(6, 1), Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]), Buffer.from([0xff, 0xd9])]);
const JPEG_HEAD = Buffer.from([0xff, 0xd8]);
const JFIF = seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'));
const QUANT = seg(0xdb, Buffer.alloc(65, 3));
export const TINY_JPEG = Buffer.concat([JPEG_HEAD, JFIF, QUANT, SCAN]);
export const ICC = seg(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01colour', 'latin1'));
export const JPEG_WITH_METADATA = Buffer.concat([JPEG_HEAD, JFIF, exif(6), seg(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0${GPS_MARK}`)), ICC, seg(0xed, Buffer.from(`Photoshop ${GPS_MARK}`)),
  seg(0xfe, Buffer.from(`comment ${GPS_MARK}`)), QUANT, SCAN, Buffer.from(`trailing ${GPS_MARK}`)]);

const webpChunk = (type: string, data: Buffer) => Buffer.concat([Buffer.from(type, 'latin1'), le32(data.length), data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
const riff = (chunks: Buffer[], trailing = Buffer.alloc(0)) => { const body = Buffer.concat(chunks); return Buffer.concat([Buffer.from('RIFF', 'latin1'), le32(body.length + 4), Buffer.from('WEBP', 'latin1'), body, trailing]); };
export const WEBP_WITH_METADATA = riff([webpChunk('VP8X', Buffer.from([0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0])), webpChunk('VP8L', Buffer.alloc(9, 4)), webpChunk('EXIF', Buffer.from(GPS_MARK)), webpChunk('XMP ', Buffer.from(GPS_MARK))], Buffer.from(`trailing ${GPS_MARK}`));
