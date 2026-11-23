import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inspectLocal, openLocalFile, sameFile, SourceAccessError } from './local-path';

const chunkBytes = 128 * 1024;
const sampleBytes = 4096;
const recordBytes = 16 * 1024 * 1024;
const cycleBytes = 512 * 1024;
const metadataBytes = 256 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const bom = Buffer.from([0xef, 0xbb, 0xbf]);

export interface RawLine {
  offset: number;
  bytes?: Buffer;
}

export interface TailBatch {
  generation: number;
  reset: boolean;
  committed: number;
  more: boolean;
  lines: RawLine[];
}

async function readAt(handle: FileHandle, start: number, size: number): Promise<Buffer> {
  const data = Buffer.allocUnsafe(size);
  let read = 0;
  while (read < size) {
    const { bytesRead } = await handle.read(data, read, size - read, start + read);
    if (!bytesRead) break;
    read += bytesRead;
  }
  return data.subarray(0, read);
}

export function parseJson(bytes: Buffer, offset: number): unknown {
  if (offset === 0 && bytes.subarray(0, 3).equals(bom)) bytes = bytes.subarray(3);
  if (bytes.at(-1) === 13) bytes = bytes.subarray(0, bytes.length - 1);
  return JSON.parse(decoder.decode(bytes));
}

export class ByteTail {
  private file?: BigIntStats;
  private prefix: Buffer = Buffer.alloc(0);
  private overlap: Buffer = Buffer.alloc(0);
  private offset = 0;
  private committed = 0;
  private buffered: Buffer[] = [];
  private pendingBytes = 0;
  private discarding = false;
  private generation = 0;

  constructor(private readonly maxRecordBytes = recordBytes, private readonly maxReadBytes = cycleBytes) {}

  private clear() {
    this.offset = 0;
    this.committed = 0;
    this.buffered = [];
    this.pendingBytes = 0;
    this.discarding = false;
    this.generation++;
  }

  private consume(data: Buffer, lines: RawLine[]) {
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(10, start);
      const end = newline === -1 ? data.length : newline;
      const size = end - start;
      if (!this.discarding && this.pendingBytes + size > this.maxRecordBytes) {
        this.buffered = [];
        this.pendingBytes = 0;
        this.discarding = true;
      }
      if (!this.discarding && size) {
        this.buffered.push(data.subarray(start, end));
        this.pendingBytes += size;
      }
      if (newline === -1) break;
      lines.push({
        offset: this.committed,
        bytes: this.discarding ? undefined : Buffer.concat(this.buffered, this.pendingBytes),
      });
      this.committed = this.offset + newline + 1;
      this.buffered = [];
      this.pendingBytes = 0;
      this.discarding = false;
      start = newline + 1;
    }
    this.offset += data.length;
  }

  async read(path: string): Promise<TailBatch> {
    const { handle, file } = await openLocalFile(path);
    try {
      const size = Number(file.size);
      if (!Number.isSafeInteger(size)) throw new SourceAccessError('unavailable');
      let reset = !this.file || !sameFile(this.file, file) || file.size < this.file.size
        || (file.size === this.file.size && file.mtimeNs !== this.file.mtimeNs);
      if (!reset) {
        const prefix = await readAt(handle, 0, this.prefix.length);
        const overlap = await readAt(handle, this.offset - this.overlap.length, this.overlap.length);
        reset = !prefix.equals(this.prefix) || !overlap.equals(this.overlap);
      }
      const start = reset ? 0 : this.offset;
      const end = Math.min(size, start + this.maxReadBytes);
      const chunks: Buffer[] = [];
      for (let cursor = start; cursor < end;) {
        const requested = Math.min(chunkBytes, end - cursor);
        const data = await readAt(handle, cursor, requested);
        if (data.length !== requested) throw new SourceAccessError('unavailable');
        chunks.push(data);
        cursor += data.length;
      }
      const prefix = await readAt(handle, 0, Math.min(sampleBytes, end));
      const overlap = await readAt(handle, Math.max(0, end - sampleBytes), Math.min(sampleBytes, end));
      const after = await inspectLocal(path, 'file');
      if (!sameFile(file, after) || after.size < file.size || (after.size === file.size && after.mtimeNs !== file.mtimeNs)) {
        throw new SourceAccessError('unavailable');
      }

      if (reset) this.clear();
      const lines: RawLine[] = [];
      for (const chunk of chunks) this.consume(chunk, lines);
      this.file = file;
      this.prefix = prefix;
      this.overlap = overlap;
      return { generation: this.generation, reset, committed: this.committed, more: end < Number(after.size), lines };
    } finally {
      await handle.close();
    }
  }
}

/** Child and presence files are replaced snapshots, including multiline JSON. */
export class JsonSnapshot {
  private generation = 0;
  private file?: BigIntStats;
  private digest?: string;

  async read(path: string): Promise<TailBatch> {
    const { handle, file } = await openLocalFile(path);
    try {
      const size = Number(file.size);
      const contents = size <= metadataBytes ? await readAt(handle, 0, size) : undefined;
      const digest = contents && createHash('sha256').update(contents).digest('hex');
      const after = await inspectLocal(path, 'file');
      if (!sameFile(file, after) || after.size !== file.size || after.mtimeNs !== file.mtimeNs
          || (contents && contents.length !== size)) {
        throw new SourceAccessError('unavailable');
      }
      const reset = !this.file || !sameFile(this.file, file) || file.size !== this.file.size
        || this.file.mtimeNs !== file.mtimeNs || this.digest !== digest;
      if (reset) this.generation++;
      this.file = file;
      this.digest = digest;
      return {
        generation: this.generation,
        reset,
        committed: size,
        more: false,
        lines: reset ? [{ offset: 0, bytes: contents }] : [],
      };
    } finally {
      await handle.close();
    }
  }
}
