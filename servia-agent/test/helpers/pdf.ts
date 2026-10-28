/** Builds a minimal valid PDF with one text line per page (ASCII only). Avoids committing binary fixtures. */
export function makePdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const pageCount = pages.length;
  const fontId = 3 + pageCount * 2;
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`;
  pages.forEach((text, i) => {
    const pageId = 3 + i * 2;
    const contentId = pageId + 1;
    const escaped = text.replace(/[\\()]/g, (c) => `\\${c}`);
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET` : '';
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(out);
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
