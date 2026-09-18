/**
 * Minimal read-only zip parser: indexes the central directory and inflates entries on demand
 * using the browser's `DecompressionStream`. Sufficient for reading jar files; ZIP64 archives
 * are not supported.
 */

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  /** 0 = stored, 8 = deflate */
  method: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export class ZipReader {
  readonly entries: Map<string, ZipEntry>;
  private readonly data: Uint8Array;

  private constructor(data: Uint8Array, entries: Map<string, ZipEntry>) {
    this.data = data;
    this.entries = entries;
  }

  static fromBytes(data: Uint8Array): ZipReader {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    // Locate the end of central directory record (scan backwards past a possible comment)
    const minEocd = Math.max(0, data.length - 22 - 0xffff);
    let eocd = -1;
    for (let i = data.length - 22; i >= minEocd; i--) {
      if (view.getUint32(i, true) === EOCD_SIGNATURE) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) throw new Error("Not a zip file (end of central directory not found)");

    const entryCount = view.getUint16(eocd + 10, true);
    const centralSize = view.getUint32(eocd + 12, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new Error("ZIP64 archives are not supported");
    }

    const decoder = new TextDecoder();
    const entries = new Map<string, ZipEntry>();
    let pos = centralOffset;
    for (let i = 0; i < entryCount; i++) {
      if (view.getUint32(pos, true) !== CENTRAL_SIGNATURE) {
        throw new Error(`Corrupt zip: bad central directory entry at ${pos}`);
      }
      const method = view.getUint16(pos + 10, true);
      const crc32 = view.getUint32(pos + 16, true);
      const compressedSize = view.getUint32(pos + 20, true);
      const uncompressedSize = view.getUint32(pos + 24, true);
      const nameLength = view.getUint16(pos + 28, true);
      const extraLength = view.getUint16(pos + 30, true);
      const commentLength = view.getUint16(pos + 32, true);
      const localHeaderOffset = view.getUint32(pos + 42, true);
      const name = decoder.decode(data.subarray(pos + 46, pos + 46 + nameLength));
      entries.set(name, { name, compressedSize, uncompressedSize, crc32, method, localHeaderOffset });
      pos += 46 + nameLength + extraLength + commentLength;
    }

    return new ZipReader(data, entries);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  private compressedBytes(entry: ZipEntry): Uint8Array {
    const view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    const pos = entry.localHeaderOffset;
    if (view.getUint32(pos, true) !== LOCAL_SIGNATURE) {
      throw new Error(`Corrupt zip: bad local header for ${entry.name}`);
    }
    const nameLength = view.getUint16(pos + 26, true);
    const extraLength = view.getUint16(pos + 28, true);
    const start = pos + 30 + nameLength + extraLength;
    return this.data.subarray(start, start + entry.compressedSize);
  }

  async read(name: string): Promise<Uint8Array> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Entry not found in zip: ${name}`);
    const compressed = this.compressedBytes(entry);
    if (entry.method === 0) {
      return compressed;
    }
    if (entry.method !== 8) {
      throw new Error(`Unsupported zip compression method ${entry.method} for ${entry.name}`);
    }
    const stream = new Blob([compressed as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  }

  async readText(name: string): Promise<string> {
    return new TextDecoder().decode(await this.read(name));
  }
}
