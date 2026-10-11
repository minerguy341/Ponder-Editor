// Vanilla block base classes that Create's block classes extend. Their blockstate definition is derived from the matching vanilla block in
// minecraft-data (property set and the default state set by the vanilla constructor); abstract bases that add nothing have no properties.
import { hc, Unsupported, getRT } from './base.mjs';
import { JBlock, vanillaBlock, vanillaProperty } from './blocks.mjs';

/**
 * name: vanilla class, ref: vanilla block id whose blockstate definition equals the class's own, props: undefined => all of ref,
 * statics: Java constant name -> BlockStateProperties constant
 */
const BASES = [
  ['DirectionalBlock', { props: [], statics: { FACING: 'FACING' } }],
  ['HorizontalDirectionalBlock', { props: [], statics: { FACING: 'HORIZONTAL_FACING' } }],
  ['FaceAttachedHorizontalDirectionalBlock', { props: [], extends: 'HorizontalDirectionalBlock', statics: { FACE: 'ATTACH_FACE', FACING: 'HORIZONTAL_FACING' } }],
  ['DiodeBlock', { props: [], extends: 'HorizontalDirectionalBlock', statics: { POWERED: 'POWERED', FACING: 'HORIZONTAL_FACING' } }],
  ['RotatedPillarBlock', { ref: 'oak_log', statics: { AXIS: 'AXIS' } }],
  ['DoorBlock', { ref: 'oak_door', statics: { FACING: 'HORIZONTAL_FACING', OPEN: 'OPEN', HINGE: 'DOOR_HINGE', POWERED: 'POWERED', HALF: 'DOUBLE_BLOCK_HALF' } }],
  ['TrapDoorBlock', { ref: 'oak_trapdoor', statics: { FACING: 'HORIZONTAL_FACING', OPEN: 'OPEN', HALF: 'HALF', POWERED: 'POWERED', WATERLOGGED: 'WATERLOGGED' } }],
  ['LadderBlock', { ref: 'ladder', statics: { FACING: 'HORIZONTAL_FACING', WATERLOGGED: 'WATERLOGGED' } }],
  ['ScaffoldingBlock', { ref: 'scaffolding', statics: { WATERLOGGED: 'WATERLOGGED', DISTANCE: 'STABILITY_DISTANCE', BOTTOM: 'BOTTOM' } }],
  ['BaseRailBlock', { props: [], statics: { WATERLOGGED: 'WATERLOGGED' } }],
  ['BellBlock', { ref: 'bell', statics: { FACING: 'HORIZONTAL_FACING', ATTACHMENT: 'BELL_ATTACHMENT', POWERED: 'POWERED' } }],
  ['PipeBlock', { props: [], statics: { NORTH: 'NORTH', EAST: 'EAST', SOUTH: 'SOUTH', WEST: 'WEST', UP: 'UP', DOWN: 'DOWN' }, extra: 'PROPERTY_BY_DIRECTION' }],
  ['LecternBlock', { ref: 'lectern', statics: { FACING: 'HORIZONTAL_FACING', POWERED: 'POWERED', HAS_BOOK: 'HAS_BOOK' } }],
  ['IronBarsBlock', { ref: 'iron_bars', statics: { NORTH: 'NORTH', EAST: 'EAST', SOUTH: 'SOUTH', WEST: 'WEST', WATERLOGGED: 'WATERLOGGED' } }],
  ['CrossCollisionBlock', { props: [], statics: { NORTH: 'NORTH', EAST: 'EAST', SOUTH: 'SOUTH', WEST: 'WEST', WATERLOGGED: 'WATERLOGGED' } }],
  ['SlabBlock', { ref: 'oak_slab', statics: { TYPE: 'SLAB_TYPE', WATERLOGGED: 'WATERLOGGED' } }],
  ['StairBlock', { ref: 'oak_stairs', statics: { FACING: 'HORIZONTAL_FACING', HALF: 'HALF', SHAPE: 'STAIRS_SHAPE', WATERLOGGED: 'WATERLOGGED' } }],
  ['WallBlock', { ref: 'cobblestone_wall', statics: { UP: 'UP', NORTH_WALL: 'NORTH_WALL', EAST_WALL: 'EAST_WALL', SOUTH_WALL: 'SOUTH_WALL', WEST_WALL: 'WEST_WALL', WATERLOGGED: 'WATERLOGGED' } }],
  ['LeverBlock', { ref: 'lever', statics: { POWERED: 'POWERED' } }],
  ['ButtonBlock', { ref: 'stone_button', statics: { POWERED: 'POWERED' } }],
  ['RedStoneWireBlock', { ref: 'redstone_wire', statics: { POWER: 'POWER' } }],
  ['RedstoneTorchBlock', { ref: 'redstone_torch', statics: { LIT: 'LIT' } }],
  ['DoublePlantBlock', { ref: 'tall_grass', statics: { HALF: 'DOUBLE_BLOCK_HALF' } }],
  ['CropBlock', { props: [], statics: { AGE: 'AGE_7' } }],
  ['BeehiveBlock', { ref: 'beehive', statics: { FACING: 'HORIZONTAL_FACING', HONEY_LEVEL: 'LEVEL_HONEY' } }],
  ['HopperBlock', { ref: 'hopper', statics: { FACING: 'FACING_HOPPER', ENABLED: 'ENABLED' } }],
  ['ChestBlock', { ref: 'chest', statics: { FACING: 'HORIZONTAL_FACING', WATERLOGGED: 'WATERLOGGED' } }],
  ['BaseEntityBlock', { props: [], extends: 'Block', statics: {} }],
  ['FurnaceBlock', { ref: 'furnace', statics: { FACING: 'HORIZONTAL_FACING', LIT: 'LIT' } }],
  ['AbstractFurnaceBlock', { props: [], statics: { FACING: 'HORIZONTAL_FACING', LIT: 'LIT' } }],
  ['SimpleWaterloggedBlock', { isInterface: true }],
  ['BonemealableBlock', { isInterface: true }],
  ['EntityBlock', { isInterface: true }],
  ['WorldlyContainerHolder', { isInterface: true }],
  ['ItemLikeBlock', { isInterface: true }],
];

export function buildVanillaBlocks(R, blockBase) {
  for (const [name, spec] of BASES) {
    if (spec.isInterface) {
      R.add(hc(name, { isInterface: true }));
      continue;
    }
    const statics = {};
    for (const [jn, constant] of Object.entries(spec.statics || {})) {
      const f = () => vanillaProperty(constant);
      f.$lazy = true;
      statics[jn] = f;
    }
    let cachedProps = null;
    const props = () => {
      if (cachedProps) return cachedProps;
      if (spec.props) cachedProps = { props: [], defaults: new Map() };
      else {
        const ref = vanillaBlock(spec.ref);
        if (!ref) throw new Unsupported(`vanilla reference block ${spec.ref} not found`);
        cachedProps = { props: ref.props.slice(), defaults: ref.defaultState.vals };
      }
      return cachedProps;
    };
    if (spec.extra === 'PROPERTY_BY_DIRECTION') {
      const f = () => {
        const rt = getRT();
        const m = rt.hostClass('Map').construct(rt, []);
        const D = rt.hostClass('Direction').statics;
        for (const [d, c] of [['NORTH', 'NORTH'], ['EAST', 'EAST'], ['SOUTH', 'SOUTH'], ['WEST', 'WEST'], ['UP', 'UP'], ['DOWN', 'DOWN']]) m.put(D[d], vanillaProperty(c));
        return m;
      };
      f.$lazy = true;
      statics.PROPERTY_BY_DIRECTION = f;
    }
    const cls = hc(name, {
      extends: [spec.extends || 'Block'],
      statics,
      isVanillaBlockBase: true,
      initInstance: blockBase.initInstance,
      construct(rt2) {
        const jb = new JBlock(null);
        const { props: ps, defaults } = props();
        jb.props = ps.slice();
        const m = new Map();
        for (const p of jb.props) {
          let val = p.values[0];
          for (const [dp, dv] of defaults) if (dp.name === p.name && p.index(dv) >= 0) val = dv;
          m.set(p, val);
        }
        jb.buildDefault(jb.intern(m));
        jb.vanillaBases = [name];
        return jb;
      },
      methods: {
        ...blockBase.methods,
        createBlockStateDefinition: (rt, obj, [sb]) => {
          const { props: ps } = props();
          sb.add(...ps);
        },
      },
      // default state set by the vanilla constructor, applied by Block.initInstance after the definition is built
      vanillaDefaults: () => props().defaults,
      is: (v) => v instanceof JBlock && v.vanillaBases?.includes(name),
    });
    R.add(cls);
  }
}
