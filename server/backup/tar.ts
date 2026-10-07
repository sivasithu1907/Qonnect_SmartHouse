// Minimal POSIX "ustar" archive writer and a strict reader for backup archives.
//
// The writer only produces regular-file entries. The reader treats every archive as untrusted:
// it accepts regular files only (no directories, symlinks, hard links, devices, PAX or GNU
// extension headers), verifies each header checksum, rejects unsafe or duplicate paths and
// never lets an entry extend past the end of the file. Nothing is ever extracted by name:
// callers read entry data through `entryStream` and decide where (and whether) to write it.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const BLOCK = 512;
/** ustar sizes are 11 octal digits: a single entry may be up to 8 GiB - 1 byte. */
export const MAX_ENTRY_BYTES = 8 ** 11 - 1;

export interface TarEntry {
  name: string;
  size: number;
  /** byte offset of the entry data inside the archive */
  offset: number;
  mtime: number;
}

function octal(n: number, width: number): string {
  // width includes the terminating NUL
  const s = Math.floor(n).toString(8);
  if (s.length > width - 1) throw new Error('tar: value does not fit the header field');
  return s.padStart(width - 1, '0') + '\0';
}

/** Safe relative path: letters, digits, dot, dash, underscore and '/' separators only. */
export function isSafeArchivePath(name: string): boolean {
  if (!name || name.length > 255 || name.startsWith('/') || name.endsWith('/')) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false;
  return name.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..' && seg.length <= 100);
}

export function tarHeader(name: string, size: number, mtimeMs: number): Buffer {
  if (!isSafeArchivePath(name)) throw new Error(`tar: unsafe entry name ${JSON.stringify(name)}`);
  if (size < 0 || size > MAX_ENTRY_BYTES) throw new Error(`tar: entry ${name} is too large`);
  let prefix = '';
  let base = name;
  if (name.length > 100) {
    // split at a '/' so that prefix <= 155 and name <= 100
    let cut = -1;
    for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1)) {
      if (i <= 155 && name.length - i - 1 <= 100) { cut = i; break; }
    }
    if (cut < 0) throw new Error(`tar: entry name too long: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  const h = Buffer.alloc(BLOCK, 0);
  h.write(base, 0, 100, 'utf8');
  h.write(octal(0o640, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(Math.floor(mtimeMs / 1000), 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii'); // checksum placeholder (8 spaces)
  h.write('0', 156, 1, 'ascii');        // regular file
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

const pad = (size: number) => (BLOCK - (size % BLOCK)) % BLOCK;

/** Sequential archive writer. Every entry's SHA-256 is computed while it is written. */
export class TarWriter {
  private pos = 0;
  readonly entries: Array<{ path: string; size: number; sha256: string }> = [];
  private constructor(private fh: fs.promises.FileHandle) {}

  static async create(file: string): Promise<TarWriter> {
    return new TarWriter(await fs.promises.open(file, 'wx', 0o600));
  }

  private async write(buf: Buffer) {
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await this.fh.write(buf, off, buf.length - off);
      off += bytesWritten;
    }
    this.pos += buf.length;
  }

  async addBuffer(name: string, data: Buffer, mtimeMs = Date.now()): Promise<string> {
    await this.write(tarHeader(name, data.length, mtimeMs));
    await this.write(data);
    await this.write(Buffer.alloc(pad(data.length)));
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    this.entries.push({ path: name, size: data.length, sha256 });
    return sha256;
  }

  /** Streams a file into the archive. Fails if the file changes size while it is being read. */
  async addFile(name: string, src: string, size: number, mtimeMs = Date.now()): Promise<string> {
    await this.write(tarHeader(name, size, mtimeMs));
    const hash = crypto.createHash('sha256');
    let n = 0;
    for await (const chunk of fs.createReadStream(src, { highWaterMark: 1024 * 1024 })) {
      const b = chunk as Buffer;
      n += b.length;
      if (n > size) throw new Error(`${name} changed while it was being archived`);
      hash.update(b);
      await this.write(b);
    }
    if (n !== size) throw new Error(`${name} changed while it was being archived`);
    await this.write(Buffer.alloc(pad(size)));
    const sha256 = hash.digest('hex');
    this.entries.push({ path: name, size, sha256 });
    return sha256;
  }

  /** Writes the end-of-archive marker, flushes to disk and closes the file. */
  async finish(): Promise<number> {
    await this.write(Buffer.alloc(BLOCK * 2));
    await this.fh.sync();
    await this.fh.close();
    return this.pos;
  }

  async abort() {
    await this.fh.close().catch(() => undefined);
  }
}

function field(h: Buffer, start: number, len: number): string {
  const raw = h.subarray(start, start + len);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? len : nul).toString('utf8');
}
function parseOctal(h: Buffer, start: number, len: number): number {
  const s = field(h, start, len).trim();
  if (!/^[0-7]+$/.test(s)) throw new Error('Not a valid backup archive (bad header number)');
  return Number.parseInt(s, 8);
}

/**
 * Lists the entries of an untrusted archive without extracting anything. Throws a readable
 * error on any unsupported or unsafe construct.
 */
export async function* readTar(file: string, opts: { maxEntries?: number } = {}): AsyncGenerator<TarEntry> {
  const maxEntries = opts.maxEntries ?? 2_000_000;
  const fh = await fs.promises.open(file, 'r');
  try {
    const total = (await fh.stat()).size;
    const seen = new Set<string>();
    let pos = 0;
    let count = 0;
    const h = Buffer.alloc(BLOCK);
    for (;;) {
      if (pos + BLOCK > total) throw new Error('The archive is truncated (no end-of-archive marker). The upload or download may be incomplete.');
      await fh.read(h, 0, BLOCK, pos);
      if (h.every((b) => b === 0)) return; // end of archive
      // header checksum
      let sum = 0;
      for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
      if (parseOctal(h, 148, 8) !== sum) throw new Error('Not a valid backup archive (header checksum mismatch)');
      if (field(h, 257, 6) !== 'ustar') throw new Error('Not a valid backup archive (unsupported tar format)');
      const type = String.fromCharCode(h[156]);
      const prefix = field(h, 345, 155);
      const name = prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100);
      if (type !== '0' && h[156] !== 0) {
        throw new Error(`The archive contains an unsupported entry type for ${JSON.stringify(name.slice(0, 120))} (links, directories and extended headers are not allowed)`);
      }
      if (!isSafeArchivePath(name)) throw new Error(`The archive contains an unsafe path: ${JSON.stringify(name.slice(0, 120))}`);
      if (seen.has(name)) throw new Error(`The archive contains a duplicate entry: ${name}`);
      seen.add(name);
      if (++count > maxEntries) throw new Error('The archive contains too many entries');
      const size = parseOctal(h, 124, 12);
      const offset = pos + BLOCK;
      if (offset + size > total) throw new Error(`The archive is truncated inside ${name}. The upload or download may be incomplete.`);
      yield { name, size, offset, mtime: parseOctal(h, 136, 12) * 1000 };
      pos = offset + size + pad(size);
    }
  } finally {
    await fh.close();
  }
}

export function entryStream(file: string, e: TarEntry): Readable {
  if (e.size === 0) return Readable.from([]);
  return fs.createReadStream(file, { start: e.offset, end: e.offset + e.size - 1, highWaterMark: 1024 * 1024 });
}

export async function readEntryBuffer(file: string, e: TarEntry, max: number): Promise<Buffer> {
  if (e.size > max) throw new Error(`${e.name} is larger than allowed`);
  const fh = await fs.promises.open(file, 'r');
  try {
    const b = Buffer.alloc(e.size);
    if (e.size) await fh.read(b, 0, e.size, e.offset);
    return b;
  } finally {
    await fh.close();
  }
}
