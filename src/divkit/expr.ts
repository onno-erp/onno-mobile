// A compact evaluator for DivKit's `@{ ... }` expression language.
//
// This is the part of the DivKit *web* SDK that is genuinely platform-agnostic
// (no DOM, no Svelte): variable references, string interpolation, arithmetic,
// comparisons, booleans and ternaries. We re-implement the subset the Onno
// server actually emits rather than running the Svelte renderer, so the result
// can drive native React Native components instead of HTML.

export type Variables = Record<string, unknown>;

const OPEN = '@{';

/** True if a string contains at least one `@{ … }` expression. */
export function hasExpression(s: string): boolean {
  return s.includes(OPEN);
}

/**
 * Resolve a value that may be a literal or a string carrying `@{…}` blocks.
 * A string that is exactly one expression returns the typed value; a string
 * with surrounding text returns an interpolated string.
 */
export function resolve(value: unknown, vars: Variables): unknown {
  if (typeof value !== 'string' || !hasExpression(value)) return value;

  // Whole-string expression → preserve the evaluated type (number/bool/…).
  const whole = value.match(/^@\{([\s\S]*)\}$/);
  if (whole && !whole[1].includes(OPEN)) {
    return safeEval(whole[1], vars);
  }

  // Mixed text + expressions → string interpolation.
  let out = '';
  let i = 0;
  while (i < value.length) {
    const start = value.indexOf(OPEN, i);
    if (start === -1) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, start);
    const end = matchBrace(value, start + OPEN.length);
    const src = value.slice(start + OPEN.length, end);
    out += stringify(safeEval(src, vars));
    i = end + 1;
  }
  return out;
}

/** Convenience: resolve a value and coerce to string for text/url props. */
export function resolveString(value: unknown, vars: Variables): string {
  const r = resolve(value, vars);
  return r == null ? '' : stringify(r);
}

function stringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

/** Find the index of the `}` that closes a `@{` opened just before `from`. */
function matchBrace(s: string, from: number): number {
  let depth = 1;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return s.length;
}

function safeEval(src: string, vars: Variables): unknown {
  try {
    return new Parser(src, vars).parseExpression();
  } catch {
    // DivKit's contract is "never crash the card" — fall back to the raw text.
    return src;
  }
}

// ----- tokenizer -----

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const ops = ['<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '<', '>', '!', '?', ':', '(', ')', ','];
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
    if (c === "'") {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== "'") {
        if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1]; j += 2; continue; }
        s += src[j++];
      }
      toks.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      toks.push({ t: 'num', v: parseFloat(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (ops.includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if (ops.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`unexpected char ${c}`);
  }
  return toks;
}

// ----- Pratt parser -----

const PREC: Record<string, number> = {
  '||': 1, '&&': 2,
  '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
};

class Parser {
  private toks: Tok[];
  private pos = 0;
  constructor(src: string, private vars: Variables) {
    this.toks = tokenize(src);
  }

  parseExpression(): unknown {
    const v = this.parseTernary();
    return v;
  }

  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private next(): Tok | undefined { return this.toks[this.pos++]; }

  private parseTernary(): unknown {
    const cond = this.parseBinary(0);
    const t = this.peek();
    if (t && t.t === 'op' && t.v === '?') {
      this.next();
      const a = this.parseTernary();
      const colon = this.next();
      if (!colon || colon.v !== ':') throw new Error('expected :');
      const b = this.parseTernary();
      return truthy(cond) ? a : b;
    }
    return cond;
  }

  private parseBinary(minPrec: number): unknown {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (!t || t.t !== 'op' || !(t.v in PREC)) break;
      const prec = PREC[t.v];
      if (prec < minPrec) break;
      this.next();
      const right = this.parseBinary(prec + 1);
      left = apply(t.v, left, right);
    }
    return left;
  }

  private parseUnary(): unknown {
    const t = this.peek();
    if (t && t.t === 'op' && (t.v === '!' || t.v === '-')) {
      this.next();
      const v = this.parseUnary();
      return t.v === '!' ? !truthy(v) : -(toNum(v));
    }
    return this.parsePrimary();
  }

  private parsePrimary(): unknown {
    const t = this.next();
    if (!t) throw new Error('unexpected end');
    if (t.t === 'num') return t.v;
    if (t.t === 'str') return t.v;
    if (t.t === 'op' && t.v === '(') {
      const v = this.parseTernary();
      const close = this.next();
      if (!close || close.v !== ')') throw new Error('expected )');
      return v;
    }
    if (t.t === 'id') {
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'null') return null;
      // function call?
      const n = this.peek();
      if (n && n.t === 'op' && n.v === '(') {
        const args = this.parseArgs();
        return callFn(t.v, args, this.vars);
      }
      return this.vars[t.v];
    }
    throw new Error(`unexpected token ${JSON.stringify(t)}`);
  }

  private parseArgs(): unknown[] {
    this.next(); // consume (
    const args: unknown[] = [];
    if (this.peek()?.v === ')') { this.next(); return args; }
    for (;;) {
      args.push(this.parseTernary());
      const t = this.next();
      if (t?.v === ')') break;
      if (t?.v !== ',') throw new Error('expected , or )');
    }
    return args;
  }
}

function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v == null) return false;
  if (typeof v === 'string') return v.length > 0;
  return true;
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return 0;
}

function apply(op: string, a: unknown, b: unknown): unknown {
  switch (op) {
    case '+':
      if (typeof a === 'string' || typeof b === 'string') return stringify(a) + stringify(b);
      return toNum(a) + toNum(b);
    case '-': return toNum(a) - toNum(b);
    case '*': return toNum(a) * toNum(b);
    case '/': return toNum(a) / toNum(b);
    case '%': return toNum(a) % toNum(b);
    case '==': return a === b;
    case '!=': return a !== b;
    case '<': return toNum(a) < toNum(b);
    case '<=': return toNum(a) <= toNum(b);
    case '>': return toNum(a) > toNum(b);
    case '>=': return toNum(a) >= toNum(b);
    case '&&': return truthy(a) && truthy(b);
    case '||': return truthy(a) ? a : b;
    default: throw new Error(`bad op ${op}`);
  }
}

// A few of DivKit's built-in functions, enough for common server templates.
function callFn(name: string, args: unknown[], _vars: Variables): unknown {
  switch (name) {
    case 'len': return typeof args[0] === 'string' ? (args[0] as string).length : 0;
    case 'toString': return stringify(args[0]);
    case 'toInteger': return Math.trunc(toNum(args[0]));
    case 'toNumber': return toNum(args[0]);
    case 'toBoolean': return truthy(args[0]);
    case 'lowercase': return stringify(args[0]).toLowerCase();
    case 'uppercase': return stringify(args[0]).toUpperCase();
    case 'trim': return stringify(args[0]).trim();
    case 'max': return Math.max(...args.map(toNum));
    case 'min': return Math.min(...args.map(toNum));
    case 'abs': return Math.abs(toNum(args[0]));
    default: return null;
  }
}
