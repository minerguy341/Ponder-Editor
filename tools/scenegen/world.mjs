// Scene world model: mirrors Ponder's PonderLevel (Catnip SchematicLevel) closely enough to resolve block-state lambdas and
// block-entity type filters at conversion time.
import fs from 'node:fs';
import { cachePath } from './fetch.mjs';
import { readNbtGz } from './nbt.mjs';
import { JCompound } from './host/nbtobj.mjs';
import { vanillaBlock, JBlock } from './host/blocks.mjs';
import { Entry } from './host/registry.mjs';
import { Unsupported } from './values.mjs';

const key = (x, y, z) => `${x},${y},${z}`;

export class BE {
  constructor(entry, nbt) {
    this.entry = entry;
    this.nbt = nbt; // JCompound
  }
}

export class World {
  constructor(rt, registry) {
    this.rt = rt;
    this.registry = registry;
    this.blocks = new Map(); // key -> {pos:[x,y,z], state}
    this.bes = new Map(); // key -> BE
    this.bounds = { min: [0, 0, 0], max: [0, 0, 0] };
    this.original = null;
    this.entities = [];
    this.palette = [];
    this.notes = [];
    this.validIds = new Map(); // BE Entry -> Set of block ids
  }

  // ---- registry lookups
  resolveBlock(name) {
    // NbtUtils.readBlockState: a block missing from the registry becomes air
    if (name.startsWith('create:')) {
      const e = this.registry.blocks.get(name);
      if (e) return e.block();
    } else {
      const b = vanillaBlock(name);
      if (b) return b;
    }
    this.notes.push(`palette: unknown block ${name} is loaded as air (as in the game)`);
    return vanillaBlock('minecraft:air');
  }

  stateFromPalette(p) {
    const block = this.resolveBlock(p.Name);
    let st = block.defaultState;
    for (const [k, v] of Object.entries(p.Properties || {})) {
      const prop = block.props.find((q) => q.name === k);
      if (!prop) {
        this.notes.push(`palette: ${p.Name} has no property ${k} (ignored, as in the game)`);
        continue;
      }
      const val = prop.parse(String(v));
      if (val === undefined) {
        this.notes.push(`palette: ${p.Name}[${k}=${v}] is not an allowed value (ignored, as in the game)`);
        continue;
      }
      st = st.setValue(prop, val);
    }
    return st;
  }

  beEntryFor(state) {
    return this.registry.blockToBe.get(state.block.id) || null;
  }

  beAccepts(entry, state) {
    let s = this.validIds.get(entry);
    if (!s) {
      s = new Set();
      for (const vb of entry.validBlocks) {
        const id = vb instanceof Entry ? vb.id : vb instanceof JBlock ? vb.id : vb && vb.hostBase ? vb.hostBase.id : null;
        if (id) s.add(id);
      }
      this.validIds.set(entry, s);
    }
    return s.has(state.block.id);
  }

  // ---- loading
  loadSchematic(path) {
    const file = cachePath('create', `/src/main/resources/assets/create/ponder/${path}.nbt`);
    if (!fs.existsSync(file)) throw new Unsupported(`schematic ${path} not cached`);
    const nbt = readNbtGz(fs.readFileSync(file));
    const palette = (nbt.palette || (nbt.palettes && nbt.palettes[0]) || []).map((p) => this.stateFromPalette(p));
    this.palette = palette;
    this.size = nbt.size;
    // StructureTemplate.placeInWorld: every listed block is placed (air included), bounds encapsulate each position and start at 0,0,0
    for (const b of nbt.blocks || []) {
      const [x, y, z] = b.pos;
      this.setBlock([x, y, z], palette[b.state]);
      if (b.nbt) {
        const be = this.getBlockEntity([x, y, z]);
        if (be) {
          const c = JCompound.fromJSON(b.nbt);
          be.nbt = c;
        }
      }
    }
    this.entities = (nbt.entities || []).map((e) => ({ pos: e.pos, blockPos: e.blockPos, nbt: e.nbt }));
    this.createBackup();
    return nbt;
  }

  createBackup() {
    this.original = {
      blocks: new Map([...this.blocks].map(([k, v]) => [k, v])),
      bes: new Map([...this.bes].map(([k, v]) => [k, { entry: v.entry, nbt: v.nbt.copy() }])),
    };
  }

  restoreBlocks(positions) {
    for (const [x, y, z] of positions) {
      const k = key(x, y, z);
      if (this.original.blocks.has(k)) this.blocks.set(k, this.original.blocks.get(k));
      if (this.original.bes.has(k)) {
        const o = this.original.bes.get(k);
        this.bes.set(k, new BE(o.entry, o.nbt.copy()));
      }
    }
  }

  // ---- queries
  inside(pos) {
    const { min, max } = this.bounds;
    return pos[0] >= min[0] && pos[0] <= max[0] && pos[1] >= min[1] && pos[1] <= max[1] && pos[2] >= min[2] && pos[2] <= max[2];
  }

  getState(pos) {
    const e = this.blocks.get(key(pos[0], pos[1], pos[2]));
    return e ? e.state : null;
  }

  isAirDefault(state) {
    return state === null || state === this.airDefault();
  }

  airDefault() {
    if (!this._air) this._air = vanillaBlock('minecraft:air').defaultState;
    return this._air;
  }

  getBlockEntity(pos) {
    const k = key(pos[0], pos[1], pos[2]);
    if (this.bes.has(k)) return this.bes.get(k);
    const st = this.getState(pos);
    if (!st) return null;
    const entry = this.beEntryFor(st);
    if (!entry) return null;
    const be = new BE(entry, new JCompound());
    this.bes.set(k, be);
    return be;
  }

  /** SchematicLevel.setBlock */
  setBlock(pos, state) {
    const [x, y, z] = pos;
    const k = key(x, y, z);
    const b = this.bounds;
    b.min = [Math.min(b.min[0], x), Math.min(b.min[1], y), Math.min(b.min[2], z)];
    b.max = [Math.max(b.max[0], x), Math.max(b.max[1], y), Math.max(b.max[2], z)];
    this.blocks.set(k, { pos: [x, y, z], state });
    const be = this.bes.get(k);
    if (be && !this.beAccepts(be.entry, state)) this.bes.delete(k);
    this.getBlockEntity(pos);
  }

  /** all positions of a lowered selection inside the bounds (deterministic order: x fastest, then y, then z) */
  *positions(sel) {
    for (const p of sel.positions()) if (this.inside(p)) yield p;
  }
}
