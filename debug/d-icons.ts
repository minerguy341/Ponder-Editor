// Icon renderer debug page: renders the item ids given in ?ids=a,b,c into a grid and exposes pixel statistics via window.__icons(ids).
import { ItemIconRenderer } from '../src/ui/itemIcons';

const icons = new ItemIconRenderer();

interface Stat { id: string; ok: boolean; opaque: number; magenta: number; size: number; flat: boolean; reason?: string }

async function stats(ids: string[]): Promise<Stat[]> {
  const out: Stat[] = [];
  const grid = document.getElementById('grid')!;
  for (const id of ids) {
    const icon = await icons.get(id);
    const cell = document.createElement('div');
    cell.className = 'c';
    if (!icon) { out.push({ id, ok: false, opaque: 0, magenta: 0, size: 0, flat: false, reason: 'no icon' }); cell.textContent = id + ' (none)'; grid.appendChild(cell); continue; }
    const { canvas } = icon;
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0, magenta = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      opaque++;
      // the vanilla missing-texture colour is magenta/black; count anything strongly magenta
      if (data[i] > 200 && data[i + 2] > 200 && data[i + 1] < 60) magenta++;
    }
    const total = canvas.width * canvas.height;
    out.push({ id, ok: opaque / total > 0.02 && magenta / Math.max(1, opaque) < 0.05, opaque: opaque / total, magenta: magenta / Math.max(1, opaque), size: canvas.width, flat: icon.flat });
    const c = document.createElement('canvas');
    c.width = canvas.width; c.height = canvas.height;
    c.getContext('2d')!.drawImage(canvas, 0, 0);
    cell.appendChild(c);
    cell.appendChild(document.createTextNode(id.replace(/^[^:]*:/, '')));
    grid.appendChild(cell);
  }
  return out;
}
(window as any).__icons = stats;
const ids = new URLSearchParams(location.search).get('ids');
if (ids) stats(ids.split(',')).then((r) => { (window as any).__result = r; (window as any).__ready = true; });
else (window as any).__ready = true;
