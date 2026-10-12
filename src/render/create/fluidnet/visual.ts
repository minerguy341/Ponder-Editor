// Shared plumbing of the F1 fluid visuals: the scene's fluid world, pipe attachment models and glass streams.
// A visual reads the fluid world at its own scene time (`update(ticks)`), so every frame samples the same pure state the
// seek/replay contract needs. Attachment and stream geometry is rebuilt only when its signature changes.
//
// FluidDecor is composed into the visuals (BaseVisual is a class, a visual may also be kinetic):
//   decor.preload(ctx)                 in build()
//   decor.sync(ticks, state)           in onUpdate(): attachments of the state, glass streams of the flows

import * as THREE from 'three';
import type { BlockState, Direction, VisualContext } from '../../../contract';
import { PARTIAL, markOwned, peekPartial, preloadPartials, disposeVisualObject } from '../common';
import { DIRECTIONS } from '../common/dirs';
import type { BlockRendererImpl } from '../../blockRenderer';
import { fluidSpriteIds } from '../../fluids';
import type { FluidWorld } from './world';
import { attachmentsOf, ATTACHMENT_PARTS, casingOf, type Attachment } from './attachments';
import { pipeAttachment } from '../common/partialModels';
import { streamGroup } from './stream';
import { isEmptyFluid } from './model';
import { PIPE_GLASS } from './topology';

/** every fluid texture a fluid visual may draw (streams, fluid boxes) */
export const FLUID_TEXTURE_IDS = ['minecraft:water', 'minecraft:lava', 'create:honey', 'create:chocolate'].flatMap((f) => fluidSpriteIds(f));

const COMPONENTS = ['connection', 'rim_connector', 'rim', 'drain'] as const;

/** every attachment partial, for preloading */
export function attachmentPartialIds(): string[] {
  const out: string[] = [];
  for (const c of COMPONENTS) for (const d of DIRECTIONS) out.push(pipeAttachment(c, d));
  out.push(PARTIAL.FLUID_PIPE_CASING);
  return out;
}

/** the fractional part of a continuous scene time */
export function partialOf(ticks: number): number {
  return ticks - Math.floor(ticks);
}

export class FluidDecor {
  private readonly attachments = new THREE.Group();
  private attachSig = '';
  private readonly streams = new Map<Direction, { sig: string; group: THREE.Group }>();

  constructor(
    private readonly fluid: FluidWorld,
    private readonly ctx: VisualContext,
    private readonly parent: THREE.Object3D,
    private readonly pos: readonly [number, number, number],
  ) {
    this.attachments.name = 'attachments';
    parent.add(this.attachments);
  }

  private get renderer(): BlockRendererImpl {
    return this.ctx.renderer as BlockRendererImpl;
  }

  async preload(): Promise<void> {
    await preloadPartials(this.ctx, attachmentPartialIds());
    await this.renderer.ensureTextures(FLUID_TEXTURE_IDS);
  }

  /**
   * Rim, connector and drain models of the block (AllPartialModels.PIPE_ATTACHMENTS) and the casing of a fluid pipe.
   * Rebuilt when the attachment list of the current state changes.
   */
  syncAttachments(state: BlockState): void {
    const list = attachmentsOf(this.fluid, [this.pos[0], this.pos[1], this.pos[2]], state);
    const casing = casingOf(state);
    const sig = JSON.stringify([list, casing]);
    if (sig === this.attachSig) return;
    this.attachSig = sig;
    for (const c of [...this.attachments.children]) {
      this.attachments.remove(c);
      disposeVisualObject(c);
    }
    for (const { d, a } of list) {
      for (const part of ATTACHMENT_PARTS[a as Attachment]) {
        const o = peekPartial(this.ctx, pipeAttachment(part, d));
        if (o) this.attachments.add(o);
      }
    }
    if (casing) {
      const o = peekPartial(this.ctx, PARTIAL.FLUID_PIPE_CASING);
      if (o) this.attachments.add(o);
    }
  }

  /** Glass pipe streams of the connections that hold a fluid flow (TransparentStraightPipeRenderer). Only glass pipes draw them. */
  syncStreams(ticks: number, state: BlockState): void {
    if (state.name !== PIPE_GLASS) return;
    const node = this.fluid.nodeAt([this.pos[0], this.pos[1], this.pos[2]]);
    const pt = partialOf(ticks);
    for (const d of DIRECTIONS) {
      const flow = node?.getFlow(d) ?? null;
      const prev = this.streams.get(d);
      if (!flow || isEmptyFluid(flow.fluid)) {
        if (prev) prev.group.visible = false;
        continue;
      }
      const progress = flow.progressPrev + (flow.progress - flow.progressPrev) * pt;
      const sig = `${flow.fluid.fluid}|${flow.inbound}|${Math.round(progress * 512)}`;
      if (prev && prev.sig === sig) { prev.group.visible = true; continue; }
      if (prev) { this.parent.remove(prev.group); disposeVisualObject(prev.group); this.streams.delete(d); }
      const g = streamGroup(this.renderer, flow.fluid.fluid, d, progress, flow.inbound);
      if (!g) continue;
      g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) markOwned(m.geometry); });
      this.parent.add(g);
      this.streams.set(d, { sig, group: g });
    }
  }
}
