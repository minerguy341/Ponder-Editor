// Classification of the dropped-call audit (C1 gate G8). Each rule states why an event is cosmetic or legitimately empty (with the
// Java / Ponder source it mirrors) or marks it `state`. Anything matching no rule is unclassified and fails the gate.
export const CLASS_TEXT = {
  cosmetic: 'no effect on scene state or on the timeline: particles, audio, rendering path, debug',
  metadata: 'not a timeline element: the value is a SceneJson field (title, keyframes)',
  getter: 'returns a handle or value; the state change, if any, is a separate recorded op',
  'link-binding': 'binds an element link to the element created by an earlier op (emitted with its out id)',
  'legit-empty': 'Java also changes nothing here: the instanceof test fails, the selection holds no matching block or value, or the value already equals the requested one (evidence in the detail column)',
  state: 'state-affecting and visible: must be zero (it would have to become an op or a Call)',
};

const SOUND_DOOR = 'Create TRAIN_SET_TYPE (SlidingDoorBlock.java:46-49): BlockSetType and SoundType/SoundEvents arguments only drive door, plate and button sounds and pressure-plate sensitivity; the block state of the door comes from its blockstate definition, so no scene op depends on it';

const RULES = [
  // ---- scene metadata
  { kind: 'noEmit', owner: 'BASE', method: 'title', cls: 'metadata', why: 'title(id, text) sets SceneJson.title/titleId' },
  { kind: 'noEmit', owner: 'BASE', method: 'addKeyframe', cls: 'metadata', why: 'addKeyframe() records keyframes[] (PonderSceneBuilder: KeyframeInstruction.IMMEDIATE)' },
  { kind: 'noEmit', owner: 'BASE', method: 'addLazyKeyframe', cls: 'metadata', why: 'addLazyKeyframe() records keyframes[] at scene time + 6 (KeyframeInstruction.DELAYED)' },
  // ---- getters
  { kind: 'noEmit', owner: 'WORLD', method: 'getHolderLookupProvider', cls: 'getter', why: 'returns the registry-lookup handle used by Create for NBT (de)serialisation of stacks; no state' },
  // ---- cosmetic
  { kind: 'override', owner: 'WorldInstructions', method: 'markSmartBlockEntityVirtual', cls: 'cosmetic', why: 'SmartBlockEntity.markVirtual() (CreateSceneBuilder.java:324-329) selects the rendering path (Flywheel visual instead of the BE renderer); data unchanged' },
  { kind: 'noEmit', owner: 'EFFECTS', method: 'simpleParticleEmitter', cls: 'cosmetic', why: 'factory for a ParticleEmitter value (Ponder EffectInstructions); the emission is the separate effects.emitParticles op' },
  { kind: 'noEmit', owner: 'EFFECTS', method: 'particleEmitterWithinBlockSpace', cls: 'cosmetic', why: 'factory for a ParticleEmitter value (ParticleEmitter.withinBlock); emission is effects.emitParticles' },
  { kind: 'stubClass', owner: 'SoundEvents', method: '*', cls: 'cosmetic', why: SOUND_DOOR, match: /SlidingDoorBlock\.java/ },
  { kind: 'stubClass', owner: 'SoundType', method: '*', cls: 'cosmetic', why: SOUND_DOOR, match: /SlidingDoorBlock\.java/ },
  { kind: 'stubClass', owner: 'BlockSetType', method: '*', cls: 'cosmetic', why: SOUND_DOOR, match: /SlidingDoorBlock\.java/ },
  { kind: 'stubCall', owner: 'Stub', method: 'field EVERYTHING', cls: 'cosmetic', why: SOUND_DOOR, match: /SlidingDoorBlock\.java/ },
  // ---- link binding
  { kind: 'noEmit', owner: 'BASE', method: 'addInstruction', cls: 'link-binding', why: 'FrogAndConveyorScenes.java:242 `scene.addInstruction(s -> s.linkElement(element, parrot))`: binds the parrot link; the parrot itself is the createBirb op with out e3', match: /FrogAndConveyorScenes\.java:242/ },
];

const BLOCK_GUARDS = []; // no state rules are accepted

/** Companion rules: a no-emit of a world call is legitimate when the same call recorded its reason (same scene and Java location). */
const COMPANIONS = {
  'WORLD.modifyBlockEntity': { kinds: ['beMissing', 'beNotInstance'], cls: 'legit-empty', why: 'modifyBlockEntity(pos, Class, ...) is a no-op when the block entity at pos is absent or not an instance of Class (Java instanceof; the converter decides with the registry class and the BE class is known, see beUnknownClass)' },
  'WORLD.modifyBlockEntityNBT': { kinds: ['noTarget', 'nbtUnchanged'], cls: 'legit-empty', why: 'modifyBlockEntityNBT applies only to instances of the class; when no instance exists or the consumer leaves the data equal, Java emits no change' },
  'WORLD.modifyBlocks': { kinds: ['noChange'], cls: 'legit-empty', why: 'modifyBlocks/modifyBlock/toggleRedstonePower/replaceBlocks change nothing: targets are air or outside the scene (Ponder ReplaceBlocksInstruction skips air unless replaceAir), or the function returns the same state' },
};
const WORLD_FOR_COMPANION = {
  'WORLD.modifyBlock': 'WORLD.modifyBlocks',
  'WORLD.toggleRedstonePower': 'WORLD.modifyBlocks',
  'WORLD.replaceBlocks': 'WORLD.modifyBlocks',
};

export function classify(entries) {
  const byKey = new Map();
  const groups = new Map();
  const perScene = new Map();
  const unclassified = [];
  const state = [];
  const byClass = new Map();
  const whereKey = (e) => `${e.scene}|${e.where}`;
  // companions index: (scene, where) -> kinds recorded there
  const companions = new Map();
  for (const e of entries) {
    const k = whereKey(e);
    if (!companions.has(k)) companions.set(k, []);
    companions.get(k).push(e.kind);
  }
  const classOf = (e) => {
    const full = `${e.owner}.${e.method}`;
    if (e.kind === 'beUnknownClass') return { cls: 'state', why: 'the converter cannot decide instanceof for this block-entity class' };
    if (e.kind === 'beLost') return { cls: 'state', why: 'a block in the target holds a block entity of the requested class in the registry, but the world model has none' };
    for (const r of RULES) {
      if (r.kind !== e.kind) continue;
      if (r.owner !== e.owner && r.owner !== '*') continue;
      if (r.method !== e.method && r.method !== '*') continue;
      if (r.match && !r.match.test(e.where)) continue;
      return { cls: r.cls, why: r.why };
    }
    if (e.kind === 'noEmit' && COMPANIONS[full]) {
      const ok = (companions.get(whereKey(e)) || []).some((k) => COMPANIONS[full].kinds.includes(k));
      if (ok) return { cls: COMPANIONS[full].cls, why: COMPANIONS[full].why };
      return null;
    }
    if (e.kind === 'noEmit' && WORLD_FOR_COMPANION[full]) {
      const comp = COMPANIONS[WORLD_FOR_COMPANION[full]];
      const ok = (companions.get(whereKey(e)) || []).some((k) => comp.kinds.includes(k));
      if (ok) return { cls: comp.cls, why: comp.why };
      return null;
    }
    if (e.kind === 'beMissing' || e.kind === 'beNotInstance') return { cls: 'legit-empty', why: 'block-entity instanceof test fails at the target (see detail); Java does nothing' };
    if (e.kind === 'noTarget') return { cls: 'legit-empty', why: 'no block-entity instance of the requested class in the selection (see detail)' };
    if (e.kind === 'nbtUnchanged') return { cls: 'legit-empty', why: 'the consumer left the matched block entity data equal (see detail: the value is already present)' };
    if (e.kind === 'noChange') return { cls: 'legit-empty', why: 'targets already hold the requested state, are air or outside the scene (see detail)' };
    return null;
  };
  for (const e of entries) {
    const c = classOf(e);
    const method = e.method.replace(/^at \d+,\d+,\d+$/, 'at <pos>');
    const gkey = `${e.kind}|${e.owner}|${method}`;
    if (!groups.has(gkey)) groups.set(gkey, { kind: e.kind, owner: e.owner, method, count: 0, scenes: new Set(), cls: null, why: null });
    const g = groups.get(gkey);
    g.count++;
    g.scenes.add(e.scene);
    if (!perScene.has(e.scene)) perScene.set(e.scene, { scene: e.scene, n: 0, state: 0, unclassified: 0 });
    const ps = perScene.get(e.scene);
    ps.n++;
    if (!c) {
      unclassified.push(e);
      ps.unclassified++;
      g.cls = g.cls || 'UNCLASSIFIED';
      continue;
    }
    if (c.cls === 'state') {
      state.push(e);
      ps.state++;
    }
    byClass.set(c.cls, (byClass.get(c.cls) || 0) + 1);
    g.cls = g.cls && g.cls !== c.cls ? 'mixed' : c.cls;
    g.why = g.why || c.why;
  }
  return {
    groups: [...groups.values()].sort((a, b) => b.count - a.count),
    unclassified,
    state,
    byClass,
    perScene: [...perScene.values()].sort((a, b) => a.scene.localeCompare(b.scene)),
  };
}
