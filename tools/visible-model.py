#!/usr/bin/env python3
# Independent model of which block positions a Ponder scene shows at its last tick, computed from the scene JSON ops and the
# schematic NBT only (no code shared with src/ponder). Used by tools/visible-audit.mjs to compare with the app's own state.
#
# Semantics (Create 6.0.10 PonderWorldInstructions / PonderLevel as mirrored in src/ponder/ops.ts):
#   showSection (base)         : keys join the base section when the 15-tick fade completes (a scheduled merge)
#   showSectionAndMerge/glue   : keys join the link target section (or stay a separate section if the target is missing)
#   showIndependentSection     : a new section with the selected keys, offset 0, stays until hidden
#   makeSectionIndependent     : keys leave the base at once and become an independent section
#   hideSection                : keys leave the base at once; a fading copy stays visible for 15 ticks
#   hideIndependentSection     : the section stays visible for 15 ticks, then is gone
#   moveSection                : the section offset changes by `offset` (final once `duration` ticks have passed)
#   setBlocks / modifyBlocks   : world states change (air removes the block); restoreBlocks copies the original state back
#   rotateSection              : not modelled; a scene that rotates a section visible at the end is reported as skipped
# A section draws its keys that the world still holds at the end, shifted by the section offset.
import gzip
import heapq
import json
import os
import struct
import subprocess
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
FADE = 15

# ---------------------------------------------------------------------------- NBT (big endian, gzip) -- only what schematics use

def read_nbt(path):
    data = gzip.open(path).read()
    pos = 0

    def rd(fmt):
        nonlocal pos
        size = struct.calcsize(fmt)
        v = struct.unpack_from(fmt, data, pos)[0]
        pos += size
        return v

    def payload(t):
        nonlocal pos
        if t == 1: return rd('>b')
        if t == 2: return rd('>h')
        if t == 3: return rd('>i')
        if t == 4: return rd('>q')
        if t == 5: return rd('>f')
        if t == 6: return rd('>d')
        if t == 7:
            n = rd('>i'); v = list(data[pos:pos + n]); pos += n; return v
        if t == 8:
            n = rd('>H'); v = data[pos:pos + n].decode('utf8'); pos += n; return v
        if t == 9:
            et = rd('>b'); n = rd('>i')
            return [payload(et) for _ in range(n)]
        if t == 10:
            out = {}
            while True:
                tt = rd('>b')
                if tt == 0: return out
                n = rd('>H'); name = data[pos:pos + n].decode('utf8'); pos += n
                out[name] = payload(tt)
        if t == 11:
            n = rd('>i'); v = list(struct.unpack_from(f'>{n}i', data, pos)); pos += 4 * n; return v
        if t == 12:
            n = rd('>i'); v = list(struct.unpack_from(f'>{n}q', data, pos)); pos += 8 * n; return v
        raise ValueError(f'tag {t}')

    tt = rd('>b')
    n = rd('>H'); pos += n
    return payload(tt)


def load_world(schem_path):
    root = read_nbt(schem_path)
    palette = root['palette']
    world = {}
    for b in root['blocks']:
        st = palette[b['state']]
        props = st.get('Properties', {}) or {}
        world[key(b['pos'])] = {'name': st['Name'], 'props': props}
    return world


def key(p):
    return f'{int(p[0])},{int(p[1])},{int(p[2])}'


def exact_key(p):
    # the same canonical text the app's visiblePositions uses: Number(round(v * 1e6) / 1e6), joined with commas
    def q(v):
        r = round(v * 1e6) / 1e6
        return str(int(r)) if r == int(r) else repr(r)
    return ','.join(q(v) for v in p)


def parse_key(k):
    return [int(v) for v in k.split(',')]


def is_air(state):
    return state is None or state['name'] in ('minecraft:air', 'minecraft:cave_air', 'minecraft:void_air')


# ---------------------------------------------------------------------------- selections

def resolve(sel):
    if sel is None:
        return set()
    t = sel.get('t')
    if t == 'pos':
        return {key(sel['pos'])}
    if t == 'box':
        a, b = sel['from'], sel['to']
        out = set()
        for x in range(min(a[0], b[0]), max(a[0], b[0]) + 1):
            for y in range(min(a[1], b[1]), max(a[1], b[1]) + 1):
                for z in range(min(a[2], b[2]), max(a[2], b[2]) + 1):
                    out.add(key([x, y, z]))
        return out
    if t == 'union':
        out = set()
        for it in sel.get('items', []):
            out |= resolve(it)
        return out
    raise ValueError(f'selection {t}')


def link_id(l):
    if isinstance(l, dict):
        return str(l.get('link'))
    return None


# ---------------------------------------------------------------------------- model

def scene_expected(scene_json, world0):
    """Returns (expected sorted positions or None, reason-if-skipped)."""
    world = dict(world0)              # key -> block (dict) or absent (air)
    breaking = {}                     # key -> breaking progress (incrementBlockBreakingProgress)
    original = dict(world0)
    base = set()
    elements = {}                     # id -> {'keys': set, 'off': [x,y,z], 'end': float, 'rotated': bool, 'moves': []}
    queue = []                        # (time, seq, action)
    seq = 0
    t = 0

    def schedule(time, action):
        nonlocal seq
        heapq.heappush(queue, (time, seq, action))
        seq += 1

    def run_until(time):
        while queue and queue[0][0] <= time:
            _, _, act = heapq.heappop(queue)
            act()

    ins = scene_json['instructions']
    # PonderScene: markAsFinished freezes the scene at its tick (seek stops once finished); without it the pass runs until every
    # instruction is done, so moves and fades complete (seek(total) "runs to finished", see src/ponder/sim.ts runnerSeek)
    frozen_at = None
    tt = 0
    for i in ins:
        if not isinstance(i, dict):
            continue
        if i.get('op') == 'idle':
            tt += int(i.get('args', {}).get('ticks', 0))
        elif i.get('op') == 'markAsFinished' and frozen_at is None:
            frozen_at = tt
    for idx, i in enumerate(ins):
        if not isinstance(i, dict):
            continue
        op = i.get('op', '')
        a = i.get('args', {}) or {}
        out = i.get('out') or f'i{idx}'
        if frozen_at is not None and t > frozen_at:
            break
        run_until(t)
        if op == 'idle':
            t += int(a.get('ticks', 0))
            continue
        if op == 'world.showSection' or op == 'world.showSectionAndMerge' or op == 'world.glueBlockOnto':
            sel = resolve(a.get('selection') or ({'t': 'pos', 'pos': a['pos']} if 'pos' in a else None))
            # a show is visible from its start (the fade-in); it joins the base / link target when the fade completes, and the
            # scene end completes every started fade, so the keys count from the start
            if op == 'world.showSection':
                base.update(sel)
            else:
                target = elements.get(link_id(a.get('link'))) if link_id(a.get('link')) is not None else None
                if target is not None:
                    target['keys'] |= sel
                else:
                    elements[out] = {'keys': set(sel), 'off': [0, 0, 0], 'end': float('inf'), 'start': t, 'rotated': False, 'moves': []}
            continue
        if op in ('world.showIndependentSection', 'world.showIndependentSectionImmediately'):
            sel = resolve(a.get('selection'))
            elements[out] = {'keys': set(sel), 'off': [0, 0, 0], 'end': float('inf'), 'start': t, 'rotated': False, 'moves': []}
            continue
        if op == 'world.makeSectionIndependent':
            sel = resolve(a.get('selection'))
            base.difference_update(sel)
            elements[out] = {'keys': set(sel), 'off': [0, 0, 0], 'end': float('inf'), 'start': t, 'rotated': False, 'moves': []}
            continue
        if op == 'world.hideSection':
            sel = resolve(a.get('selection'))
            base.difference_update(sel)
            elements[f'hide{idx}'] = {'keys': set(sel), 'off': [0, 0, 0], 'end': t + FADE, 'start': t, 'rotated': False, 'moves': []}
            continue
        if op == 'world.hideIndependentSection':
            el = elements.get(link_id(a.get('link')))
            if el is not None:
                el['end'] = min(el['end'], t + FADE)
            continue
        if op == 'world.moveSection':
            el = elements.get(link_id(a.get('link')))
            off = a.get('offset', [0, 0, 0])
            dur = int(a.get('duration', 0))
            if el is not None:
                el['moves'].append((t, dur, off))
            continue
        if op == 'world.rotateSection':
            el = elements.get(link_id(a.get('link')))
            if el is not None:
                el['rotated'] = True
            continue
        if op == 'world.setBlocks':
            sel = resolve(a.get('selection'))
            st = a.get('state')
            for k in sel:
                if is_air(st):
                    world.pop(k, None)
                else:
                    world[k] = {'name': st['name'], 'props': st.get('props', {})}
            continue
        if op == 'world.modifyBlocks':
            for ch in a.get('changes', []):
                k = key(ch['pos'])
                st = ch['state']
                if is_air(st):
                    world.pop(k, None)
                else:
                    world[k] = {'name': st['name'], 'props': st.get('props', {})}
            continue
        if op == 'world.incrementBlockBreakingProgress':
            # Create's breaking stages: the block is destroyed on the stage 9 increment (progress starts at -1)
            k = key(a['pos'])
            p = breaking.get(k, -1) + 1
            if p == 9:
                world.pop(k, None)
                breaking.pop(k, None)
            else:
                breaking[k] = p
            continue
        if op == 'world.restoreBlocks':
            sel = resolve(a.get('selection'))
            for k in sel:
                if k in original:
                    world[k] = original[k]
            continue
        # everything else (block entity data, entities, effects, overlay, camera, ...) does not change which blocks are drawn
    T = frozen_at if frozen_at is not None else scene_json.get('totalTicks', 0)
    run_until(T)  # scheduled merges after the evaluation tick do not happen
    # visible at the last tick T
    rotated = [eid for eid, el in elements.items() if el['rotated'] and el['start'] <= T and (el['end'] == float('inf') or frozen_at is not None and T < el['end'])]
    visible = set()
    for k in base:
        if k in world:
            visible.add(k)
    keys_visible = set(visible)
    for eid, el in elements.items():
        if el['start'] > T:
            continue
        if el['end'] != float('inf') and (frozen_at is None or T >= el['end']):
            continue
        for k in el['keys']:
            if k in world:
                keys_visible.add(k)
    for eid, el in elements.items():
        # the scene is over at totalTicks: every fade that started has completed (hidden sections are gone)
        if el['start'] > T:
            continue
        if el['end'] != float('inf') and (frozen_at is None or T >= el['end']):
            continue
        # the scene is over when its instructions are over: a move that is still running at totalTicks has its final offset
        # (the player finishes moves at the end of a scene; Ponder's totalTicks ends at the last instruction start)
        # moveSection offsets are relative: each move adds to the section offset (ops.ts animateSection: target = current + offset)
        off = [0.0, 0.0, 0.0]
        for start, dur, o in el['moves']:
            if start > T:
                continue
            # the app applies one chase step on the start tick itself: progress after T - start + 1 steps
            frac = 1.0 if (frozen_at is None or dur == 0) else min(1.0, (T - start + 1) / dur)
            off = [off[0] + frac * o[0], off[1] + frac * o[1], off[2] + frac * o[2]]
        for k in el['keys']:
            if k in world:
                p = parse_key(k)
                visible.add(exact_key([p[0] + off[0], p[1] + off[1], p[2] + off[2]]))
    if rotated:
        return {'keys': sorted(keys_visible), 'positions': None, 'skip': 'rotateSection on a visible section: ' + ','.join(rotated)}
    return {'keys': sorted(keys_visible), 'positions': sorted(visible), 'skip': None}


def fail(msg):
    print(f'visible-model: {msg}', file=sys.stderr)
    sys.exit(1)


def ensure_schematics(names):
    """Fetches (once, into the converter cache) every schematic the scenes use; returns {name: path}."""
    proc = subprocess.run(['node', os.path.join(ROOT, 'tools/visible-schematics.mjs'), *names], capture_output=True, text=True)
    if proc.returncode != 0:
        fail(proc.stderr.strip() or f'visible-schematics exited {proc.returncode}')
    return json.loads(proc.stdout)


def main():
    scenes_dir = os.path.join(ROOT, 'public/scenes')
    index = json.load(open(os.path.join(scenes_dir, 'index.json')))
    entries = index if isinstance(index, list) else index.get('scenes', [])
    if not entries:
        fail('no scenes in public/scenes/index.json')
    scenes = [(e['file'], json.load(open(os.path.join(scenes_dir, e['file'])))) for e in entries]
    paths = ensure_schematics(sorted({sc['schematic'] for _, sc in scenes}))
    out = {}
    for file, sc in scenes:
        schem = paths.get(sc['schematic'])
        if not schem or not os.path.exists(schem):
            fail(f"{sc['id']}: schematic {sc['schematic']} is not in the cache")
        try:
            world0 = load_world(schem)
        except Exception as ex:
            fail(f"{sc['id']}: cannot read schematic {sc['schematic']}: {ex}")
        if not world0:
            fail(f"{sc['id']}: schematic {sc['schematic']} has no blocks")
        res = scene_expected(sc, world0)
        if res['positions'] is None and not (res['skip'] or '').startswith('rotateSection'):
            fail(f"{sc['id']}: unexpected skip reason: {res['skip']}")
        out[sc['id']] = {'file': file, 'total': sc.get('totalTicks', 0), 'expected': res['positions'], 'keys': res['keys'], 'skip': res['skip']}
    dst = os.path.join(ROOT, 'tools/.cache/visible-expected.json')
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, 'w') as f:
        json.dump(out, f)
    n = len(out)
    sk = sum(1 for v in out.values() if v['expected'] is None)
    if n - sk == 0:
        fail('no scene has modelled positions')
    print(f'scenes {n}, positions modelled {n - sk}, positions skipped {sk} (rotateSection only; keys still compared)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
