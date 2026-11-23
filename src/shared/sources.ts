export interface SourceStatus {
  label: string;
  state: 'Disabled' | 'Scanning' | 'Available' | 'Partial coverage' | 'Missing source' | 'Source unavailable' | 'Source rejected';
  transcripts: number;
  versions: string[];
}

export type SourceMessage = { type: 'sources'; providers: SourceStatus[] };

export function isReady(message: unknown): message is { type: 'ready' } {
  return typeof message === 'object' && message !== null
    && 'type' in message && message.type === 'ready' && Object.keys(message).length === 1;
}
