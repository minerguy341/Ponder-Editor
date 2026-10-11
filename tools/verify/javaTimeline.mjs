// Derives the *timing skeleton* of a Create ponder scene straight from its Java source, independently of C1's converter.
// Used by compare.mjs --derive to prove the tick numbers in references.json (and to cross-check C1's keyframes/totalTicks).
//
// Rules (read from Ponder 1.0.82, `mc1.21.1/dev`, foundation/instruction + PonderScene + PonderProgressBar):
//   * Only DelayInstruction (`scene.idle(n)`, `idleSeconds(s)`) is blocking; every other instruction (showSection, showText,
//     showControls, moveSection, modifyBlockEntity, rotateCameraY, ...) is a non-blocking TickingInstruction/PonderInstruction.
//   * totalTime = sum of all idle ticks.
//   * `scene.addKeyframe()` marks totalTime; `addLazyKeyframe()` and the text builder's `.attachKeyFrame()` mark totalTime + 6.
//   * showText(d) keeps its window for d + 2*5 ticks (5 ticks fade in, d ticks, 5 ticks fade out); text keys are text_1.. in the
//     order of `.text(...)` calls (PonderScene.registerText).
//   * Instruction timing: the instructions that follow an idle run on tick (sum so far) + 1 (a completed blocking instruction
//     ends the instruction pass of its tick), so "visible after seek(sum + 1)".
// Supported Java subset: `for (int i = a; i <=|<|>=|> b; i++|i--)`, `if (<loopvar compare>)`, `.idle(<arith>)`; anything else that
// could change timing (idle inside lambdas or helper methods) throws instead of guessing.

function stripCommentsKeepStrings(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
    } else if (c === '"') {
      out += c;
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') {
          out += src[i++];
        }
        out += src[i++];
      }
      out += '"';
    } else out += c;
  }
  return out;
}

const blankStrings = (s) => s.replace(/"(?:[^"\\]|\\.)*"/g, '""');

function matchClose(s, open, openCh, closeCh) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
      continue;
    }
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced ${openCh}${closeCh}`);
}

function readStatement(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"') {
      j++;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
    } else if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ';' && depth === 0) return [s.slice(i, j), j + 1];
  }
  throw new Error('statement without terminating ;');
}

function evalArith(expr, env) {
  const e = expr.trim();
  if (!/^[\w\s+\-*/().]*$/.test(e)) throw new Error(`unsupported expression: ${expr}`);
  const names = (e.match(/[A-Za-z_]\w*/g) || []).filter((n) => !(n in env));
  if (names.length) throw new Error(`unknown identifier(s) ${names.join(',')} in: ${expr}`);
  // eslint-disable-next-line no-new-func
  const v = new Function(...Object.keys(env), `return (${e});`)(...Object.values(env));
  if (!Number.isFinite(v)) throw new Error(`non-finite value for ${expr}`);
  return v;
}

/** Extract `public static void <method>(...) { body }` (comments removed). */
export function extractMethod(javaSource, method) {
  const src = stripCommentsAndKeep(javaSource);
  const m = new RegExp(`(?:public|private|protected)?\\s*static\\s+void\\s+${method}\\s*\\(`).exec(src);
  if (!m) throw new Error(`method ${method} not found`);
  const open = src.indexOf('{', m.index);
  const close = matchClose(src, open, '{', '}');
  return { body: src.slice(open + 1, close), all: src };
}
const stripCommentsAndKeep = stripCommentsKeepStrings;

/** @returns {{ totalTicks:number, keyframes:number[], texts:{key:string, at:number, duration:number}[], idles:number }} */
export function deriveTimeline(javaSource, method) {
  const { body, all } = extractMethod(javaSource, method);
  // helper methods in the same file that contain idles must not be called silently
  const helperNames = [];
  const rx = /static\s+(?:void|\w+)\s+(\w+)\s*\(/g;
  let hm;
  while ((hm = rx.exec(all))) {
    try {
      const open = all.indexOf('{', hm.index);
      const close = matchClose(all, open, '{', '}');
      if (/\.idle(?:Seconds)?\(/.test(all.slice(open, close)) && hm[1] !== method) helperNames.push(hm[1]);
    } catch {
      /* not a method with a body */
    }
  }

  const st = { t: 0, keyframes: [], texts: [], idles: 0, textIndex: 0 };

  function statement(text, env) {
    const s = blankStrings(text);
    for (const h of helperNames) if (new RegExp(`(^|[^.\\w])${h}\\s*\\(`).test(s)) throw new Error(`call to helper ${h}() which contains idles is not supported`);
    // texts: a showText(d) chain registers one text per `.text(`; `.attachKeyFrame()` follows in the same chain
    const tokenRx = /\.(idleSeconds|idle)\(([^()]*)\)|\.showText\(([^()]*)\)|\.text\(|\.sharedText\(|\.attachKeyFrame\(\)|\.addKeyframe\(\)|\.addLazyKeyframe\(\)/g;
    let m;
    let pendingText = null;
    while ((m = tokenRx.exec(s))) {
      if (m[1]) {
        const n = evalArith(m[2], env) * (m[1] === 'idleSeconds' ? 20 : 1);
        st.t += n;
        st.idles++;
      } else if (m[3] !== undefined) {
        pendingText = { at: st.t, duration: evalArith(m[3], env) };
        st.texts.push(pendingText);
      } else if (m[0] === '.text(') {
        st.textIndex++;
        if (pendingText && !pendingText.key) pendingText.key = `text_${st.textIndex}`;
      } else if (m[0] === '.sharedText(') {
        if (pendingText && !pendingText.key) pendingText.key = 'shared';
      } else if (m[0] === '.attachKeyFrame()' || m[0] === '.addLazyKeyframe()') st.keyframes.push(st.t + 6);
      else if (m[0] === '.addKeyframe()') st.keyframes.push(st.t);
    }
    if (/->|\bnew\s+\w+\s*\(\s*\)\s*\{/.test(s) && /\.idle/.test(s)) throw new Error('idle inside lambda is not supported');
  }

  function block(src, env) {
    let i = 0;
    while (i < src.length) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (i >= src.length) break;
      const rest = src.slice(i);
      let m;
      if ((m = /^for\s*\(/.exec(rest))) {
        const po = i + m[0].length - 1;
        const pc = matchClose(src, po, '(', ')');
        const header = src.slice(po + 1, pc);
        const hm2 = /^\s*int\s+(\w+)\s*=\s*([^;]+);\s*\1\s*(<=|<|>=|>)\s*([^;]+);\s*\1\s*(\+\+|--)\s*$/.exec(header);
        if (!hm2) throw new Error(`unsupported for header: ${header}`);
        const [, v, a, cmp, b, step] = hm2;
        let bodySrc;
        let next;
        let j = pc + 1;
        while (/\s/.test(src[j])) j++;
        if (src[j] === '{') {
          const c = matchClose(src, j, '{', '}');
          bodySrc = src.slice(j + 1, c);
          next = c + 1;
        } else {
          const [s1, e1] = readStatement(src, j);
          bodySrc = s1 + ';';
          next = e1;
        }
        const lo = evalArith(a, env);
        const hi = evalArith(b, env);
        const ok = (x) => (cmp === '<=' ? x <= hi : cmp === '<' ? x < hi : cmp === '>=' ? x >= hi : x > hi);
        let guard = 0;
        for (let x = lo; ok(x); x += step === '++' ? 1 : -1) {
          if (++guard > 10000) throw new Error('loop too long');
          block(bodySrc, { ...env, [v]: x });
        }
        i = next;
        continue;
      }
      if ((m = /^if\s*\(/.exec(rest))) {
        const po = i + m[0].length - 1;
        const pc = matchClose(src, po, '(', ')');
        const cond = src.slice(po + 1, pc);
        let j = pc + 1;
        while (/\s/.test(src[j])) j++;
        let bodySrc;
        let next;
        if (src[j] === '{') {
          const c = matchClose(src, j, '{', '}');
          bodySrc = src.slice(j + 1, c);
          next = c + 1;
        } else {
          const [s1, e1] = readStatement(src, j);
          bodySrc = s1 + ';';
          next = e1;
        }
        if (/\.idle(?:Seconds)?\(|attachKeyFrame|addKeyframe|addLazyKeyframe|showText/.test(blankStrings(bodySrc))) {
          const cm = /^\s*(\w+)\s*(==|!=|<=|>=|<|>)\s*([\w.+\-*/() ]+)\s*$/.exec(cond);
          if (!cm || !(cm[1] in env)) throw new Error(`cannot evaluate timing-relevant condition: ${cond}`);
          const l = env[cm[1]];
          const r = evalArith(cm[3], env);
          const truth = { '==': l === r, '!=': l !== r, '<=': l <= r, '>=': l >= r, '<': l < r, '>': l > r }[cm[2]];
          if (truth) block(bodySrc, env);
        }
        // an `else` branch directly after would be unsupported; make that loud
        if (/^\s*else\b/.test(src.slice(next)) && /\.idle|showText|KeyFrame/.test(blankStrings(src.slice(next, next + 400)))) throw new Error('else branch with timing is not supported');
        i = next;
        continue;
      }
      if (src[i] === '{') {
        const c = matchClose(src, i, '{', '}');
        block(src.slice(i + 1, c), env);
        i = c + 1;
        continue;
      }
      const [stmt, next] = readStatement(src, i);
      statement(stmt, env);
      i = next;
    }
  }

  block(body, {});
  return { totalTicks: st.t, keyframes: st.keyframes, texts: st.texts, idles: st.idles };
}

/** Which instructions are *active/visible* at a tick, for the human-readable derivation notes. */
export function textWindowsAt(texts, tick) {
  return texts.filter((t) => tick >= t.at + 1 && tick < t.at + 1 + t.duration + 10).map((t) => ({ key: t.key, age: tick - (t.at + 1), fadedIn: tick - (t.at + 1) >= 5 }));
}
