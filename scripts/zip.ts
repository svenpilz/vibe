/**
 * Minimal ZIP reader (stored + deflate entries) using Node's zlib.
 * Sufficient for the Berlin DGM1 atom-feed archives (single deflated xyz).
 */
import { inflateRawSync } from "node:zlib";
import { Buffer } from "node:buffer";

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export function unzip(buf: Uint8Array): ZipEntry[] {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let eocd = -1;
  for (let i = b.length - 22; i >= 0 && i >= b.length - 22 - 65536; i--) {
    if (b[i] === sig[0] && b[i + 1] === sig[1] && b[i + 2] === sig[2] && b[i + 3] === sig[3]) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP file (no EOCD)");
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const method = b.readUInt16LE(p + 10);
    const csize = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const localOff = b.readUInt32LE(p + 42);
    const name = b.toString("utf8", p + 46, p + 46 + nameLen);
    const nl = b.readUInt16LE(localOff + 26);
    const el = b.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + nl + el;
    const raw = b.subarray(dataStart, dataStart + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
