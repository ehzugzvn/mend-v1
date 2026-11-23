// main.ts is mend, the CLI SPEC.md specifies (MIT). It applies an edit an AI model wrote, in one of four
// formats (unified diff, SEARCH/REPLACE blocks, V4A patch, JSON tool calls), to a tree of text files:
// every file is changed or nothing is. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 condition: its one output line is already complete. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: a code (no-match, ambiguous, missing, exists, unsafe) and the path it concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

type Move = { from: string; to: string };
type Edit = (tree: Tree, moves: Move[]) => void;

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (section 3): non-empty, relative, no backslash, no empty, dot or dot-dot segment. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function checkSafe(p: string): void {
  if (!isSafePath(p)) throw new Fail('unsafe', p);
}

/** Byte order of paths (UTF-8), the only ordering the output uses. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

interface FileParts {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

/** A file split by its own line break: CRLF when its first line feed follows a carriage return, else LF. */
function splitFile(text: string): FileParts {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], finalBreak: false };
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { br, lines, finalBreak };
}

function joinFile(lines: string[], br: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBreak ? br : '');
}

// ---- Section 5: matching lines at three tiers ----

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function tierNorm(s: string, tier: number): string {
  if (tier === 1) return stripTrail(s);
  if (tier === 2) return stripBoth(s);
  return s;
}

interface TierHit {
  tier: number;
  at: number[];
}

/**
 * The occurrences of O in `lines`, at the first tier that has any. Only positions >= from are considered,
 * and when endOnly is set only occurrences ending at the file's last line. Null when O occurs at no tier.
 */
function findTier(lines: string[], O: string[], strict: boolean, from: number, endOnly: boolean): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at: number[] = [];
    for (let i = Math.max(0, from); i + O.length <= lines.length; i += 1) {
      if (endOnly && i + O.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j += 1) {
        if (tierNorm(lines[i + j]!, tier) !== tierNorm(O[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One piece of a replacement: a context line (taken from the file) or an added line (from the patch). */
type Op = { kind: 'ctx'; oi: number } | { kind: 'add'; text: string };

/**
 * The lines that replace the matched O at `pos`: context pieces are the file's own matched lines; at
 * tier 2 every other added line is re-indented from O's first line's indent to the file's (section 5).
 */
function buildOut(ops: Op[], O: string[], fileLines: string[], pos: number, tier: number): string[] {
  const F = O.length > 0 ? leadWs(fileLines[pos]!) : '';
  const P = O.length > 0 ? leadWs(O[0]!) : '';
  const out: string[] = [];
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(fileLines[pos + op.oi]!);
    } else if (tier === 2 && op.text !== '' && !/^[ \t]*$/.test(op.text) && op.text.startsWith(P)) {
      out.push(F + op.text.slice(P.length));
    } else {
      out.push(op.text);
    }
  }
  return out;
}

/** Ops for a replacement whose lines are all additions (SEARCH/REPLACE blocks have no context lines). */
function addOps(texts: string[]): Op[] {
  return texts.map((text) => ({ kind: 'add' as const, text }));
}

/**
 * The tree as the edits leave it: paths an edit touched live in `now` (null: deleted), everything else is
 * read from disk on first sight and remembered in `orig`, so the final report can compare before and after.
 */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** The current text of a file an edit changes, or the edit fails: unsafe first, then missing. */
function mustExist(tree: Tree, p: string): string {
  checkSafe(p);
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
}

// ---- Section 6: unified diffs ----

interface UHunk {
  a: number;
  o: string[];
  ops: Op[];
  /** A `\` line follows this hunk's last context or `+` body line. */
  endBs: boolean;
  /** A `\` line follows this hunk's last `+` body line. */
  lastPlusBs: boolean;
}

interface USec {
  diffOld: string | undefined;
  diffNew: string | undefined;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  hasPair: boolean;
  renFrom: string | undefined;
  renTo: string | undefined;
  newMode: boolean;
  delMode: boolean;
  hunks: UHunk[];
  /** A deletion whose header pair is read: the rest of the section is skipped unread (section 6). */
  skip: boolean;
}

function newSec(): USec {
  return {
    diffOld: undefined,
    diffNew: undefined,
    pairOld: undefined,
    pairNew: undefined,
    hasPair: false,
    renFrom: undefined,
    renTo: undefined,
    newMode: false,
    delMode: false,
    hunks: [],
    skip: false,
  };
}

const secIsDelete = (s: USec): boolean => s.delMode || (s.hasPair && s.pairNew === null);
const secIsCreate = (s: USec): boolean => s.newMode || (s.hasPair && s.pairOld === null);

/** A ---/+++ path: text after the four characters, up to the first tab, spaces removed, a/ or b/ stripped. */
function headerPath(raw: string): string | null {
  const tab = raw.indexOf('\t');
  const s = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) return s.slice(2);
  return s;
}

interface RawItem {
  k: string;
  text: string;
  rawEmpty: boolean;
}

/** Reads one hunk starting at lines[i] (an `@@` line); returns the index just past its body. */
function readHunk(lines: string[], i: number, sec: USec): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@($| )/.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number.parseInt(m[1]!, 10);
  i += 1;
  const items: RawItem[] = [];
  while (i < lines.length) {
    const b = lines[i]!;
    if (b.startsWith('diff --git ')) break;
    if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (b === '') items.push({ k: ' ', text: '', rawEmpty: true });
    else if (b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') items.push({ k: b[0]!, text: b.slice(1), rawEmpty: false });
    else break;
    i += 1;
  }
  while (items.length > 0 && items[items.length - 1]!.rawEmpty) items.pop();
  const o: string[] = [];
  const ops: Op[] = [];
  for (const it of items) {
    if (it.k === ' ') {
      o.push(it.text);
      ops.push({ kind: 'ctx', oi: o.length - 1 });
    } else if (it.k === '-') o.push(it.text);
    else if (it.k === '+') ops.push({ kind: 'add', text: it.text });
  }
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  items.forEach((it, idx) => {
    if (it.k === ' ' || it.k === '+') lastCtxOrPlus = idx;
    if (it.k === '+') lastPlus = idx;
  });
  const follows = (idx: number): boolean => idx >= 0 && items[idx + 1]?.k === '\\';
  sec.hunks.push({ a, o, ops, endBs: follows(lastCtxOrPlus), lastPlusBs: follows(lastPlus) });
  return i;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const secs: USec[] = [];
  let cur: USec | null = null;
  const startsSection = (i: number): boolean =>
    lines[i]!.startsWith('diff --git ') || (lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '));
  let i = 0;
  while (i < lines.length) {
    const L = lines[i]!;
    if (cur !== null && cur.skip) {
      // A deletion's remaining lines are not read at all: skip to the next section or the patch's end.
      if (startsSection(i)) {
        cur = null;
        continue;
      }
      i += 1;
      continue;
    }
    if (L.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(L);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSec();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      secs.push(cur);
      i += 1;
      continue;
    }
    if (L.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A pair starts a new section unless it is the header pair of the section being read.
      if (cur === null || cur.hasPair || cur.hunks.length > 0) {
        cur = newSec();
        secs.push(cur);
      }
      cur.pairOld = headerPath(L.slice(4));
      cur.pairNew = headerPath(lines[i + 1]!.slice(4));
      cur.hasPair = true;
      if (secIsDelete(cur)) cur.skip = true;
      i += 2;
      continue;
    }
    if (L.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      // A --- line inside a section's header with no +++ line after it.
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (L.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      if (secIsDelete(cur)) {
        // Deleted file mode with no pair read yet: the hunks are not read either.
        cur.skip = true;
        i += 1;
        continue;
      }
      i = readHunk(lines, i, cur);
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // The section's header, before its first hunk.
      if (L.startsWith('rename from ')) cur.renFrom = L.slice(12).trim();
      else if (L.startsWith('rename to ')) cur.renTo = L.slice(10).trim();
      else if (L.startsWith('new file mode')) cur.newMode = true;
      else if (L.startsWith('deleted file mode')) {
        cur.delMode = true;
        if (cur.hasPair) cur.skip = true;
      }
      i += 1;
      continue;
    }
    // Anything else, outside bodies and headers, is ignored (prose, code fences).
    i += 1;
  }
  return secs.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(sec: USec, strict: boolean): Edit {
  const oldPath = sec.hasPair ? (sec.pairOld ?? undefined) : (sec.renFrom ?? sec.diffOld);
  const newPath = sec.hasPair ? (sec.pairNew ?? undefined) : (sec.renTo ?? sec.diffNew);
  return (tree, moves) => {
    if (secIsCreate(sec)) {
      const p = newPath ?? '';
      checkSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const texts: string[] = [];
      let lastPlusBs = false;
      for (const h of sec.hunks) {
        for (const op of h.ops) if (op.kind === 'add') texts.push(op.text);
        if (h.ops.some((op) => op.kind === 'add')) lastPlusBs = h.lastPlusBs;
      }
      tree.now.set(p, joinFile(texts, '\n', texts.length > 0 && !lastPlusBs));
      return;
    }
    if (secIsDelete(sec)) {
      const p = oldPath ?? '';
      checkSafe(p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const from = oldPath ?? '';
    const to = newPath ?? '';
    const isMove = from !== to;
    checkSafe(from);
    if (isMove) checkSafe(to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (isMove && tree.get(to) !== null) throw new Fail('exists', to);
    const file = splitFile(before);
    const outLines = [...file.lines];
    let finalBreak = file.finalBreak;
    let d = 0;
    for (const h of sec.hunks) {
      if (h.o.length === 0) {
        const pos = Math.max(0, Math.min(h.a + d, outLines.length));
        const atEnd = pos === outLines.length;
        const added = buildOut(h.ops, h.o, outLines, pos, 0);
        outLines.splice(pos, 0, ...added);
        if (atEnd) finalBreak = !h.endBs;
        d += added.length;
        continue;
      }
      const hit = findTier(outLines, h.o, strict, 0, false);
      if (hit === null) throw new Fail('no-match', from);
      const target = h.a - 1 + d;
      let pos = hit.at[0]!;
      for (const cand of hit.at) {
        if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
      }
      const reachesEnd = pos + h.o.length === outLines.length;
      const replacement = buildOut(h.ops, h.o, outLines, pos, hit.tier);
      outLines.splice(pos, h.o.length, ...replacement);
      if (reachesEnd) finalBreak = !h.endBs;
      d += replacement.length - h.o.length;
    }
    const text = joinFile(outLines, file.br, finalBreak);
    if (isMove) {
      tree.now.set(to, text);
      tree.now.set(from, null);
      moves.push({ from, to });
    } else {
      tree.now.set(from, text);
    }
  };
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    // The path: the nearest line before the SEARCH line, after the previous block, that is not blank
    // and does not (trimmed) start with three backticks; failing that, the previous block's path.
    let path: string | null = null;
    for (let j = searchLine - 1; j >= searchFrom; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      checkSafe(p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile(newLines, '\n', newLines.length > 0));
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const file = splitFile(before);
      const hit = findTier(file.lines, oldLines, strict, 0, false);
      if (hit === null) throw new Fail('no-match', p);
      if (hit.at.length > 1) throw new Fail('ambiguous', p);
      const pos = hit.at[0]!;
      const replacement = buildOut(addOps(newLines), oldLines, file.lines, pos, hit.tier);
      const out = [...file.lines];
      out.splice(pos, oldLines.length, ...replacement);
      tree.now.set(p, joinFile(out, file.br, file.finalBreak));
    });
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  ops: Op[];
}

type VSec =
  | { kind: 'add'; path: string; texts: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: VChunk[] };

const V4A_HEADS = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];
const isV4aHead = (l: string): boolean => V4A_HEADS.some((h) => l.startsWith(h));

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!isBlank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secs: VSec[] = [];
  let i = first + 1;
  while (i < last) {
    const L = lines[i]!;
    if (isBlank(L)) {
      i += 1;
      continue;
    }
    if (!isV4aHead(L)) throw new Exit2(`error: parse ${i + 1}`);
    const headLine = i;
    const kind = L.startsWith('*** Add File: ') ? 'add' : L.startsWith('*** Delete File: ') ? 'delete' : 'update';
    const path = L.slice(V4A_HEADS[kind === 'add' ? 0 : kind === 'delete' ? 1 : 2]!.length).trim();
    i += 1;
    // The section's raw lines, up to the next section (blank lines at its end are not part of it).
    const body: { line: number; text: string }[] = [];
    while (i < last && !isV4aHead(lines[i]!)) {
      body.push({ line: i + 1, text: lines[i]! });
      i += 1;
    }
    while (body.length > 0 && isBlank(body[body.length - 1]!.text)) body.pop();
    if (kind === 'add') {
      const texts: string[] = [];
      for (const b of body) {
        if (b.text.startsWith('+')) texts.push(b.text.slice(1));
        else if (b.text === '') texts.push('');
        else throw new Exit2(`error: parse ${b.line}`);
      }
      secs.push({ kind: 'add', path, texts });
    } else if (kind === 'delete') {
      for (const b of body) {
        if (!isBlank(b.text)) throw new Exit2(`error: parse ${b.line}`);
      }
      secs.push({ kind: 'delete', path });
    } else {
      let moveTo: string | null = null;
      let rest = body;
      if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
        moveTo = rest[0]!.text.slice('*** Move to: '.length).trim();
        rest = rest.slice(1);
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      // True once `*** End of File` ends the current chunk: a body line then belongs to no chunk
      // (only a new `@@` line starts one), so it is a parse error rather than part of that chunk.
      let chunkEnded = false;
      for (const b of rest) {
        if (b.text.startsWith('@@')) {
          cur = { anchor: b.text.slice(2).trim() || null, eof: false, o: [], ops: [] };
          chunks.push(cur);
          chunkEnded = false;
        } else if (b.text === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: true, o: [], ops: [] };
            chunks.push(cur);
          } else cur.eof = true;
          chunkEnded = true;
        } else if (b.text === '' || b.text[0] === ' ' || b.text[0] === '-' || b.text[0] === '+') {
          if (chunkEnded) throw new Exit2(`error: parse ${b.line}`);
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${b.line}`);
            cur = { anchor: null, eof: false, o: [], ops: [] };
            chunks.push(cur);
          }
          if (b.text === '' || b.text[0] === ' ') {
            cur.o.push(b.text === '' ? '' : b.text.slice(1));
            cur.ops.push({ kind: 'ctx', oi: cur.o.length - 1 });
          } else if (b.text[0] === '-') cur.o.push(b.text.slice(1));
          else cur.ops.push({ kind: 'add', text: b.text.slice(1) });
        } else throw new Exit2(`error: parse ${b.line}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headLine + 1}`);
      secs.push({ kind: 'update', path, moveTo, chunks });
    }
  }
  return secs.map((s) => v4aEdit(s, strict));
}

function v4aEdit(sec: VSec, strict: boolean): Edit {
  return (tree, moves) => {
    if (sec.kind === 'add') {
      checkSafe(sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, joinFile(sec.texts, '\n', sec.texts.length > 0));
      return;
    }
    if (sec.kind === 'delete') {
      checkSafe(sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    checkSafe(sec.path);
    if (sec.moveTo !== null) checkSafe(sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const file = splitFile(before);
    const out = [...file.lines];
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let found = -1;
        for (const tier of tiers) {
          for (let j = cursor; j < out.length; j += 1) {
            if (tierNorm(out[j]!, tier) === tierNorm(chunk.anchor, tier)) {
              found = j;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', sec.path);
        cursor = found + 1;
      }
      if (chunk.o.length === 0) {
        const pos = chunk.eof ? out.length : Math.min(cursor, out.length);
        const added = buildOut(chunk.ops, chunk.o, out, pos, 0);
        out.splice(pos, 0, ...added);
        cursor = pos + added.length;
        continue;
      }
      const hit = findTier(out, chunk.o, strict, cursor, chunk.eof);
      if (hit === null) throw new Fail('no-match', sec.path);
      const pos = hit.at[0]!;
      const replacement = buildOut(chunk.ops, chunk.o, out, pos, hit.tier);
      out.splice(pos, chunk.o.length, ...replacement);
      cursor = pos + replacement.length;
    }
    const text = joinFile(out, file.br, file.finalBreak);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, text);
      tree.now.set(sec.path, null);
      moves.push({ from: sec.path, to: sec.moveTo });
    } else {
      tree.now.set(sec.path, text);
    }
  };
}

// ---- Section 9: JSON edits ----

/** One JSON edit object, or null when it is not one (a parse fault wherever it appears). */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      checkSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = mustExist(tree, p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = mustExist(tree, p);
      const file = splitFile(before);
      if (line < 0 || line > file.lines.length) throw new Fail('no-match', p);
      const out = [...file.lines];
      out.splice(line, 0, ...add);
      tree.now.set(p, joinFile(out, file.br, file.finalBreak));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 4: detecting the format ----

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, idx) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Sections 1, 2 and 10: the command line, the run, the all-or-nothing write ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const moves: Move[] = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const moveCount = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of snapshot) tree.now.set(k, v);
      moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // Changed paths, with a successful move's D+A pair replaced by one R line that sorts by its new path.
  interface Row {
    sortKey: string;
    line: string;
    path: string;
  }
  const rows: Row[] = [];
  const paired = new Set<string>();
  for (const mv of moves) {
    if (paired.has(mv.from) || paired.has(mv.to)) continue;
    const wasFrom = tree.original(mv.from);
    const nowFrom = tree.now.has(mv.from) ? tree.now.get(mv.from)! : wasFrom;
    const wasTo = tree.original(mv.to);
    const nowTo = tree.now.has(mv.to) ? tree.now.get(mv.to)! : wasTo;
    if (wasFrom !== null && nowFrom === null && wasTo === null && nowTo !== null) {
      rows.push({ sortKey: mv.to, line: `R ${mv.from} -> ${mv.to}`, path: mv.to });
      paired.add(mv.from);
      paired.add(mv.to);
    }
  }
  for (const p of tree.now.keys()) {
    if (paired.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ sortKey: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, path: p });
  }
  rows.sort((x, y) => byteCompare(x.sortKey, y.sortKey));
  if (!check) {
    for (const row of rows) {
      const now = tree.now.get(row.path)!;
      if (now === null) rmSync(row.path, { force: true });
      else {
        mkdirSync(dirname(row.path), { recursive: true });
        writeFileSync(row.path, now);
      }
    }
    // A paired move's old path is not a row of its own, but the file still has to go.
    for (const p of paired) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
  }
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}


