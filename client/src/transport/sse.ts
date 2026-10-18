import type { StreamEvent } from '@shared/types';

// SSE over fetch instead of EventSource, so we can see the status code (401 means signed
// out) and send Last-Event-ID ourselves. Reconnects with backoff and resumes from the last
// seen event id.

interface Options {
  lastEventId: () => number;
  onEvent: (id: number | null, event: StreamEvent) => void;
  onStatus: (status: 'open' | 'reconnecting') => void;
  onUnauthorized: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function openStream(opts: Options): () => void {
  let stopped = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  (async () => {
    for (let attempt = 0; !stopped; attempt++) {
      try {
        const res = await fetch('/api/stream', {
          headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(opts.lastEventId()) },
        });
        if (res.status === 401) return opts.onUnauthorized();
        if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
        reader = res.body.getReader();
        if (stopped) return void reader.cancel();
        opts.onStatus('open');
        attempt = 0;
        await readEvents(reader, opts.onEvent);
      } catch {
        // fall through to reconnect
      }
      if (stopped) return;
      opts.onStatus('reconnecting');
      await sleep(Math.min(500 * 2 ** attempt, 10_000));
    }
  })();

  return () => {
    stopped = true;
    void reader?.cancel();
  };
}

async function readEvents(reader: ReadableStreamDefaultReader<Uint8Array>, onEvent: Options['onEvent']) {
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let id: number | null = null;
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('id:')) id = Number(line.slice(3));
        else if (line.startsWith('data:')) data += line.slice(5).trimStart();
      }
      if (data) onEvent(id, JSON.parse(data));
    }
  }
}
