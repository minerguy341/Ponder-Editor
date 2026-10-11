// Lowers the chevrotain CST produced by `java-parser` into a compact AST that the interpreter walks.
// Node kinds are short strings in field `k`. Every node that can fail at runtime carries `line`.
import { parse } from 'java-parser';

// ---------------------------------------------------------------- CST helpers

const isTok = (n) => n && n.image !== undefined;
/** contextual keywords (with, uses, record, ...) are tokens of category Identifier */
const isIdent = (t) => t.tokenType.name === 'Identifier' || (t.tokenType.CATEGORIES || []).some((c) => c.name === 'Identifier');
const off = (n) => (isTok(n) ? n.startOffset : n.location.startOffset);

/** all children (tokens and nodes) in source order */
function kids(n) {
  const out = [];
  for (const arr of Object.values(n.children)) for (const c of arr) out.push(c);
  out.sort((a, b) => off(a) - off(b));
  return out;
}
const one = (n, name) => (n.children[name] ? n.children[name][0] : undefined);
const all = (n, name) => n.children[name] || [];
const has = (n, name) => !!n.children[name];
const line = (n) => (isTok(n) ? n.startLine : n.location.startLine);

/** first token (depth-first, source order) of node */
function firstTok(n) {
  if (isTok(n)) return n;
  for (const c of kids(n)) {
    const t = firstTok(c);
    if (t) return t;
  }
  return null;
}
/** all tokens (depth-first, source order) */
function tokens(n, out = []) {
  if (isTok(n)) {
    out.push(n);
    return out;
  }
  for (const c of kids(n)) tokens(c, out);
  return out;
}

// ---------------------------------------------------------------- types

const PRIMS = new Set(['byte', 'short', 'int', 'long', 'char', 'float', 'double', 'boolean']);

/** Any type-ish CST node -> {name, dims, args?} (generic args dropped except as strings) */
function lowerType(n) {
  if (!n) return null;
  const toks = tokens(n);
  let dims = 0;
  const names = [];
  let depth = 0;
  const args = [];
  for (const t of toks) {
    const nm = t.tokenType.name;
    if (nm === 'Less') depth++;
    else if (nm === 'Greater') depth--;
    else if (depth === 0) {
      if (nm === 'LSquare') dims++;
      else if (isIdent(t) || PRIMS.has(t.image) || nm === 'Var' || nm === 'Void') names.push(t.image);
    } else if (isIdent(t)) args.push(t.image);
  }
  return { name: names.join('.'), dims, args };
}

// ---------------------------------------------------------------- expressions

const BIN_PREC = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6,
  '<': 7, '>': 7, '<=': 7, '>=': 7, instanceof: 7, '<<': 8, '>>': 8, '>>>': 8,
  '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
};

export function lowerExpression(n) {
  switch (n.name) {
    case 'expression': {
      const lam = one(n, 'lambdaExpression');
      if (lam) return lowerLambda(lam);
      return lowerExpression(one(n, 'conditionalExpression'));
    }
    case 'conditionalExpression': {
      const cond = lowerExpression(one(n, 'binaryExpression'));
      if (!has(n, 'QuestionMark')) return cond;
      const [a, b] = all(n, 'expression');
      return { k: 'cond', c: cond, a: lowerExpression(a), b: lowerExpression(b), line: line(n) };
    }
    case 'binaryExpression':
      return lowerBinary(n);
    case 'unaryExpression':
    case 'unaryExpressionNotPlusMinus': {
      let e = lowerPrimary(one(n, 'primary'));
      const pre = all(n, 'UnaryPrefixOperator').concat(all(n, 'UnaryPrefixOperatorNotPlusMinus'));
      const suf = all(n, 'UnarySuffixOperator');
      for (const s of suf) e = { k: 'postfix', op: s.image, e, line: s.startLine };
      for (const p of pre.reverse()) e = { k: 'unary', op: p.image, e, line: p.startLine };
      return e;
    }
    case 'primary':
      return lowerPrimary(n);
    case 'lambdaExpression':
      return lowerLambda(n);
    default:
      throw new Error('lowerExpression: unexpected ' + n.name);
  }
}

function lowerBinary(n) {
  // children carry their grammar key (token *types* are categories: '=' has type Equals but key AssignmentOperator)
  const items = [];
  for (const [k, arr] of Object.entries(n.children)) for (const c of arr) items.push({ k, c });
  items.sort((x, y) => off(x.c) - off(y.c));
  const operands = [lowerExpression(items[0].c)];
  const ops = [];
  let i = 1;
  let assign = null;
  while (i < items.length) {
    const { k, c: it } = items[i];
    if (k === 'AssignmentOperator') {
      assign = { op: it.image, rhs: lowerExpression(items[i + 1].c), line: it.startLine };
      i += 2;
    } else if (k === 'Instanceof') {
      const t = items[i + 1].c;
      let type;
      let bind = null;
      if (t.name === 'pattern') {
        if (t.children.recordPattern) {
          type = lowerType(one(t.children.recordPattern[0], 'referenceType'));
        } else {
          const idents = tokens(t).filter((x) => isIdent(x));
          bind = idents[idents.length - 1].image;
          type = lowerType(t.children.typePattern[0].children.localVariableDeclaration[0].children.localVariableType[0]);
        }
      } else type = lowerType(t);
      operands.push({ k: 'typeref', type, bind });
      ops.push('instanceof');
      i += 2;
    } else if (k === 'Less' || k === 'Greater') {
      // shift operators: consecutive Less/Greater tokens followed by the right operand
      let op = it.image;
      let j = i + 1;
      while (j < items.length && (items[j].k === 'Less' || items[j].k === 'Greater') && items[j].c.image === it.image) {
        op += items[j].c.image;
        j++;
      }
      ops.push(op);
      operands.push(lowerExpression(items[j].c));
      i = j + 1;
    } else if (k === 'BinaryOperator') {
      ops.push(it.image);
      operands.push(lowerExpression(items[i + 1].c));
      i += 2;
    } else throw new Error('lowerBinary: unexpected ' + k);
  }
  // precedence climbing (all left assoc); operands[i+1] is the right operand of ops[i]
  const lineNo = line(n);
  let idx = 0;
  const mk = (op, lhs, rhs) =>
    op === 'instanceof' ? { k: 'instanceof', e: lhs, type: rhs.type, bind: rhs.bind, line: lineNo } : { k: 'bin', op, a: lhs, b: rhs, line: lineNo };
  const climb = (first, minPrec) => {
    let lhs = first;
    while (idx < ops.length && BIN_PREC[ops[idx]] >= minPrec) {
      const op = ops[idx];
      const prec = BIN_PREC[op];
      idx++;
      const rhs = climb(operands[idx], prec + 1);
      lhs = mk(op, lhs, rhs);
    }
    return lhs;
  };
  let result = climb(operands[0], 1);
  if (assign) result = { k: 'assign', op: assign.op, target: result, value: assign.rhs, line: assign.line };
  return result;
}

function lowerLambda(n) {
  const params = [];
  const lp = one(n, 'lambdaParameters');
  for (const t of tokens(lp)) {
    // only direct identifier params of the concise form, or declared params
  }
  const wb = one(lp, 'lambdaParametersWithBraces');
  if (!wb) {
    const id = one(lp, 'Identifier') || one(lp, 'Underscore');
    params.push({ name: id.image, type: null });
  } else {
    const list = one(wb, 'lambdaParameterList');
    if (list) {
      const concise = one(list, 'conciseLambdaParameterList');
      if (concise) {
        for (const c of all(concise, 'conciseLambdaParameter')) {
          const id = one(c, 'Identifier') || one(c, 'Underscore');
          params.push({ name: id.image, type: null });
        }
      } else {
        const normal = one(list, 'normalLambdaParameterList');
        for (const p of all(normal, 'normalLambdaParameter')) {
          const reg = one(p, 'regularLambdaParameter');
          if (reg) {
            const idn = one(one(reg, 'variableDeclaratorId'), 'Identifier');
            params.push({ name: idn.image, type: lowerType(one(reg, 'lambdaParameterType')) });
          } else {
            const ar = one(p, 'variableArityParameter');
            params.push({ name: one(ar, 'Identifier').image, type: lowerType(one(ar, 'unannType')), varargs: true });
          }
        }
      }
    }
  }
  const body = one(n, 'lambdaBody');
  const be = one(body, 'expression');
  return {
    k: 'lambda',
    params,
    body: be ? lowerExpression(be) : lowerBlock(one(body, 'block')),
    exprBody: !!be,
    line: line(n),
  };
}

function lowerArgs(n) {
  // n may be a node holding optional argumentList
  const al = n && one(n, 'argumentList');
  if (!al) return [];
  return all(al, 'expression').map(lowerExpression);
}

function lowerPrimary(n) {
  const prefix = one(n, 'primaryPrefix');
  const suffixes = all(n, 'primarySuffix');
  let si = 0;
  let e;
  const pk = kids(prefix)[0];
  const ln = line(n);
  if (isTok(pk)) {
    const nm = pk.tokenType.name;
    if (nm === 'This') e = { k: 'this', line: ln };
    else if (nm === 'Void') e = { k: 'name', parts: ['void'], line: ln };
    else throw new Error('primaryPrefix token ' + nm);
  } else {
    switch (pk.name) {
      case 'literal':
        e = lowerLiteral(pk);
        break;
      case 'fqnOrRefType': {
        const parts = [];
        const collect = (x) => {
          for (const c of kids(x)) {
            if (isTok(c)) {
              if (isIdent(c) || c.tokenType.name === 'Super') parts.push(c.image);
            } else if (c.name === 'fqnOrRefTypePartFirst' || c.name === 'fqnOrRefTypePartRest' || c.name === 'fqnOrRefTypePartCommon') collect(c);
          }
        };
        collect(pk);
        const dims = has(pk, 'dims') ? tokens(one(pk, 'dims')).filter((t) => t.image === '[').length : 0;
        const first = suffixes[0];
        if (first && has(first, 'methodInvocationSuffix') && !dims) {
          const name = parts[parts.length - 1];
          const target = parts.length > 1 ? { k: 'name', parts: parts.slice(0, -1), line: ln } : null;
          e = { k: 'call', target, name, args: lowerArgs(one(first, 'methodInvocationSuffix')), line: ln };
          si = 1;
        } else if (dims) {
          e = { k: 'typeexpr', type: { name: parts.join('.'), dims, args: [] }, line: ln };
        } else e = { k: 'name', parts, line: ln };
        break;
      }
      case 'unannPrimitiveTypeWithOptionalDimsSuffix':
        e = { k: 'typeexpr', type: lowerType(pk), line: ln };
        break;
      case 'castExpression': {
        const c = kids(pk)[0];
        if (c.name === 'primitiveCastExpression') {
          e = { k: 'cast', type: lowerType(one(c, 'primitiveType')), e: lowerExpression(one(c, 'unaryExpression')), line: ln };
        } else {
          const inner = one(c, 'lambdaExpression') ? lowerLambda(one(c, 'lambdaExpression')) : lowerExpression(one(c, 'unaryExpressionNotPlusMinus'));
          e = { k: 'cast', type: lowerType(one(c, 'referenceType')), e: inner, line: ln };
        }
        break;
      }
      case 'parenthesisExpression':
        e = { k: 'paren', e: lowerExpression(one(pk, 'expression')), line: ln };
        break;
      case 'newExpression':
        e = lowerNew(pk);
        break;
      case 'switchStatement':
        e = lowerSwitch(pk, true);
        break;
      default:
        throw new Error('primaryPrefix ' + pk.name);
    }
  }
  for (; si < suffixes.length; si++) {
    const s = suffixes[si];
    const sk = kids(s);
    if (has(s, 'methodInvocationSuffix')) {
      // call on the value of e (e.g. `foo()()` is not valid java, but `new X().y()` handled via Dot)
      throw new Error('bare invocation suffix at line ' + ln);
    } else if (has(s, 'methodReferenceSuffix')) {
      const m = one(s, 'methodReferenceSuffix');
      e = { k: 'mref', target: e, name: (one(m, 'Identifier') || one(m, 'New')).image, line: ln };
    } else if (has(s, 'arrayAccessSuffix')) {
      e = { k: 'index', e, i: lowerExpression(one(one(s, 'arrayAccessSuffix'), 'expression')), line: ln };
    } else if (has(s, 'classLiteralSuffix')) {
      e = { k: 'classlit', e, line: ln };
    } else if (sk[0] && isTok(sk[0]) && sk[0].tokenType.name === 'Dot') {
      const rest = sk.slice(1);
      const tgt = rest[0];
      if (isTok(tgt) && tgt.tokenType.name === 'This') {
        e = { k: 'this', qual: e, line: ln };
      } else if (!isTok(tgt) && tgt.name === 'unqualifiedClassInstanceCreationExpression') {
        const ne = lowerNewClass(tgt);
        ne.outer = e;
        e = ne;
      } else if (!isTok(tgt) && tgt.name === 'typeArguments') {
        // explicit generic method call: .<T>foo(...)
        const id = rest.find((x) => isTok(x) && isIdent(x));
        const nxt = suffixes[si + 1];
        if (nxt && has(nxt, 'methodInvocationSuffix')) {
          e = { k: 'call', target: e, name: id.image, args: lowerArgs(one(nxt, 'methodInvocationSuffix')), line: ln };
          si++;
        } else e = { k: 'field', target: e, name: id.image, line: ln };
      } else if (isTok(tgt) && isIdent(tgt)) {
        const nxt = suffixes[si + 1];
        if (nxt && has(nxt, 'methodInvocationSuffix')) {
          e = { k: 'call', target: e, name: tgt.image, args: lowerArgs(one(nxt, 'methodInvocationSuffix')), line: tgt.startLine };
          si++;
        } else e = { k: 'field', target: e, name: tgt.image, line: tgt.startLine };
      } else throw new Error('unsupported primarySuffix at line ' + ln);
    } else throw new Error('unsupported primarySuffix kind at line ' + ln);
  }
  return e;
}

function lowerLiteral(n) {
  const ln = line(n);
  const il = one(n, 'integerLiteral');
  if (il) {
    const t = firstTok(il);
    let s = t.image.replace(/_/g, '');
    const isLong = /[lL]$/.test(s);
    if (isLong) s = s.slice(0, -1);
    let v;
    if (/^0[xX]/.test(s)) v = Number(BigInt(s));
    else if (/^0[bB]/.test(s)) v = Number(BigInt(s));
    else if (/^0[0-7]+$/.test(s)) v = parseInt(s, 8);
    else v = Number(s);
    if (!isLong && /^0[xX]/.test(t.image) && v > 0x7fffffff) v = v - 0x100000000; // int hex wraps
    return { k: 'lit', t: isLong ? 'long' : 'int', v, line: ln };
  }
  const fl = one(n, 'floatingPointLiteral');
  if (fl) {
    const t = firstTok(fl);
    let s = t.image.replace(/_/g, '');
    const last = s[s.length - 1];
    if (/[fF]$/.test(s) && !/^0[xX]/.test(s)) return { k: 'lit', t: 'float', v: Math.fround(parseFloat(s)), line: ln };
    if (/[dD]$/.test(s) && !/^0[xX]/.test(s)) s = s.slice(0, -1);
    void last;
    return { k: 'lit', t: 'double', v: parseFloat(s), line: ln };
  }
  const bl = one(n, 'booleanLiteral');
  if (bl) return { k: 'lit', t: 'boolean', v: firstTok(bl).image === 'true', line: ln };
  const ch = one(n, 'CharLiteral');
  if (ch) return { k: 'lit', t: 'char', v: unescapeJava(ch.image.slice(1, -1)), line: ln };
  const st = one(n, 'StringLiteral');
  if (st) return { k: 'lit', t: 'String', v: unescapeJava(st.image.slice(1, -1)), line: ln };
  const tb = one(n, 'TextBlock');
  if (tb) return { k: 'lit', t: 'String', v: textBlock(tb.image), line: ln };
  if (one(n, 'Null')) return { k: 'lit', t: 'null', v: null, line: ln };
  throw new Error('literal');
}

function textBlock(img) {
  let s = img.slice(3, -3);
  s = s.replace(/^[ \t]*\r?\n/, '');
  const lines = s.split(/\r?\n/);
  const indents = lines.filter((l, i) => l.trim().length || i === lines.length - 1).map((l) => l.match(/^[ \t]*/)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return unescapeJava(lines.map((l) => l.slice(min).replace(/[ \t]+$/, '')).join('\n'));
}

export function unescapeJava(s) {
  return s.replace(/\\(u+[0-9a-fA-F]{4}|[0-7]{1,3}|[btnfr"'\\s]|\r?\n)/g, (m, g) => {
    if (g[0] === 'u') return String.fromCharCode(parseInt(g.replace(/^u+/, ''), 16));
    if (/^[0-7]/.test(g)) return String.fromCharCode(parseInt(g, 8));
    switch (g) {
      case 'b': return '\b';
      case 't': return '\t';
      case 'n': return '\n';
      case 'f': return '\f';
      case 'r': return '\r';
      case 's': return ' ';
      case '"': return '"';
      case "'": return "'";
      case '\\': return '\\';
      default: return '';
    }
  });
}

function lowerNew(n) {
  const arr = one(n, 'arrayCreationExpression');
  if (arr) {
    const type = lowerType(one(arr, 'primitiveType') || one(arr, 'classOrInterfaceType'));
    const wi = one(arr, 'arrayCreationWithInitializerSuffix');
    if (wi) {
      const dims = tokens(one(wi, 'dims')).filter((t) => t.image === '[').length;
      return { k: 'newarray', type, dims, init: lowerArrayInit(one(wi, 'arrayInitializer')), line: line(n) };
    }
    const wo = one(arr, 'arrayCreationExpressionWithoutInitializerSuffix');
    const dimExprs = all(one(wo, 'dimExprs'), 'dimExpr').map((d) => lowerExpression(one(d, 'expression')));
    const extra = has(wo, 'dims') ? tokens(one(wo, 'dims')).filter((t) => t.image === '[').length : 0;
    return { k: 'newarray', type, dimExprs, dims: dimExprs.length + extra, line: line(n) };
  }
  return lowerNewClass(one(n, 'unqualifiedClassInstanceCreationExpression'));
}

function lowerNewClass(n) {
  const ct = one(n, 'classOrInterfaceTypeToInstantiate');
  const names = all(ct, 'Identifier').map((t) => t.image);
  const body = one(n, 'classBody');
  return {
    k: 'new',
    type: { name: names.join('.'), dims: 0, args: [] },
    args: lowerArgs(n),
    body: body ? lowerClassBody(body, null) : null,
    line: line(n),
  };
}

function lowerArrayInit(n) {
  const list = one(n, 'variableInitializerList');
  const items = list ? all(list, 'variableInitializer').map(lowerVarInit) : [];
  return { k: 'arraylit', items, line: line(n) };
}

function lowerVarInit(n) {
  const e = one(n, 'expression');
  if (e) return lowerExpression(e);
  return lowerArrayInit(one(n, 'arrayInitializer'));
}

// ---------------------------------------------------------------- statements

function lowerBlock(n) {
  const bs = one(n, 'blockStatements');
  const stmts = [];
  if (bs) for (const b of all(bs, 'blockStatement')) stmts.push(lowerBlockStatement(b));
  return { k: 'block', stmts, line: line(n) };
}

function lowerBlockStatement(n) {
  const lv = one(n, 'localVariableDeclarationStatement');
  if (lv) return lowerLocal(one(lv, 'localVariableDeclaration'));
  const cd = one(n, 'classDeclaration');
  if (cd) return { k: 'localclass', decl: lowerClassDecl(cd), line: line(n) };
  const id = one(n, 'interfaceDeclaration');
  if (id) return { k: 'localclass', decl: lowerInterfaceDecl(id), line: line(n) };
  return lowerStatement(one(n, 'statement'));
}

function lowerLocal(n) {
  const type = lowerType(one(n, 'localVariableType'));
  const decls = [];
  for (const d of all(one(n, 'variableDeclaratorList'), 'variableDeclarator')) {
    const id = one(d, 'variableDeclaratorId');
    const idt = one(id, 'Identifier') || one(id, 'Underscore');
    const dims = has(id, 'dims') ? tokens(one(id, 'dims')).filter((t) => t.image === '[').length : 0;
    const init = one(d, 'variableInitializer');
    decls.push({ name: idt.image, dims, init: init ? lowerVarInit(init) : null });
  }
  // `yield y;` parses as a declaration of a variable y of type `yield` (contextual keyword): it is a yield statement
  if (type.name === 'yield' && type.dims === 0 && decls.length === 1 && !decls[0].init && !decls[0].dims) return { k: 'yield', e: { k: 'name', parts: [decls[0].name], line: line(n) }, line: line(n) };
  return { k: 'local', type, decls, line: line(n) };
}

function lowerStatement(n) {
  const ln = line(n);
  const w = one(n, 'statementWithoutTrailingSubstatement');
  if (w) return lowerSWTS(w);
  const ls = one(n, 'labeledStatement');
  if (ls) return { k: 'labeled', label: one(ls, 'Identifier').image, body: lowerStatement(one(ls, 'statement')), line: ln };
  const is = one(n, 'ifStatement');
  if (is) {
    const [a, b] = all(is, 'statement');
    return { k: 'if', c: lowerExpression(one(is, 'expression')), a: lowerStatement(a), b: b ? lowerStatement(b) : null, line: ln };
  }
  const ws = one(n, 'whileStatement');
  if (ws) return { k: 'while', c: lowerExpression(one(ws, 'expression')), body: lowerStatement(one(ws, 'statement')), line: ln };
  const fs = one(n, 'forStatement');
  if (fs) {
    const b = one(fs, 'basicForStatement');
    if (b) {
      const fi = one(b, 'forInit');
      let init = [];
      if (fi) {
        if (has(fi, 'localVariableDeclaration')) init = [lowerLocal(one(fi, 'localVariableDeclaration'))];
        else init = all(one(fi, 'statementExpressionList'), 'statementExpression').map((s) => ({ k: 'expr', e: lowerExpression(one(s, 'expression')), line: ln }));
      }
      const cond = one(b, 'expression');
      const fu = one(b, 'forUpdate');
      const update = fu ? all(one(fu, 'statementExpressionList'), 'statementExpression').map((s) => lowerExpression(one(s, 'expression'))) : [];
      return { k: 'for', init, c: cond ? lowerExpression(cond) : null, update, body: lowerStatement(one(b, 'statement')), line: ln };
    }
    const e = one(fs, 'enhancedForStatement');
    const lv = one(e, 'localVariableDeclaration');
    const vd = one(one(lv, 'variableDeclaratorList'), 'variableDeclarator');
    return {
      k: 'foreach',
      type: lowerType(one(lv, 'localVariableType')),
      name: one(one(vd, 'variableDeclaratorId'), 'Identifier').image,
      iter: lowerExpression(one(e, 'expression')),
      body: lowerStatement(one(e, 'statement')),
      line: ln,
    };
  }
  throw new Error('statement kind at line ' + ln);
}

function lowerSWTS(n) {
  const ln = line(n);
  const blk = one(n, 'block');
  if (blk) return lowerBlock(blk);
  if (has(n, 'emptyStatement')) return { k: 'empty', line: ln };
  const es = one(n, 'expressionStatement');
  if (es) return { k: 'expr', e: lowerExpression(one(one(es, 'statementExpression'), 'expression')), line: ln };
  const rs = one(n, 'returnStatement');
  if (rs) return { k: 'return', e: one(rs, 'expression') ? lowerExpression(one(rs, 'expression')) : null, line: ln };
  const bs = one(n, 'breakStatement');
  if (bs) return { k: 'break', label: one(bs, 'Identifier')?.image ?? null, line: ln };
  const cs = one(n, 'continueStatement');
  if (cs) return { k: 'continue', label: one(cs, 'Identifier')?.image ?? null, line: ln };
  const ts = one(n, 'throwStatement');
  if (ts) return { k: 'throw', e: lowerExpression(one(ts, 'expression')), line: ln };
  const ss = one(n, 'switchStatement');
  if (ss) return lowerSwitch(ss, false);
  const ds = one(n, 'doStatement');
  if (ds) return { k: 'do', c: lowerExpression(one(ds, 'expression')), body: lowerStatement(one(ds, 'statement')), line: ln };
  const ys = one(n, 'yieldStatement');
  if (ys) return { k: 'yield', e: lowerExpression(one(ys, 'expression')), line: ln };
  const as = one(n, 'assertStatement');
  if (as) return { k: 'empty', line: ln };
  const sy = one(n, 'synchronizedStatement');
  if (sy) return lowerBlock(one(sy, 'block'));
  const tr = one(n, 'tryStatement');
  if (tr) {
    const tw = one(tr, 'tryWithResourcesStatement');
    const src = tw || tr;
    const catches = [];
    const cs2 = one(src, 'catches');
    if (cs2)
      for (const c of all(cs2, 'catchClause')) {
        const cp = one(c, 'catchFormalParameter');
        const names = tokens(one(cp, 'catchType')).filter((t) => isIdent(t)).map((t) => t.image);
        catches.push({ types: names, name: one(one(cp, 'variableDeclaratorId'), 'Identifier').image, body: lowerBlock(one(c, 'block')) });
      }
    const fin = one(src, 'finally');
    return { k: 'try', body: lowerBlock(one(src, 'block')), catches, fin: fin ? lowerBlock(one(fin, 'block')) : null, line: ln };
  }
  throw new Error('statement-without-trailing kind at line ' + ln + ': ' + Object.keys(n.children));
}

function lowerSwitch(n, isExpr) {
  const ln = line(n);
  const sel = lowerExpression(one(n, 'expression'));
  const sb = one(n, 'switchBlock');
  const cases = [];
  const labelOf = (lab) => {
    // returns {labels:[expr|{k:'default'}], isDefault}
    const labels = [];
    let isDefault = false;
    for (const c of kids(lab)) {
      if (isTok(c)) {
        if (c.tokenType.name === 'Default') isDefault = true;
        else if (c.tokenType.name === 'Null') labels.push({ k: 'lit', t: 'null', v: null });
      } else if (c.name === 'caseConstant') labels.push(lowerExpression(one(c, 'conditionalExpression')));
      else if (c.name === 'casePattern') labels.push({ k: 'pattern', raw: true });
    }
    return { labels, isDefault };
  };
  const rules = all(sb, 'switchRule');
  if (rules.length) {
    for (const r of rules) {
      const { labels, isDefault } = labelOf(one(r, 'switchLabel'));
      let body;
      if (has(r, 'block')) body = lowerBlock(one(r, 'block'));
      else if (has(r, 'throwStatement')) body = { k: 'throw', e: lowerExpression(one(one(r, 'throwStatement'), 'expression')), line: ln };
      else body = { k: 'yield', e: lowerExpression(one(r, 'expression')), implicit: true, line: ln };
      cases.push({ labels, isDefault, body, arrow: true });
    }
  } else {
    for (const g of all(sb, 'switchBlockStatementGroup')) {
      const { labels, isDefault } = labelOf(one(g, 'switchLabel'));
      const bs = one(g, 'blockStatements');
      cases.push({ labels, isDefault, stmts: bs ? all(bs, 'blockStatement').map(lowerBlockStatement) : [], arrow: false });
    }
  }
  return { k: 'switch', sel, cases, isExpr, line: ln };
}

// ---------------------------------------------------------------- declarations

function modifiersOf(n, ruleName) {
  const mods = new Set();
  for (const m of all(n, ruleName)) for (const t of tokens(m)) mods.add(t.image);
  return mods;
}

function lowerParams(fpl) {
  const params = [];
  if (!fpl) return params;
  for (const p of all(fpl, 'formalParameter')) {
    const reg = one(p, 'variableParaRegularParameter');
    if (reg) {
      const id = one(reg, 'variableDeclaratorId');
      const dims = has(id, 'dims') ? tokens(one(id, 'dims')).filter((t) => t.image === '[').length : 0;
      const type = lowerType(one(reg, 'unannType'));
      type.dims += dims;
      params.push({ name: (one(id, 'Identifier') || one(id, 'Underscore')).image, type });
    } else {
      const ar = one(p, 'variableArityParameter');
      const type = lowerType(one(ar, 'unannType'));
      type.dims += 1;
      params.push({ name: one(ar, 'Identifier').image, type, varargs: true });
    }
  }
  return params;
}

function lowerMethod(n, isInterface) {
  const hdr = one(n, 'methodHeader');
  const decl = one(hdr, 'methodDeclarator');
  const mods = modifiersOf(n, isInterface ? 'interfaceMethodModifier' : 'methodModifier');
  const res = one(hdr, 'result');
  const body = one(n, 'methodBody');
  const blk = body && one(body, 'block');
  return {
    k: 'method',
    name: one(decl, 'Identifier').image,
    params: lowerParams(one(decl, 'formalParameterList')),
    ret: res && has(res, 'unannType') ? lowerType(one(res, 'unannType')) : { name: 'void', dims: 0, args: [] },
    static: mods.has('static'),
    abstract: !blk,
    default: mods.has('default'),
    body: blk ? lowerBlock(blk) : null,
    line: line(n),
  };
}

function lowerField(n, mods) {
  const type = lowerType(one(n, 'unannType'));
  const out = [];
  for (const d of all(one(n, 'variableDeclaratorList'), 'variableDeclarator')) {
    const id = one(d, 'variableDeclaratorId');
    const dims = has(id, 'dims') ? tokens(one(id, 'dims')).filter((t) => t.image === '[').length : 0;
    const init = one(d, 'variableInitializer');
    out.push({ k: 'field', name: one(id, 'Identifier').image, type: { ...type, dims: type.dims + dims }, static: mods.has('static'), init: init ? lowerVarInit(init) : null, line: line(d) });
  }
  return out;
}

function lowerCtor(n) {
  const cd = one(n, 'constructorDeclarator');
  const body = one(n, 'constructorBody');
  const eci = one(body, 'explicitConstructorInvocation');
  let explicit = null;
  if (eci) {
    const u = one(eci, 'unqualifiedExplicitConstructorInvocation');
    if (u) explicit = { kind: has(u, 'This') ? 'this' : 'super', args: lowerArgs(u) };
    else {
      const q = one(eci, 'qualifiedExplicitConstructorInvocation');
      explicit = { kind: 'super', args: lowerArgs(q) };
    }
  }
  const bs = one(body, 'blockStatements');
  return {
    k: 'ctor',
    params: lowerParams(one(cd, 'formalParameterList')),
    explicit,
    body: { k: 'block', stmts: bs ? all(bs, 'blockStatement').map(lowerBlockStatement) : [] },
    line: line(n),
  };
}

function lowerClassBody(body, owner) {
  const members = [];
  for (const d of all(body, 'classBodyDeclaration')) lowerClassBodyDecl(d, members);
  return { members };
}

function lowerClassBodyDecl(d, members) {
  const cm = one(d, 'classMemberDeclaration');
  if (cm) {
    const fd = one(cm, 'fieldDeclaration');
    if (fd) {
      const mods = modifiersOf(fd, 'fieldModifier');
      members.push(...lowerField(fd, mods));
      return;
    }
    const md = one(cm, 'methodDeclaration');
    if (md) {
      members.push(lowerMethod(md, false));
      return;
    }
    const cd = one(cm, 'classDeclaration');
    if (cd) {
      members.push({ k: 'type', decl: lowerClassDecl(cd) });
      return;
    }
    const id = one(cm, 'interfaceDeclaration');
    if (id) members.push({ k: 'type', decl: lowerInterfaceDecl(id) });
    return;
  }
  const ii = one(d, 'instanceInitializer');
  if (ii) {
    members.push({ k: 'init', static: false, body: lowerBlock(one(ii, 'block')) });
    return;
  }
  const si = one(d, 'staticInitializer');
  if (si) {
    members.push({ k: 'init', static: true, body: lowerBlock(one(si, 'block')) });
    return;
  }
  const ctor = one(d, 'constructorDeclaration');
  if (ctor) members.push(lowerCtor(ctor));
}

function lowerClassDecl(n) {
  const mods = modifiersOf(n, 'classModifier');
  const ncd = one(n, 'normalClassDeclaration');
  if (ncd) {
    const ext = one(ncd, 'classExtends');
    const impl = one(ncd, 'classImplements');
    return {
      kind: 'class',
      name: one(one(ncd, 'typeIdentifier'), 'Identifier').image,
      superName: ext ? lowerType(one(ext, 'classType')).name : null,
      interfaces: impl ? all(one(impl, 'interfaceTypeList'), 'interfaceType').map((t) => lowerType(t).name) : [],
      static: mods.has('static'),
      abstract: mods.has('abstract'),
      ...lowerClassBody(one(ncd, 'classBody')),
    };
  }
  const ed = one(n, 'enumDeclaration');
  if (ed) {
    const eb = one(ed, 'enumBody');
    const consts = [];
    const ecl = one(eb, 'enumConstantList');
    if (ecl)
      for (const c of all(ecl, 'enumConstant')) {
        const body = one(c, 'classBody');
        consts.push({ name: one(c, 'Identifier').image, args: lowerArgs(c), body: body ? lowerClassBody(body) : null, line: line(c) });
      }
    const members = [];
    const ebd = one(eb, 'enumBodyDeclarations');
    if (ebd) for (const d of all(ebd, 'classBodyDeclaration')) lowerClassBodyDecl(d, members);
    const eimpl = one(ed, 'classImplements');
    return { kind: 'enum', name: one(one(ed, 'typeIdentifier'), 'Identifier').image, superName: null, interfaces: eimpl ? all(one(eimpl, 'interfaceTypeList'), 'interfaceType').map((t) => lowerType(t).name) : [], static: true, consts, members };
  }
  const rd = one(n, 'recordDeclaration');
  if (rd) {
    const comps = [];
    const rcl = one(rd, 'recordHeader') && one(one(rd, 'recordHeader'), 'recordComponentList');
    if (rcl)
      for (const c of all(rcl, 'recordComponent')) {
        const id = one(c, 'Identifier') || one(one(c, 'variableArityRecordComponent'), 'Identifier');
        comps.push({ name: id.image, type: lowerType(one(c, 'unannType')) });
      }
    const members = [];
    const rb = one(rd, 'recordBody');
    for (const d of all(rb, 'recordBodyDeclaration')) {
      const cd = one(d, 'classBodyDeclaration');
      if (cd) lowerClassBodyDecl(cd, members);
    }
    const rimpl = one(rd, 'classImplements');
    return { kind: 'record', name: one(one(rd, 'typeIdentifier'), 'Identifier').image, superName: null, interfaces: rimpl ? all(one(rimpl, 'interfaceTypeList'), 'interfaceType').map((t) => lowerType(t).name) : [], static: true, comps, members };
  }
  throw new Error('classDeclaration');
}

function lowerInterfaceDecl(n) {
  const nid = one(n, 'normalInterfaceDeclaration');
  if (!nid) return { kind: 'interface', name: '?annotation', superName: null, interfaces: [], members: [] };
  const ext = one(nid, 'interfaceExtends');
  const members = [];
  const body = one(nid, 'interfaceBody');
  for (const m of all(body, 'interfaceMemberDeclaration')) {
    const cd = one(m, 'constantDeclaration');
    if (cd) {
      const mods = new Set(['static']);
      members.push(...lowerField(cd, mods));
    }
    const imd = one(m, 'interfaceMethodDeclaration');
    if (imd) members.push(lowerMethod(imd, true));
    const cl = one(m, 'classDeclaration');
    if (cl) members.push({ k: 'type', decl: lowerClassDecl(cl) });
    const il = one(m, 'interfaceDeclaration');
    if (il) members.push({ k: 'type', decl: lowerInterfaceDecl(il) });
  }
  return {
    kind: 'interface',
    name: one(one(nid, 'typeIdentifier'), 'Identifier').image,
    superName: null,
    interfaces: ext ? all(one(ext, 'interfaceTypeList'), 'interfaceType').map((t) => lowerType(t).name) : [],
    members,
  };
}

/** Parse Java source into {pkg, imports, types} */
export function parseJava(src) {
  const cst = parse(src);
  const ocu = one(cst, 'ordinaryCompilationUnit');
  if (!ocu) throw new Error('not an ordinary compilation unit');
  const pd = one(ocu, 'packageDeclaration');
  const pkg = pd ? all(pd, 'Identifier').map((t) => t.image).join('.') : '';
  const imports = [];
  for (const im of all(ocu, 'importDeclaration')) {
    if (has(im, 'emptyStatement')) continue;
    const toks = tokens(one(im, 'packageOrTypeName'));
    const name = toks.filter((t) => isIdent(t)).map((t) => t.image).join('.');
    imports.push({ name, static: has(im, 'Static'), wildcard: has(im, 'Star') });
  }
  const types = [];
  for (const td of all(ocu, 'typeDeclaration')) {
    const cd = one(td, 'classDeclaration');
    if (cd) types.push(lowerClassDecl(cd));
    const id = one(td, 'interfaceDeclaration');
    if (id) types.push(lowerInterfaceDecl(id));
  }
  return { pkg, imports, types };
}
