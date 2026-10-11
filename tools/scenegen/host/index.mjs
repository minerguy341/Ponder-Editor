import { HostRegistry } from './base.mjs';
import { buildLang } from './lang.mjs';
import { buildMc } from './mc.mjs';
import { buildBlocks } from './blocks.mjs';
import { buildVanillaBlocks } from './vanilla-blocks.mjs';
import { buildRegistry, RegistryModel } from './registry.mjs';

export function buildHost() {
  const R = new HostRegistry();
  buildLang(R);
  buildMc(R);
  const blockBase = buildBlocks(R);
  buildVanillaBlocks(R, blockBase);
  const registry = new RegistryModel();
  buildRegistry(R, registry);
  return { R, registry };
}
