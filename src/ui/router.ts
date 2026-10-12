// Hash router: `#/` (index: Ponder's tag index + scene search), `#/items` (Ponder's item index, "Items to inspect"),
// `#/tag/<tag id>` (Ponder's PonderTagScreen), `#/scene/<id>?t=<tick>&item=<item id>` (playing a scene for a subject item).
// Scene ids contain ':' and '/' ("create:cog/small"); they are kept readable in the URL.
import { sceneIdToHash } from './data';

export type Route =
  | { kind: 'index'; q: string }
  | { kind: 'items' }
  | { kind: 'tag'; id: string }
  | { kind: 'scene'; id: string; t: number | null; item: string | null };

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, '');
  const [pathRaw, queryRaw = ''] = h.split('?');
  const params = new URLSearchParams(queryRaw);
  const path = pathRaw.replace(/^\/+/, '');
  const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
  if (path.startsWith('scene/')) {
    const id = path.slice('scene/'.length).split('/').map(dec).join('/');
    if (id) {
      const t = params.get('t');
      const tn = t !== null && /^\d+$/.test(t) ? Number(t) : null;
      return { kind: 'scene', id, t: tn, item: params.get('item') };
    }
  }
  if (path.startsWith('tag/')) {
    const id = path.slice('tag/'.length).split('/').map(dec).join('/');
    if (id) return { kind: 'tag', id };
  }
  if (path === 'items') return { kind: 'items' };
  return { kind: 'index', q: params.get('q') ?? '' };
}

export function formatRoute(r: Route): string {
  if (r.kind === 'scene') {
    const p = new URLSearchParams();
    if (r.item) p.set('item', r.item);
    if (r.t) p.set('t', String(r.t));
    const qs = p.toString();
    return `#/scene/${sceneIdToHash(r.id)}${qs ? '?' + qs.replace(/%3A/gi, ':').replace(/%2F/gi, '/') : ''}`;
  }
  if (r.kind === 'tag') return `#/tag/${sceneIdToHash(r.id)}`;
  if (r.kind === 'items') return '#/items';
  const p = new URLSearchParams();
  if (r.q) p.set('q', r.q);
  const qs = p.toString();
  return `#/${qs ? '?' + qs.replace(/%3A/gi, ':') : ''}`;
}

export class Router {
  private cb: (r: Route, source: 'init' | 'hash') => void = () => {};
  start(cb: (r: Route, source: 'init' | 'hash') => void): void {
    this.cb = cb;
    window.addEventListener('hashchange', () => {
      this.cb(parseHash(location.hash), 'hash');
    });
    this.cb(parseHash(location.hash), 'init');
  }
  current(): Route { return parseHash(location.hash); }
  /** push a new history entry and route to it */
  go(r: Route): void { location.hash = formatRoute(r); }
  /** update the URL without notifying listeners or adding a history entry (state mirrors: search text, current tick ...) */
  replace(r: Route): void {
    const url = formatRoute(r);
    if (location.hash === url) return;
    try { history.replaceState(history.state, '', url); } catch { /* sandboxed iframe */ }
  }
}
