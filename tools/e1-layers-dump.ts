// E1 model audit helper: dumps the TypeScript layer definitions as plain data (bundled by tools/e1-model-audit.mjs with esbuild).
import { createParrotLayer } from '../src/render/entities/parrot';
import { createMinecartLayer } from '../src/render/entities/minecart';
import { createBlazeLayer, createSheepFurLayer, createSheepLayer } from '../src/render/entities/living';
import type { PartDefinition } from '../src/render/entities/modelPart';
import type { LayerDefinition } from '../src/render/entities/modelPart';

function dumpPart(name: string, def: PartDefinition): unknown {
  return {
    name,
    pose: def.pose,
    cubes: def.cubes.map((c) => ({
      u: c.u, v: c.v, x: c.minX, y: c.minY, z: c.minZ, w: c.sizeX, h: c.sizeY, d: c.sizeZ,
      grow: [c.grow.growX, c.grow.growY, c.grow.growZ], mirror: c.mirror,
    })),
    children: [...def.children].map(([n, c]) => dumpPart(n, c)),
  };
}

function dumpLayer(layer: LayerDefinition): unknown {
  return dumpPart('root', (layer.mesh as unknown as { getRoot(): PartDefinition }).getRoot());
}

export function dumpLayers(): Record<string, unknown> {
  return {
    parrot: dumpLayer(createParrotLayer()),
    minecart: dumpLayer(createMinecartLayer()),
    blaze: dumpLayer(createBlazeLayer()),
    sheep: dumpLayer(createSheepLayer()),
    sheepFur: dumpLayer(createSheepFurLayer()),
  };
}

// when bundled and run as a script, print the dump as JSON
const g = globalThis as unknown as { process?: { argv?: string[] } };
if (g.process?.argv?.includes('--json')) console.log(JSON.stringify(dumpLayers()));
