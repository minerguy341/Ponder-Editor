// Assembles store + host classes + interpreter.
import { SourceStore } from './sources.mjs';
import { Interp } from './interp.mjs';
import { buildHost } from './host/index.mjs';
import { buildNbt } from './host/nbtobj.mjs';
import { buildPonderHost, BehaviourTypeRef } from './host/ponder-classes.mjs';
import { buildRegistration, Registrations } from './host/registration.mjs';
import { JRandom } from './host/lang.mjs';
import { installOverrides } from './overrides.mjs';

export function createEnv() {
  const store = new SourceStore();
  const { R, registry } = buildHost();
  buildNbt(R);
  const ctx = { registry, levelStub: null, world: null };
  buildPonderHost(R, ctx);
  const regs = new Registrations();
  const helpers = buildRegistration(R, regs);
  const rt = new Interp(store, R.map, { hooks: { behaviourType: (name) => new BehaviourTypeRef(name) } });
  rt.registry = registry;
  ctx.rt = rt;
  ctx.beClass = (simple) => {
    const c = store.bySimple(simple);
    return c.length ? rt.sourceClass(c[0]) : null;
  };
  ctx.makeRandom = () => new JRandom(0x1badc0de);
  installOverrides(rt, ctx);
  return { store, rt, registry, R, ctx, regs, helpers };
}
