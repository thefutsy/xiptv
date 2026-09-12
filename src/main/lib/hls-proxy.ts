import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

export function rewritePlaylist(text: string, base: string, resource: (url: string, playlist: boolean) => string): string {
  let variant = false;
  return text.split(/\r?\n/).map(line => {
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) variant = true;
      const playlist = /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT):/.test(line);
      return line.replace(/URI="([^"]+)"/g, (_, uri: string) => `URI="${resource(new URL(uri, base).href, playlist)}"`);
    }
    if (!line.trim()) return line;
    const rewritten = resource(new URL(line.trim(), base).href, variant);
    variant = false;
    return rewritten;
  }).join('\n');
}

/** All resources of one HLS session coexist; only session teardown aborts siblings. */
export class HlsProxy {
  private resources = new Map<string, { url: string; playlist: boolean }>();
  private pending = new Map<AbortController, Promise<void>>();
  private closed = false;
  constructor(private root: string, private prefix: string) {
    this.resources.set('0', { url: root, playlist: true });
  }
  private resource(url: string, playlist: boolean): string {
    if (!/^https?:\/\//i.test(url)) throw new Error('Unsupported HLS resource URL');
    for (const [id, r] of this.resources) if (r.url === url) return `${this.prefix}/${id}`;
    const id = String(this.resources.size);
    if (this.resources.size >= 50_000) throw new Error('HLS resource limit reached');
    this.resources.set(id, { url, playlist });
    return `${this.prefix}/${id}`;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const c of this.pending.keys()) c.abort();
    await Promise.allSettled(this.pending.values());
    this.resources.clear();
  }
  async serve(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const resource = this.resources.get(id);
    if (this.closed || !resource) { res.writeHead(410).end(); return; }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 30_000);
    const stop = () => abort.abort();
    res.once('close', stop);
    const work = (async () => {
      const headers: Record<string, string> = { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20' };
      if (req.headers.range) headers.Range = req.headers.range;
      const upstream = await fetch(resource.url, { headers, signal: abort.signal });
      if (!upstream.ok) { await upstream.body?.cancel(); throw new Error(`HLS resource returned HTTP ${upstream.status}`); }
      const type = upstream.headers.get('content-type') || 'application/octet-stream';
      if (resource.playlist || /mpegurl/i.test(type)) {
        let text = '';
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          text += decoder.decode(part.value, { stream: true });
          if (text.length > 2_000_000) { await reader.cancel(); throw new Error('HLS playlist too large'); }
        }
        text += decoder.decode();
        const body = rewritePlaylist(text, upstream.url, (url, playlist) => this.resource(url, playlist));
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : body);
      } else {
        const out: Record<string, string> = { 'Content-Type': type, 'Cache-Control': 'no-store' };
        for (const key of ['content-length', 'content-range', 'accept-ranges']) {
          const value = upstream.headers.get(key); if (value) out[key] = value;
        }
        res.writeHead(upstream.status, out);
        if (req.method === 'HEAD') { await upstream.body?.cancel(); res.end(); return; }
        const stream = Readable.fromWeb(upstream.body as never);
        await new Promise<void>((resolve, reject) => {
          stream.on('error', reject); res.on('finish', resolve); res.on('close', resolve); stream.pipe(res);
        });
      }
    })();
    this.pending.set(abort, work);
    try { await work; } catch {
      if (!res.headersSent && !res.destroyed) res.writeHead(502).end('HLS resource unavailable');
      else res.destroy();
    } finally { clearTimeout(timer); res.off('close', stop); abort.abort(); this.pending.delete(abort); }
  }
}
