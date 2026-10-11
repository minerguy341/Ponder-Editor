// NeoForge composite block models (`loader: neoforge:composite`): the geometry lives in `children`, each with its own inline
// `elements` and `textures`. Create uses them for many item models (display link, stock link, nixie tube). The children are
// flattened into one element list whose face textures are made absolute, so children that reuse texture keys ("0", "1")
// keep their own sprite. Pure: no resource access (see itemIcons.ts resolveModel).

export interface CompositeFace { texture?: string; [k: string]: unknown }
export interface CompositeElement { faces?: Record<string, CompositeFace>; [k: string]: unknown }
export interface CompositeChild { elements?: CompositeElement[]; textures?: Record<string, string> }

/** resolve "#key" through a texture map (up to 16 hops); absolute ids are returned unchanged, unknown keys stay as written */
function lookup(ref: string, textures: Record<string, string>): string {
  let r = ref;
  for (let i = 0; r.startsWith('#') && i < 16; i++) {
    const next = textures[r.slice(1)];
    if (next === undefined) return r;
    r = next;
  }
  return r;
}

/**
 * Flattens the `children` of composite models (in key order) into elements. `inherited` are the textures of the model chain
 * (child textures override them). Faces get absolute texture ids; elements are deep-copied, the input is not modified.
 */
export function compositeElements(children: Record<string, CompositeChild> | undefined, inherited: Record<string, string>): CompositeElement[] {
  const out: CompositeElement[] = [];
  if (!children) return out;
  for (const key of Object.keys(children).sort()) {
    const child = children[key];
    if (!child?.elements?.length) continue;
    const local = { ...inherited, ...(child.textures ?? {}) };
    for (const el of child.elements) {
      const copy: CompositeElement = JSON.parse(JSON.stringify(el));
      if (copy.faces) for (const f of Object.values(copy.faces)) {
        if (typeof f.texture === 'string') f.texture = lookup(f.texture, local);
      }
      out.push(copy);
    }
  }
  return out;
}
