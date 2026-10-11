// AllConfigs: scene-time Create code reads server config values (e.g. SpeedGaugeBlockEntity.getDialTarget). The defaults are scanned from the
// real config classes (`public final ConfigFloat mediumSpeed = f(30, ...)`), so they follow the Create sources.
import { hc, D, F } from './base.mjs';

export function scanConfigDefaults(store) {
  const defaults = new Map();
  const re = /public\s+final\s+Config(Int|Float|Boolean|Enum|Long|String|Double)\S*\s+(\w+)\s*=\s*(\w+)\(\s*([^,)]+)/g;
  for (const [fqn] of store.files) {
    if (!fqn.startsWith('com.simibubi.create.infrastructure.config.')) continue;
    const src = store.readSource(fqn);
    for (const m of src.matchAll(re)) {
      const [, kind, name, , arg] = m;
      let v = arg.trim();
      if (kind === 'Int' || kind === 'Long') v = parseInt(v.replace(/_/g, ''), 10);
      else if (kind === 'Float' || kind === 'Double') v = parseFloat(v);
      else if (kind === 'Boolean') v = v === 'true';
      else continue;
      defaults.set(name, { kind, v });
    }
  }
  return defaults;
}

class ConfigNode {
  constructor(defaults, name) {
    this.defaults = defaults;
    this.name = name;
  }
  get $class() {
    return 'ConfigNode';
  }
  $getField(rt, name) {
    return new ConfigNode(this.defaults, name);
  }
  get() {
    const d = this.defaults.get(this.name);
    if (!d) throw new Error(`config value ${this.name} has no scanned default`);
    switch (d.kind) {
      case 'Int': case 'Long': return d.v;
      case 'Float': return F(d.v);
      case 'Double': return D(d.v);
      default: return d.v;
    }
  }
  getF() {
    return this.get();
  }
}

export function buildConfig(R, store) {
  let defaults = null;
  const root = () => new ConfigNode((defaults ||= scanConfigDefaults(store)), null);
  R.map.set('com.simibubi.create.infrastructure.config.AllConfigs', hc('AllConfigs', { preferHost: true, statics: { server: root, client: root, common: root } }));
}
