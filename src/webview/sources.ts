import type { SourceMessage } from '../shared/sources';

declare function acquireVsCodeApi(): { postMessage(message: { type: 'ready' }): void };

const list = document.querySelector<HTMLUListElement>('#sources');
let previous = '';

window.addEventListener('message', (event: MessageEvent<SourceMessage>) => {
  if (!list || event.data?.type !== 'sources') return;
  const fingerprint = JSON.stringify(event.data.providers);
  if (fingerprint === previous) return;
  previous = fingerprint;
  list.replaceChildren(...event.data.providers.map(provider => {
    const row = document.createElement('li');
    const name = document.createElement('strong');
    name.textContent = provider.label;
    const status = document.createElement('span');
    status.textContent = provider.state;
    row.append(name, status);
    if (provider.state === 'Available' || provider.state === 'Partial coverage') {
      const detail = document.createElement('small');
      detail.textContent = provider.transcripts + (provider.transcripts === 1 ? ' transcript' : ' transcripts');
      if (provider.versions.length) detail.textContent += ' · ' + provider.versions.join(', ');
      row.append(detail);
    }
    return row;
  }));
});

acquireVsCodeApi().postMessage({ type: 'ready' });
