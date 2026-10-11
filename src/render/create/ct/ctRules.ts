// Block-level rendering rules shared by the connected-texture code (no state of its own).
import type { BlockState } from '../../../contract';
import { Dir, OPPOSITE } from './dirs';

/**
 * BlockBehaviour.skipRendering(state, adjacent, side) for the blocks of this viewer: panes (IronBarsBlock: vertical faces hidden
 * between same panes, horizontal ones when both sides connect) and HalfTransparentBlock glass (same block hides shared faces).
 * Same rule as A1's mesher (src/render/mesher.ts).
 */
const GLASS_LIKE = /(^|_)(glass|ice|slime_block|honey_block)$|stained_glass$|tinted_glass$|framed_glass|^create:.*_window$/;
const PANE_LIKE = /_pane$|^minecraft:iron_bars$|_window_pane$/;
export function skipRendering(self: BlockState, adj: BlockState, face: Dir): boolean {
  if (self.name !== adj.name) return false;
  if (PANE_LIKE.test(self.name)) {
    if (face === 'up' || face === 'down') return true;
    return self.props[face] === 'true' && adj.props[OPPOSITE[face]] === 'true';
  }
  const n = self.name.replace(/^minecraft:/, '');
  return GLASS_LIKE.test(n) || GLASS_LIKE.test(self.name);
}

