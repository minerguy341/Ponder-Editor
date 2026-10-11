// Scene-time events for the logistics simulation (belts, depots, funnels, tunnels). Leaf B2 owns this file; the scene player
// (C2) translates the Create scene ops below into these events.
//
// Why: Ponder runs Create's real block entities, so items on belts MOVE between instructions (BeltInventory.tick) and
// funnels/tunnels flap when items pass. The web player has no Java, so B2's `LogisticsWorld` (items/logisticsSim.ts) ports
// the behaviour (belt movement, spacing, locking, belt -> belt / depot hand-over, belt funnels, tunnels) as a deterministic
// simulation advanced by scene ticks. It needs to be told what the *instructions* did:
//
//   world.createItemOnBelt     -> { op: 'createItemOnBelt',     pos, insertionSide, item, link: <instruction.out> }
//   world.createItemOnBeltLike -> { op: 'createItemOnBeltLike', pos, insertionSide, item }
//   world.removeItemsFromBelt  -> { op: 'removeItemsFromBelt',  pos }
//   world.stallBeltItem        -> { op: 'stallBeltItem',        link, stalled }
//   world.changeBeltItemTo     -> { op: 'changeBeltItemTo',     link, item }
//   world.modifyBlockEntityNBT -> { op: 'nbt', pos, patch }          (any BE: Speed, Casing, Dye, HeldItem, Filter, ...)
//   modifyBlockEntity(FunnelBlockEntity.flap(inward)) / TunnelBlockEntity flaps -> { op: 'flap', pos, inward }
//
// Delivery (either works, both land in the same place):
//   getLogisticsWorld(ctx).apply({ tick, ...event })        // ctx = the VisualContext given to the visual factory
//   visual.setData({ $ev: { tick, ...event } })            // routed through the belt/depot/funnel visual at `pos`
// `tick` is the SCENE TICK at which the instruction executes (integer or fractional). It MUST be supplied when the player
// fast-forwards (seek / replay), because visuals only learn the time through update(ticks); without it the event is stamped
// with the last tick seen by update().
//
// Seeking backwards: the simulation keeps an event log and replays it from tick 0 (cheap: a handful of items). A player that
// instead rebuilds the whole scene on seek simply re-sends the events with their original ticks.
//
// Plain NBT patches to B2 blocks (e.g. {Speed: 32} through BlockVisual.setData, from world.modifyBlockEntityNBT) are forwarded
// automatically into the log as { op: 'nbt' } with the tick of the last update().

import type { Direction, ItemStackJson, Vec3 } from '../../../contract';

export type LogisticsEvent = { tick?: number } & (
  | { op: 'createItemOnBelt'; pos: Vec3; insertionSide: Direction; item: ItemStackJson; link?: string }
  | { op: 'createItemOnBeltLike'; pos: Vec3; insertionSide: Direction; item: ItemStackJson }
  | { op: 'removeItemsFromBelt'; pos: Vec3 }
  | { op: 'stallBeltItem'; link: string; stalled: boolean }
  | { op: 'changeBeltItemTo'; link: string; item: ItemStackJson }
  | { op: 'nbt'; pos: Vec3; patch: Record<string, unknown> }
  | { op: 'flap'; pos: Vec3; inward: boolean }
  | { op: 'flapTunnel'; pos: Vec3; side: Direction; inward: boolean }
);
