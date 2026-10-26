/**
 * Reads the files in a ZIP archive in the browser, for Plausible's CSV export. Plausible stores its files uncompressed;
 * deflated entries (a re-zipped export) are inflated with the browser's DecompressionStream. ZIP64 sizes are supported.
 */

export interface ZipEntry {
  name: string;
  read(): Promise<string>;
}

const decoder = new TextDecoder();

export async function readZip(file: Blob): Promise<ZipEntry[]> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // End of central directory: the last 0x06054b50 within the final 64 KB (it may be followed by a comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This isn't a ZIP file.");
  let count = view.getUint16(eocd + 10, true);
  let dirOffset = view.getUint32(eocd + 16, true);
  if (dirOffset === 0xffffffff || count === 0xffff) {
    // ZIP64: the locator just before the EOCD points to the ZIP64 EOCD record.
    const locator = eocd - 20;
    if (locator < 0 || view.getUint32(locator, true) !== 0x07064b50) throw new Error("Unsupported ZIP file.");
    const z64 = Number(view.getBigUint64(locator + 8, true));
    count = Number(view.getBigUint64(z64 + 32, true));
    dirOffset = Number(view.getBigUint64(z64 + 48, true));
  }

  const entries: ZipEntry[] = [];
  let p = dirOffset;
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("Damaged ZIP file.");
    const method = view.getUint16(p + 10, true);
    let compressed = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    let local = view.getUint32(p + 42, true);
    const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extra field: 64-bit values replace the 32-bit ones that are 0xFFFFFFFF, in order.
    let e = p + 46 + nameLen;
    const end = e + extraLen;
    while (e + 4 <= end) {
      const id = view.getUint16(e, true);
      const size = view.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (view.getUint32(p + 24, true) === 0xffffffff) q += 8; // uncompressed size, unused
        if (compressed === 0xffffffff) {
          compressed = Number(view.getBigUint64(q, true));
          q += 8;
        }
        if (local === 0xffffffff) local = Number(view.getBigUint64(q, true));
      }
      e += 4 + size;
    }
    p = end + commentLen;

    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = buf.subarray(dataStart, dataStart + compressed);
    if (name.endsWith("/")) continue;
    entries.push({
      name,
      async read() {
        if (method === 0) return decoder.decode(data);
        if (method !== 8) throw new Error(`${name} uses an unsupported compression method.`);
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Response(stream).text();
      },
    });
  }
  return entries;
}
