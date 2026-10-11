import { resources, type ResLoc } from '../assets/resources';

/** Texture PNG as an ImageBitmap (straight alpha), or null when it does not exist. */
export async function textureBitmap(loc: ResLoc): Promise<ImageBitmap | null> {
  const buf = (await resources.file({ ns: loc.ns, path: `textures/${loc.path}.png` }, 'buffer')) as ArrayBuffer | null;
  return buf ? createImageBitmap(new Blob([buf], { type: 'image/png' }), { premultiplyAlpha: 'none' }) : null;
}
