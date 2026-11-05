import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** The text of each page of a PDF, as a reader's viewer would find it, whitespace collapsed. */
export async function pdfPages(file: Buffer | Uint8Array): Promise<string[]> {
  const pdf = await getDocument({ data: new Uint8Array(file), verbosity: 0 }).promise;
  const pages: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    pages.push(
      content.items
        .map((i) => ('str' in i ? i.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  }
  await pdf.cleanup();
  return pages;
}
export const pdfText = async (file: Buffer | Uint8Array) => (await pdfPages(file)).join('\n');
