// Native replacements for the few CreateSceneBuilder methods whose Java bodies run *scene runtime* code (belt simulation, particles,
// block-entity animation). Every other method of CreateSceneBuilder is interpreted from the real source.
import { Unsupported, num } from './values.mjs';
import { HOOKS } from './serialize.mjs';
import { SPECIAL } from './host/ponder.mjs';
import { mkList } from './host/lang.mjs';
import { STUB } from './interp.mjs';
import { JItemStack } from './host/blocks.mjs';
import { JParticle } from './host/ponder-classes.mjs';

const CSB = 'com.simibubi.create.foundation.ponder.CreateSceneBuilder';
const bp = (p) => [p.x, p.y, p.z];

export function installOverrides(rt, ctxOf) {
  const rec = (self) => self.hostBase.rec;
  const set = (inner, name, fn) => rt.nativeOverrides.set(`${CSB}.${inner}#${name}`, fn);
  const beIs = (r, pos, simpleName) => {
    const be = r.world.getBlockEntity([pos.x, pos.y, pos.z]);
    if (!be) return false;
    const cls = ctxOf.beClass(simpleName);
    return !!cls && !!be.entry.cls && rt.isSubclass(be.entry.cls, cls);
  };
  const note = (r, msg) => r.notes.push(`${r.src()}: ${msg}`);

  // ---- train tracks: TrackMaterial.ALL only ever holds Create's own andesite material (addon materials register themselves);
  // evaluating the real TrackMaterial builders drags in the whole recipe datagen layer, so allBlocks() is answered directly.
  rt.nativeOverrides.set('com.simibubi.create.content.trains.track.TrackMaterial#allBlocks', () => {
    const entry = rt.getStatic(rt.sourceClass('com.simibubi.create.AllBlocks'), 'TRACK');
    return mkList([{ $class: 'Supplier', get: () => entry }]);
  });

  // the material object itself is irrelevant for scene conversion (only the block's state definition matters)
  rt.nativeOverrides.set('com.simibubi.create.content.trains.track.TrackMaterialFactory#build', () => ({
    $class: 'TrackMaterial',
    $stub: true,
    $invoke(rt2, name, args) {
      if (name === 'createBlock') return rt2.newObject(rt2.sourceClass('com.simibubi.create.content.trains.track.TrackBlock'), [args[0], this], null);
      return STUB();
    },
    $getField: () => STUB(),
  }));

  // ---- data components: registered under the create namespace, serialised by id
  rt.nativeOverrides.set('com.simibubi.create.AllDataComponents#register', (rt2, self, args) => (typeof args[0] === 'string' ? { $class: 'DataComponentType', id: 'create:' + args[0], toJSON: () => ({ component: 'create:' + args[0] }), $key: () => 'comp:create:' + args[0] } : STUB()));

  // ---- packages: items are instantiated by the game at registration (PackageStyles lists), the random style pick is made deterministic
  const pkgStyles = () => rt.getStatic(rt.sourceClass('com.simibubi.create.content.logistics.box.PackageStyles'), 'STYLES');
  const pickBox = (rare) => {
    const styles = rt.iterate(pkgStyles()).filter((s) => rt.invoke(s, 'rare', []) === rare);
    const idx = (ctxOf.pkgRandom ||= ctxOf.makeRandom()).nextInt(styles.length);
    return new JItemStack(rt.invoke(rt.invoke(styles[idx], 'getItemId', []), 'toString', []), 1);
  };
  rt.nativeOverrides.set('com.simibubi.create.content.logistics.box.PackageStyles#getRandomBox', () => pickBox(false));
  rt.nativeOverrides.set('com.simibubi.create.content.logistics.box.PackageStyles#getDefaultBox', () => {
    const styles = rt.iterate(pkgStyles());
    return new JItemStack(rt.invoke(rt.invoke(styles[0], 'getItemId', []), 'toString', []), 1);
  });
  rt.nativeOverrides.set('com.simibubi.create.content.logistics.box.PackageItem#containing', (rt2, self, [stacks]) => {
    if (!(stacks && stacks.$iter)) throw new Unsupported('PackageItem.containing(ItemStackHandler) is not supported');
    // ItemStackHandler(9) + ItemHandlerHelper.insertItemStacked: merge into matching stacks up to 64, else the first free slot
    const slots = [];
    for (const s of stacks.$iter()) {
      let left = s.count;
      for (const sl of slots) if (left > 0 && sl.id === s.id && JSON.stringify(sl.comps) === JSON.stringify(s.comps) && sl.count < 64) {
        const t = Math.min(64 - sl.count, left);
        sl.count += t;
        left -= t;
      }
      while (left > 0 && slots.length < 9) {
        const t = Math.min(64, left);
        slots.push(new JItemStack(s.id, t, s.comps ? structuredClone(s.comps) : null));
        left -= t;
      }
    }
    const box = pickBox(false);
    box.set('create:package_contents', slots.map((s, i) => ({ slot: i, item: s.toNbt() })));
    return box;
  });

  // ---- scene helper that iterates a block entity's runtime package list: recorded as one named call
  rt.nativeOverrides.set('com.simibubi.create.infrastructure.ponder.scenes.highLogistics.FrogAndConveyorScenes#boxTransfer', (rt2, self, [to, from, be]) => {
    // for (pkg : be.getLoopingPackages()) { pkg.chainPosition = 0; be.addTravellingPackage(pkg, to.subtract(from)); remove from looping }
    be.$invoke(rt2, 'transferLoopingPackages', [to.subtract(from)]);
  });
  // fluid particle options depend on client fluid rendering extensions: recorded as data
  rt.nativeOverrides.set('com.simibubi.create.content.fluids.FluidFX#getFluidParticle', (rt2, self, [stack]) => new JParticle('create:fluid_particle', { fluid: stack.toJSON() }));

  // ---- WorldInstructions
  const animate = (kind, extraTicks = 0) => (rt2, self, [pos, dist, dur]) => {
    rec(self).emit('world.animateBlockEntity', { kind, pos: bp(pos), distance: num(dist), duration: num(dur) + extraTicks });
  };
  set('WorldInstructions', 'rotateBearing', animate('bearing'));
  set('WorldInstructions', 'movePulley', animate('pulley'));
  set('WorldInstructions', 'animateBogey', animate('bogey', 1));
  set('WorldInstructions', 'moveDeployer', animate('deployer'));
  set('WorldInstructions', 'createItemOnBeltLike', (rt2, self, [location, side, stack]) => {
    const r = rec(self);
    if (!beIs(r, location, 'SmartBlockEntity')) note(r, `createItemOnBeltLike: no SmartBlockEntity at ${bp(location)}`);
    r.emit('world.createItemOnBeltLike', { pos: bp(location), insertionSide: side.name_.toLowerCase(), item: stack.toJSONStack() });
    rt2.invokeObject(self, 'flapFunnel', [location.above(), true]);
  });
  set('WorldInstructions', 'createItemOnBelt', (rt2, self, [loc, side, stack]) => {
    const r = rec(self);
    if (!beIs(r, loc, 'BeltBlockEntity')) note(r, `createItemOnBelt: no BeltBlockEntity at ${bp(loc)}`);
    const link = r.newLink('BeltItemElement');
    r.emit('world.createItemOnBelt', { pos: bp(loc), insertionSide: side.name_.toLowerCase(), item: stack.toJSONStack() }, link.id);
    rt2.invokeObject(self, 'flapFunnel', [loc.above(), true]);
    return link;
  });
  set('WorldInstructions', 'removeItemsFromBelt', (rt2, self, [loc]) => {
    rec(self).emit('world.removeItemsFromBelt', { pos: bp(loc) });
  });
  set('WorldInstructions', 'stallBeltItem', (rt2, self, [link, stalled]) => {
    rec(self).emit('world.stallBeltItem', { link: HOOKS.linkJSON(link), stalled: !!stalled });
  });
  set('WorldInstructions', 'changeBeltItemTo', (rt2, self, [link, stack]) => {
    rec(self).emit('world.changeBeltItemTo', { link: HOOKS.linkJSON(link), item: stack.toJSONStack() });
  });
  set('WorldInstructions', 'connectCrafterInvs', (rt2, self, [a, b]) => {
    rec(self).emit('world.connectCrafterInvs', { pos1: bp(a), pos2: bp(b) });
  });
  set('WorldInstructions', 'markSmartBlockEntityVirtual', () => undefined);

  // ---- EffectInstructions
  set('EffectInstructions', 'superGlue', (rt2, self, [pos, side, full]) => {
    rec(self).emit('effects.superGlue', { pos: bp(pos), side: side.name_.toLowerCase(), fullBlock: !!full });
  });
  set('EffectInstructions', 'rotationIndicator', (rt2, self, [pos, direction, displayPos]) => {
    const r = rec(self);
    if (!beIs(r, pos, 'KineticBlockEntity')) {
      note(r, `rotationIndicator: no KineticBlockEntity at ${bp(pos)}`);
      return;
    }
    r.emit('effects.rotationIndicator', { pos: bp(displayPos), direction: !!direction });
  });

  // ---- SpecialInstructions
  set('SpecialInstructions', 'createBirb', (rt2, self, [location, pose]) => SPECIAL.createBirb(rec(self), location, pose));
  set('SpecialInstructions', 'conductorBirb', (rt2, self, [birb, conductor]) => {
    rec(self).emit('special.conductorBirb', { link: HOOKS.linkJSON(birb), conductor: !!conductor });
  });
}
