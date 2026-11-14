#!/usr/bin/env node
/**
 * deobf.cjs - undo "string array" obfuscation (javascript-obfuscator style) in a JS file.
 *
 * What it does, per file:
 *   1. Finds the string-array function (d), the decoder (C) and the rotation IIFE,
 *      and runs THOSE THREE PIECES in a vm sandbox to reproduce the real string table.
 *      (Nothing else from the target file is executed.)
 *   2. Replaces every  alias(0xNNN)  call with the real string literal.
 *   3. Turns obj['prop'] into obj.prop, unquotes safe object keys, and 0x.. numbers into decimal.
 *   4. Removes the now-dead decoder/array/rotation/alias declarations.
 *   5. Re-prints through esbuild so the result is formatted and readable.
 *
 * Usage:  NODE_PATH=/path/to/node_modules node deobf.cjs <in.js> [out.js]
 * Needs:  acorn, esbuild
 */
const fs = require('fs');
const vm = require('vm');
const acorn = require('acorn');
const esbuild = require('esbuild');

const RESERVED = new Set(('break case catch class const continue debugger default delete do else enum export extends false ' +
  'finally for function if import in instanceof new null return super switch this throw true try typeof var void while with ' +
  'yield let static implements interface package private protected public await async of').split(' '));
const isName = (s) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);          // valid as a property name (reserved words OK)
const isIdent = (s) => isName(s) && !RESERVED.has(s);                 // valid as a bare identifier

function parse(src) {
  return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', ranges: true, allowHashBang: true });
}

// ---- tiny AST walker (generic; avoids needing acorn-walk) ----
function walk(node, fn, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  if (fn(node, parent) === false) return;
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'range') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, fn, node));
    else if (v && typeof v.type === 'string') walk(v, fn, node);
  }
}

function findMachinery(src, ast) {
  // rotation IIFE: (function(a,b){...}(arrFn, 0xNNN))  at top level
  let rot = null;
  for (const st of ast.body) {
    if (st.type !== 'ExpressionStatement') continue;
    let e = st.expression;
    if (e.type !== 'CallExpression') continue;
    const callee = e.callee;
    const isFn = callee.type === 'FunctionExpression' ||
      (callee.type === 'CallExpression' && false);
    if (!isFn && callee.type !== 'FunctionExpression') continue;
    if (e.arguments.length === 2 && e.arguments[0].type === 'Identifier' && e.arguments[1].type === 'Literal') {
      rot = { node: st, arrName: e.arguments[0].name };
      break;
    }
  }
  if (!rot) throw new Error('rotation IIFE not found (file may not use string-array obfuscation)');

  const fnDecls = {};
  for (const st of ast.body) if (st.type === 'FunctionDeclaration') fnDecls[st.id.name] = st;
  const arr = fnDecls[rot.arrName];
  if (!arr) throw new Error('string-array function ' + rot.arrName + ' not found at top level');

  // decoder = top-level function (other than arr) that calls arr()
  let dec = null;
  for (const [name, fd] of Object.entries(fnDecls)) {
    if (name === rot.arrName) continue;
    let calls = false;
    walk(fd.body, (n) => {
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === rot.arrName) calls = true;
    });
    if (calls) { dec = fd; break; }
  }
  if (!dec) throw new Error('decoder function not found');
  return { rot, arr, dec };
}

function buildDecoder(src, m) {
  const code = [
    src.slice(m.arr.start, m.arr.end),
    src.slice(m.dec.start, m.dec.end),
    src.slice(m.rot.node.start, m.rot.node.end),
    `globalThis.__dec = ${m.dec.id.name};`,
  ].join('\n');
  const ctx = vm.createContext({ globalThis: undefined });
  ctx.globalThis = ctx;
  vm.runInContext(code, ctx, { timeout: 15000 });
  return ctx.__dec;
}

function collectAliases(ast, decName) {
  const aliases = new Set([decName]);
  let changed = true;
  while (changed) {
    changed = false;
    walk(ast, (n) => {
      if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init &&
          n.init.type === 'Identifier' && aliases.has(n.init.name) && !aliases.has(n.id.name)) {
        aliases.add(n.id.name); changed = true;
      }
    });
  }
  return aliases;
}

function pass1(src, ast, decode, aliases, stats) {
  const edits = [];
  const strOf = (n) => {
    if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && aliases.has(n.callee.name) &&
        n.arguments.length >= 1 && n.arguments[0].type === 'Literal' && typeof n.arguments[0].value === 'number') {
      try { const v = decode(n.arguments[0].value, n.arguments[1] && n.arguments[1].value); if (typeof v === 'string') return v; } catch (_) {}
    }
    return null;
  };
  walk(ast, (n, parent) => {
    // calls -> literals
    if (n.type === 'CallExpression' && strOf(n) !== null && !(n.arguments.length === 0)) {
      if (n.callee.type === 'Identifier' && aliases.has(n.callee.name)) {
        // member access?  X[call]  ->  X.name  (handled when visiting the parent first)
        edits.push({ s: n.start, e: n.end, t: JSON.stringify(strOf(n)), kind: 'str' });
        stats.strings++;
      }
    }
    // computed member with resolvable string -> dot access
    if (n.type === 'MemberExpression' && n.computed) {
      const s = strOf(n.property);
      if (s !== null && isName(s)) {
        const open = src.indexOf('[', n.object.end);
        const dot = n.optional ? '?.' : '.';
        // for optional chains obj?.[x] source is "?.[" so start from the "?." if present
        let from = open;
        if (n.optional) { const q = src.lastIndexOf('?.', open); if (q >= n.object.end) from = q; }
        edits.push({ s: from, e: n.end, t: dot + s, kind: 'member' });
        stats.members++;
      }
    }
    // quoted object keys -> identifiers
    if ((n.type === 'Property' || n.type === 'MethodDefinition' || n.type === 'PropertyDefinition') &&
        !n.computed && n.key && n.key.type === 'Literal' && typeof n.key.value === 'string' && isName(n.key.value) && !n.shorthand) {
      edits.push({ s: n.key.start, e: n.key.end, t: n.key.value, kind: 'key' });
      stats.keys++;
    }
    // computed object keys [call]: v  ->  'str': v / ident: v
    if (n.type === 'Property' && n.computed && n.key) {
      const s = strOf(n.key);
      if (s !== null) {
        edits.push({ s: n.key.start - 1 >= 0 && src[n.key.start - 1] === '[' ? n.key.start - 1 : n.key.start,
                     e: src[n.key.end] === ']' ? n.key.end + 1 : n.key.end,
                     t: isName(s) ? s : JSON.stringify(s), kind: 'ckey' });
        stats.keys++;
      }
    }
    // obfuscated booleans: !![] -> true, ![] -> false
    if (n.type === 'UnaryExpression' && n.operator === '!') {
      const a = n.argument;
      const isEmptyArr = (x) => x.type === 'ArrayExpression' && x.elements.length === 0;
      if (isEmptyArr(a)) { edits.push({ s: n.start, e: n.end, t: 'false', kind: 'bool' }); }
      else if (a.type === 'UnaryExpression' && a.operator === '!' && isEmptyArr(a.argument)) { edits.push({ s: n.start, e: n.end, t: 'true', kind: 'bool' }); }
    }
    // hex numerics -> decimal
    if (n.type === 'Literal' && typeof n.value === 'number' && /^0[xX]/.test(n.raw)) {
      edits.push({ s: n.start, e: n.end, t: String(n.value), kind: 'num' });
      stats.nums++;
    }
  });
  // apply: outermost edit wins, drop anything nested inside an accepted edit
  edits.sort((a, b) => a.s - b.s || b.e - a.e);
  const accepted = [];
  let lastEnd = -1;
  for (const ed of edits) {
    if (ed.s < lastEnd) continue;
    accepted.push(ed); lastEnd = ed.e;
  }
  return applyEdits(src, accepted);
}

// apply non-overlapping edits, inserting a space if a replacement would fuse two identifier chars
function applyEdits(src, edits) {
  const W = /[\w$]/;
  let out = '', pos = 0;
  for (const ed of edits) {
    out += src.slice(pos, ed.s);
    let t = ed.t;
    if (t.length && out.length && W.test(out[out.length - 1]) && W.test(t[0])) t = ' ' + t;
    if (t.length && ed.e < src.length && W.test(t[t.length - 1]) && W.test(src[ed.e])) t += ' ';
    out += t; pos = ed.e;
  }
  return out + src.slice(pos);
}

function pass2(src, decName, arrName, aliases, stats) {
  // remove alias declarators + dead machinery
  const ast = parse(src);
  const del = [];
  const names = new Set([...aliases]);
  walk(ast, (n, parent) => {
    if (n.type === 'VariableDeclaration') {
      const ds = n.declarations;
      const isAl = (d) => d.id.type === 'Identifier' && d.init && d.init.type === 'Identifier' && names.has(d.init.name);
      const al = ds.filter(isAl);
      if (!al.length) return;
      if (parent && parent.type && /^(ForStatement|ForInStatement|ForOfStatement)$/.test(parent.type)) return;
      if (al.length === ds.length) del.push({ s: n.start, e: n.end, t: '' });
      else {
        const keep = ds.filter((d) => !isAl(d)).map((d) => src.slice(d.start, d.end)).join(',');
        const semi = src[n.end - 1] === ';' ? ';' : '';
        del.push({ s: n.start, e: n.end, t: n.kind + ' ' + keep + semi });
      }
      stats.aliasesRemoved += al.length;
    }
  });
  // top-level machinery
  const m = (() => { try { return findMachinery(src, ast); } catch (_) { return null; } })();
  if (m) {
    del.push({ s: m.rot.node.start, e: m.rot.node.end, t: '' });
    del.push({ s: m.arr.start, e: m.arr.end, t: '' });
    del.push({ s: m.dec.start, e: m.dec.end, t: '' });
  }
  del.sort((a, b) => a.s - b.s || b.e - a.e);
  const acc = []; let lastEnd = -1;
  for (const ed of del) { if (ed.s < lastEnd) continue; acc.push(ed); lastEnd = ed.e; }
  return applyEdits(src, acc);
}

function deobfuscate(src) {
  const stats = { strings: 0, members: 0, keys: 0, nums: 0, aliasesRemoved: 0 };
  const ast = parse(src);
  const m = findMachinery(src, ast);
  const decode = buildDecoder(src, m);
  const aliases = collectAliases(ast, m.dec.id.name);
  let out = pass1(src, ast, decode, aliases, stats);
  // leftover references to decoder aliases? (means some call shapes were not resolved)
  const left = (() => {
    let c = 0; const a2 = parse(out);
    walk(a2, (n) => { if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && aliases.has(n.callee.name) &&
      n.arguments.length >= 1 && n.arguments[0].type === 'Literal' && typeof n.arguments[0].value === 'number') c++; });
    return c;
  })();
  out = pass2(out, m.dec.id.name, m.arr.id.name, aliases, stats);
  const pretty = esbuild.transformSync(out, { loader: 'js', format: 'esm', minify: false, target: 'esnext', legalComments: 'none' }).code;
  return { code: pretty, stats: { ...stats, unresolvedCalls: left, aliasCount: aliases.size } };
}

module.exports = { deobfuscate, parse, findMachinery, buildDecoder, collectAliases, pass1, pass2 };

if (require.main === module) {
  const path = require('path');
  const [inp, outp] = process.argv.slice(2);
  if (!inp) { console.error('usage: deobf.cjs <in.js | inDir> [out.js | outDir]'); process.exit(1); }
  const one = (src, dst) => {
    try {
      const { code, stats } = deobfuscate(fs.readFileSync(src, 'utf8'));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, code);
      console.log('ok     ', src, JSON.stringify(stats));
      return true;
    } catch (e) { console.log('skipped', src, '-', e.message); return false; }
  };
  if (fs.statSync(inp).isDirectory()) {
    const out = outp || inp.replace(/\/$/, '') + '-deobf';
    const walk2 = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (e.name === 'node_modules' ? [] : walk2(path.join(d, e.name))) : [path.join(d, e.name)]);
    let ok = 0, n = 0;
    for (const f of walk2(inp)) {
      if (!/\.m?js$/.test(f) || /\.min\.js$|[\\/]vendor[\\/]/.test(f)) continue;
      n++; if (one(f, path.join(out, path.relative(inp, f)))) ok++;
    }
    console.log(`\n${ok}/${n} files deobfuscated -> ${out}`);
  } else {
    process.exit(one(inp, outp || inp.replace(/\.m?js$/, '.deobf.js')) ? 0 : 2);
  }
}
