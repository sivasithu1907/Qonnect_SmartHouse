// Service worker behaviour when the server can't be reached: page loads get a clear offline page
// (never an old cached shell → blank screen), /api is never intercepted, and nothing is cached from it.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

type Handler = (e: unknown) => void;
function loadSw(fetchImpl: (r: Request) => Promise<Response>) {
  const handlers: Record<string, Handler> = {};
  const store = new Map<string, Map<string, Response>>();
  const caches = {
    open: async (name: string) => {
      if (!store.has(name)) store.set(name, new Map());
      const m = store.get(name)!;
      return { match: async (k: string | Request) => m.get(typeof k === 'string' ? k : k.url)?.clone(), put: async (k: string | Request, v: Response) => { m.set(typeof k === 'string' ? k : k.url, v); }, keys: async () => [], addAll: async () => undefined, delete: async () => true };
    },
    match: async () => undefined, keys: async () => [...store.keys()], delete: async () => true,
  };
  const self = { addEventListener: (t: string, h: Handler) => { handlers[t] = h; }, location: new URL('https://smarthouse.example/'), registration: {}, clients: {}, skipWaiting: () => undefined };
  vm.runInNewContext(fs.readFileSync(path.resolve('public/sw.js'), 'utf8'), { self, caches, fetch: fetchImpl, Response, Request, URL, String, console });
  const dispatch = async (url: string, mode: RequestMode | 'navigate' = 'cors'): Promise<Response | null> => {
    let responded = null as Promise<Response> | null;
    const request = { url, method: 'GET', mode } as unknown as Request;
    handlers.fetch({ request, respondWith: (p: Promise<Response>) => { responded = p; } });
    const p = responded as Promise<Response> | null;
    return p ? await p : null;
  };
  return { dispatch, store };
}

describe('service worker offline handling', () => {
  const offline = () => Promise.reject(new TypeError('Failed to fetch'));

  it('shows "Can\'t reach Qonnect" with a Try again link that reloads the same section', async () => {
    const { dispatch } = loadSw(offline);
    const res = (await dispatch('https://smarthouse.example/#/materials/p1', 'navigate'))!;
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("Can't reach Qonnect");
    expect(html).toMatch(/href="https:\/\/smarthouse\.example\/\?retry=\d+#\/materials\/p1"/);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('online page loads come from the network', async () => {
    const { dispatch } = loadSw(async () => new Response('<html>app</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const res = (await dispatch('https://smarthouse.example/', 'navigate'))!;
    expect(await res.text()).toBe('<html>app</html>');
  });

  it('never intercepts /api requests', async () => {
    const { dispatch } = loadSw(offline);
    expect(await dispatch('https://smarthouse.example/api/projects')).toBeNull();
  });

  it('an uncached icon while offline fails as a normal network error instead of an empty response', async () => {
    const { dispatch } = loadSw(offline);
    const res = (await dispatch('https://smarthouse.example/icons/icon-192.png'))!;
    expect(res.type).toBe('error');
  });
});
