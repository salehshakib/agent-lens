import type { Adapter, Event, Source } from '../adapters/types';
import { ByteTail, JsonSnapshot, parseJson } from './byte-tail';

export interface RecordDiagnostics {
  malformed: number;
  oversized: number;
  unknown: number;
}

export interface SourceBatch {
  source: Source;
  generation: number;
  reset: boolean;
  committed: number;
  more: boolean;
  events: Event[];
  diagnostics: RecordDiagnostics;
}

export class SourceReader {
  private readonly tail: ByteTail | JsonSnapshot;

  constructor(private readonly adapter: Adapter, source: Source) {
    this.tail = source.kind === 'transcript' || source.kind === 'index' ? new ByteTail() : new JsonSnapshot();
  }

  async read(source: Source): Promise<SourceBatch> {
    const { lines, ...progress } = await this.tail.read(source.path);
    const diagnostics: RecordDiagnostics = { malformed: 0, oversized: 0, unknown: 0 };
    const events: Event[] = [];
    for (const line of lines) {
      if (!line.bytes) {
        diagnostics.oversized++;
        continue;
      }
      try {
        const record = parseJson(line.bytes, line.offset);
        const kind = this.adapter.classifyRecord(record, source);
        if (kind === 'known') {
          for (const event of this.adapter.parseRecords(record, source, line.offset)) events.push(event);
        } else {
          diagnostics[kind]++;
        }
      } catch {
        diagnostics.malformed++;
      }
    }
    return { ...progress, source, events, diagnostics };
  }
}
