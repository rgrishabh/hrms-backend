/**
 * Identify uploads by their CONTENT (magic bytes), not by the client's content type
 * or file name. Only formats needed for HR documents are accepted.
 */
export interface Detected {
  contentType: string;
  ext: string;
}

const starts = (b: Buffer, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

export function detectFile(buf: Buffer, fileName: string): Detected | { error: string } {
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1] ?? '';
  if (starts(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    // %PDF-
    const text = buf.toString('latin1');
    // Active content has no place in HR documents.
    if (/\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia)\b/.test(text)) return { error: 'PDF files with scripts, launch actions or embedded files are not accepted' };
    return { contentType: 'application/pdf', ext: 'pdf' };
  }
  if (starts(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { contentType: 'image/png', ext: 'png' };
  if (starts(buf, [0xff, 0xd8, 0xff])) return { contentType: 'image/jpeg', ext: 'jpg' };
  if (starts(buf, [0x52, 0x49, 0x46, 0x46]) && starts(buf, [0x57, 0x45, 0x42, 0x50], 8)) return { contentType: 'image/webp', ext: 'webp' };
  if (starts(buf, [0x50, 0x4b, 0x03, 0x04]) && buf.includes('[Content_Types].xml')) {
    if (ext === 'docx' && buf.includes('word/')) return { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
    if (ext === 'xlsx' && buf.includes('xl/')) return { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
  }
  return { error: 'Unsupported file type. Upload PDF, PNG, JPEG, WebP, DOCX or XLSX.' };
}

/** Download name: letters, digits, space, dot, dash, underscore only; keeps the detected extension. */
export function safeFileName(original: string, ext: string) {
  const base =
    original
      .replace(/\.[^.]*$/, '')
      .normalize('NFKD')
      .replace(/[^\w .-]+/g, '')
      .replace(/\.{2,}/g, '.')
      .replace(/^[.\s-]+/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'document';
  return `${base}.${ext}`;
}
