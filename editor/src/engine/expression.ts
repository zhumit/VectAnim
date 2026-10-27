/**
 * VectAnim expression engine (TypeScript side; semantics match the C#
 * VectAnim.Wpf.Expressions implementation one-for-one).
 *
 * Design notes:
 *  1. Hand-written lexer + recursive-descent parser + closure compiler; no eval / new Function
 *     (CSP-safe, no injection surface).
 *  2. Function whitelist — anything not listed fails at compile time.
 *  3. Trigonometric functions take degrees (industrial convention: sin(30) = 0.5).
 *  4. A missing variable evaluates to 0 and is recorded in missingVariables so callers can warn.
 *  5. Booleans are represented as 1/0; comparisons return 1/0.
 *
 * Operator precedence (low → high):
 *   ?:  →  ||  →  &&  →  == !=  →  < <= > >=  →  + -  →  * / %  →  unary + - !  →  ^  →  primary
 */

import { t } from '../i18n';

export class ExpressionError extends Error {
  public readonly position: number;

  constructor(message: string, position = 0) {
    super(message);
    this.name = 'ExpressionError';
    this.position = position;
  }
}

/* ------------------------------------------------------------------ *
 * Lexer
 * ------------------------------------------------------------------ */

type TokenKind = 'number' | 'identifier' | 'operator' | 'lparen' | 'rparen' | 'comma' | 'eof';

interface Token {
  kind: TokenKind;
  text: string;
  position: number;
  value?: number;
}

const TWO_CHAR_OPERATORS = ['<=', '>=', '==', '!=', '&&', '||'];
const ONE_CHAR_OPERATORS = ['+', '-', '*', '/', '%', '^', '<', '>', '!', '?', ':'];

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentifierStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
}

function isIdentifierPart(ch: string): boolean {
  return isIdentifierStart(ch) || isDigit(ch) || ch === '.';
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const ch = source[index];

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      index += 1;
      continue;
    }

    if (isDigit(ch) || (ch === '.' && isDigit(source[index + 1] ?? ''))) {
      const start = index;
      while (index < source.length && (isDigit(source[index]) || source[index] === '.')) index += 1;
      // Exponent part
      if (index < source.length && (source[index] === 'e' || source[index] === 'E')) {
        const mark = index;
        index += 1;
        if (source[index] === '+' || source[index] === '-') index += 1;
        if (isDigit(source[index] ?? '')) {
          while (index < source.length && isDigit(source[index])) index += 1;
        } else {
          index = mark;
        }
      }
      const text = source.slice(start, index);
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new ExpressionError(t('engine.expr.err.invalidNumber', { text }), start);
      }
      tokens.push({ kind: 'number', text, position: start, value });
      continue;
    }

    if (isIdentifierStart(ch)) {
      const start = index;
      while (index < source.length && isIdentifierPart(source[index])) index += 1;
      tokens.push({ kind: 'identifier', text: source.slice(start, index), position: start });
      continue;
    }

    if (ch === '(') {
      tokens.push({ kind: 'lparen', text: ch, position: index++ });
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen', text: ch, position: index++ });
      continue;
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma', text: ch, position: index++ });
      continue;
    }

    const two = source.slice(index, index + 2);
    if (TWO_CHAR_OPERATORS.includes(two)) {
      tokens.push({ kind: 'operator', text: two, position: index });
      index += 2;
      continue;
    }

    if (ONE_CHAR_OPERATORS.includes(ch)) {
      tokens.push({ kind: 'operator', text: ch, position: index++ });
      continue;
    }

    throw new ExpressionError(t('engine.expr.err.unknownCharacter', { char: ch }), index);
  }

  tokens.push({ kind: 'eof', text: '', position: source.length });
  return tokens;
}

/* ------------------------------------------------------------------ *
 * Syntax tree
 * ------------------------------------------------------------------ */

type AstNode =
  | { kind: 'number'; value: number }
  | { kind: 'variable'; name: string }
  | { kind: 'unary'; op: string; operand: AstNode }
  | { kind: 'binary'; op: string; left: AstNode; right: AstNode }
  | { kind: 'conditional'; condition: AstNode; whenTrue: AstNode; whenFalse: AstNode }
  | { kind: 'call'; name: string; args: AstNode[] };

/* ------------------------------------------------------------------ *
 * Function whitelist
 * ------------------------------------------------------------------ */

export type EvalFn = (args: number[]) => number;

interface FunctionSpec {
  minArgs: number;
  maxArgs: number;
  fn: EvalFn;
  description: string;
}

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

function num(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Euclidean modulo: the sign follows the divisor, mod(-30, 360) = 330 */
export function euclideanMod(a: number, b: number): number {
  if (b === 0) return 0;
  const r = a % b;
  return r < 0 ? r + Math.abs(b) : r;
}

export const EXPRESSION_FUNCTIONS: Readonly<Record<string, FunctionSpec>> = {
  sin: { minArgs: 1, maxArgs: 1, fn: (a) => Math.sin(num(a[0]) * DEG), get description() { return t('engine.fn.sin'); } },
  cos: { minArgs: 1, maxArgs: 1, fn: (a) => Math.cos(num(a[0]) * DEG), get description() { return t('engine.fn.cos'); } },
  tan: { minArgs: 1, maxArgs: 1, fn: (a) => Math.tan(num(a[0]) * DEG), get description() { return t('engine.fn.tan'); } },
  asin: { minArgs: 1, maxArgs: 1, fn: (a) => Math.asin(Math.max(-1, Math.min(1, num(a[0])))) * RAD, get description() { return t('engine.fn.asin'); } },
  acos: { minArgs: 1, maxArgs: 1, fn: (a) => Math.acos(Math.max(-1, Math.min(1, num(a[0])))) * RAD, get description() { return t('engine.fn.acos'); } },
  atan: { minArgs: 1, maxArgs: 1, fn: (a) => Math.atan(num(a[0])) * RAD, get description() { return t('engine.fn.atan'); } },
  atan2: { minArgs: 2, maxArgs: 2, fn: (a) => Math.atan2(num(a[0]), num(a[1])) * RAD, get description() { return t('engine.fn.atan2'); } },
  sqrt: { minArgs: 1, maxArgs: 1, fn: (a) => Math.sqrt(Math.max(0, num(a[0]))), get description() { return t('engine.fn.sqrt'); } },
  abs: { minArgs: 1, maxArgs: 1, fn: (a) => Math.abs(num(a[0])), get description() { return t('engine.fn.abs'); } },
  min: { minArgs: 1, maxArgs: 8, fn: (a) => Math.min(...a.map(num)), get description() { return t('engine.fn.min'); } },
  max: { minArgs: 1, maxArgs: 8, fn: (a) => Math.max(...a.map(num)), get description() { return t('engine.fn.max'); } },
  pow: { minArgs: 2, maxArgs: 2, fn: (a) => Math.pow(num(a[0]), num(a[1])), get description() { return t('engine.fn.pow'); } },
  floor: { minArgs: 1, maxArgs: 1, fn: (a) => Math.floor(num(a[0])), get description() { return t('engine.fn.floor'); } },
  ceil: { minArgs: 1, maxArgs: 1, fn: (a) => Math.ceil(num(a[0])), get description() { return t('engine.fn.ceil'); } },
  round: { minArgs: 1, maxArgs: 2, fn: (a) => {
    const digits = a.length > 1 ? Math.trunc(num(a[1])) : 0;
    const factor = Math.pow(10, Math.max(-8, Math.min(8, digits)));
    return Math.round(num(a[0]) * factor) / factor;
  }, get description() { return t('engine.fn.round'); } },
  trunc: { minArgs: 1, maxArgs: 1, fn: (a) => Math.trunc(num(a[0])), get description() { return t('engine.fn.trunc'); } },
  sign: { minArgs: 1, maxArgs: 1, fn: (a) => Math.sign(num(a[0])), get description() { return t('engine.fn.sign'); } },
  exp: { minArgs: 1, maxArgs: 1, fn: (a) => Math.exp(num(a[0])), get description() { return t('engine.fn.exp'); } },
  ln: { minArgs: 1, maxArgs: 1, fn: (a) => Math.log(Math.max(1e-12, num(a[0]))), get description() { return t('engine.fn.ln'); } },
  log: { minArgs: 1, maxArgs: 2, fn: (a) => {
    const v = Math.max(1e-12, num(a[0]));
    if (a.length > 1) {
      const base = num(a[1]);
      return base > 0 && base !== 1 ? Math.log(v) / Math.log(base) : 0;
    }
    return Math.log(v);
  }, get description() { return t('engine.fn.log'); } },
  log10: { minArgs: 1, maxArgs: 1, fn: (a) => Math.log10(Math.max(1e-12, num(a[0]))), get description() { return t('engine.fn.log10'); } },
  clamp: { minArgs: 3, maxArgs: 3, fn: (a) => Math.min(Math.max(num(a[0]), num(a[1])), num(a[2])), get description() { return t('engine.fn.clamp'); } },
  lerp: { minArgs: 3, maxArgs: 3, fn: (a) => num(a[0]) + (num(a[1]) - num(a[0])) * num(a[2]), get description() { return t('engine.fn.lerp'); } },
  mod: { minArgs: 2, maxArgs: 2, fn: (a) => euclideanMod(num(a[0]), num(a[1])), get description() { return t('engine.fn.mod'); } },
  deg: { minArgs: 1, maxArgs: 1, fn: (a) => num(a[0]) * RAD, get description() { return t('engine.fn.deg'); } },
  rad: { minArgs: 1, maxArgs: 1, fn: (a) => num(a[0]) * DEG, get description() { return t('engine.fn.rad'); } },
  if: { minArgs: 3, maxArgs: 3, fn: (a) => (num(a[0]) !== 0 ? num(a[1]) : num(a[2])), get description() { return t('engine.fn.if'); } },
  pi: { minArgs: 0, maxArgs: 0, fn: () => Math.PI, get description() { return t('engine.fn.pi'); } },
};

export const EXPRESSION_CONSTANTS: Readonly<Record<string, number>> = {
  pi: Math.PI,
  e: Math.E,
  true: 1,
  false: 0,
};

export function isKnownFunction(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXPRESSION_FUNCTIONS, name.toLowerCase());
}

export function functionNames(): string[] {
  return Object.keys(EXPRESSION_FUNCTIONS).sort();
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.index];
  }

  private next(): Token {
    return this.tokens[this.index++];
  }

  private matchOperator(...texts: string[]): boolean {
    const token = this.peek();
    if (token.kind === 'operator' && texts.includes(token.text)) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private expectOperator(text: string): void {
    if (!this.matchOperator(text)) {
      const token = this.peek();
      throw new ExpressionError(
        t('engine.expr.err.missingOperator', { expected: text, found: token.text || t('engine.expr.err.end') }),
        token.position,
      );
    }
  }

  parse(): AstNode {
    if (this.peek().kind === 'eof') {
      throw new ExpressionError(t('engine.expr.err.empty'), 0);
    }
    const node = this.parseConditional();
    const token = this.peek();
    if (token.kind !== 'eof') {
      throw new ExpressionError(t('engine.expr.err.trailingContent', { token: token.text }), token.position);
    }
    return node;
  }

  private parseConditional(): AstNode {
    const condition = this.parseLogicalOr();
    if (this.matchOperator('?')) {
      const whenTrue = this.parseConditional();
      this.expectOperator(':');
      const whenFalse = this.parseConditional();
      return { kind: 'conditional', condition, whenTrue, whenFalse };
    }
    return condition;
  }

  private parseLogicalOr(): AstNode {
    let left = this.parseLogicalAnd();
    while (this.matchOperator('||')) {
      const right = this.parseLogicalAnd();
      left = { kind: 'binary', op: '||', left, right };
    }
    return left;
  }

  private parseLogicalAnd(): AstNode {
    let left = this.parseEquality();
    while (this.matchOperator('&&')) {
      const right = this.parseEquality();
      left = { kind: 'binary', op: '&&', left, right };
    }
    return left;
  }

  private parseEquality(): AstNode {
    let left = this.parseComparison();
    while (this.matchOperator('==', '!=')) {
      const op = this.tokens[this.index - 1].text;
      const right = this.parseComparison();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseComparison(): AstNode {
    let left = this.parseAdditive();
    while (this.matchOperator('<', '<=', '>', '>=')) {
      const op = this.tokens[this.index - 1].text;
      const right = this.parseAdditive();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseAdditive(): AstNode {
    let left = this.parseMultiplicative();
    while (this.matchOperator('+', '-')) {
      const op = this.tokens[this.index - 1].text;
      const right = this.parseMultiplicative();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseMultiplicative(): AstNode {
    let left = this.parseUnary();
    while (this.matchOperator('*', '/', '%')) {
      const op = this.tokens[this.index - 1].text;
      const right = this.parseUnary();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseUnary(): AstNode {
    if (this.matchOperator('-', '+', '!')) {
      const op = this.tokens[this.index - 1].text;
      const operand = this.parseUnary();
      return { kind: 'unary', op, operand };
    }
    return this.parsePower();
  }

  private parsePower(): AstNode {
    const base = this.parsePrimary();
    if (this.matchOperator('^')) {
      // Right-associative: 2^3^2 = 2^(3^2)
      const exponent = this.parseUnary();
      return { kind: 'binary', op: '^', left: base, right: exponent };
    }
    return base;
  }

  private parsePrimary(): AstNode {
    const token = this.next();

    if (token.kind === 'number') {
      return { kind: 'number', value: token.value ?? 0 };
    }

    if (token.kind === 'lparen') {
      const inner = this.parseConditional();
      if (this.next().kind !== 'rparen') {
        throw new ExpressionError(t('engine.expr.err.missingClosingParen'), token.position);
      }
      return inner;
    }

    if (token.kind === 'identifier') {
      const lowered = token.text.toLowerCase();
      const isCall = this.peek().kind === 'lparen';

      if (isCall) {
        if (!isKnownFunction(lowered)) {
          throw new ExpressionError(t('engine.expr.err.unknownFunction', { name: token.text }), token.position);
        }
        this.next(); // consume '('
        const args: AstNode[] = [];
        if (this.peek().kind !== 'rparen') {
          args.push(this.parseConditional());
          while (this.peek().kind === 'comma') {
            this.next();
            args.push(this.parseConditional());
          }
        }
        if (this.next().kind !== 'rparen') {
          throw new ExpressionError(t('engine.expr.err.functionMissingParen', { name: token.text }), token.position);
        }
        const spec = EXPRESSION_FUNCTIONS[lowered];
        if (args.length < spec.minArgs || args.length > spec.maxArgs) {
          const expected = `${spec.minArgs}${spec.maxArgs !== spec.minArgs ? `..${spec.maxArgs}` : ''}`;
          throw new ExpressionError(
            t('engine.expr.err.argumentCount', { name: token.text, expected, actual: args.length }),
            token.position,
          );
        }
        return { kind: 'call', name: lowered, args };
      }

      // Constant names (pi / e / true / false) take precedence; everything else is a variable
      if (Object.prototype.hasOwnProperty.call(EXPRESSION_CONSTANTS, lowered)) {
        return { kind: 'number', value: EXPRESSION_CONSTANTS[lowered] };
      }
      return { kind: 'variable', name: token.text };
    }

    throw new ExpressionError(t('engine.expr.err.unexpectedToken', { token: token.text || t('engine.expr.err.end') }), token.position);
  }
}

/* ------------------------------------------------------------------ *
 * Compilation and evaluation
 * ------------------------------------------------------------------ */

export interface EvalContext {
  /** Variable lookup; undefined means the variable does not exist (treated as 0) */
  get(name: string): number | undefined;
  /** Animation time (seconds) */
  t: number;
}

export type Evaluator = (ctx: EvalContext) => number;

export interface CompiledExpression {
  readonly source: string;
  /** Names of the variables referenced by the expression (excluding t) */
  readonly variables: readonly string[];
  readonly usesTime: boolean;
  evaluate(ctx: EvalContext): number;
}

function compileNode(node: AstNode, variables: Set<string>, flags: { usesTime: boolean }): Evaluator {
  switch (node.kind) {
    case 'number': {
      const value = node.value;
      return () => value;
    }
    case 'variable': {
      if (node.name === 't' || node.name === 'T') {
        flags.usesTime = true;
        return (ctx) => ctx.t;
      }
      variables.add(node.name);
      const name = node.name;
      return (ctx) => {
        const value = ctx.get(name);
        return typeof value === 'number' && Number.isFinite(value) ? value : 0;
      };
    }
    case 'unary': {
      const operand = compileNode(node.operand, variables, flags);
      if (node.op === '-') return (ctx) => -operand(ctx);
      if (node.op === '+') return operand;
      return (ctx) => (operand(ctx) === 0 ? 1 : 0);
    }
    case 'binary': {
      const left = compileNode(node.left, variables, flags);
      const right = compileNode(node.right, variables, flags);
      switch (node.op) {
        case '+': return (ctx) => left(ctx) + right(ctx);
        case '-': return (ctx) => left(ctx) - right(ctx);
        case '*': return (ctx) => left(ctx) * right(ctx);
        case '/': return (ctx) => {
          const divisor = right(ctx);
          return divisor === 0 ? 0 : left(ctx) / divisor;
        };
        case '%': return (ctx) => {
          const divisor = right(ctx);
          return divisor === 0 ? 0 : left(ctx) % divisor;
        };
        case '^': return (ctx) => Math.pow(left(ctx), right(ctx));
        case '<': return (ctx) => (left(ctx) < right(ctx) ? 1 : 0);
        case '<=': return (ctx) => (left(ctx) <= right(ctx) ? 1 : 0);
        case '>': return (ctx) => (left(ctx) > right(ctx) ? 1 : 0);
        case '>=': return (ctx) => (left(ctx) >= right(ctx) ? 1 : 0);
        case '==': return (ctx) => (left(ctx) === right(ctx) ? 1 : 0);
        case '!=': return (ctx) => (left(ctx) !== right(ctx) ? 1 : 0);
        case '&&': return (ctx) => (left(ctx) !== 0 && right(ctx) !== 0 ? 1 : 0);
        case '||': return (ctx) => (left(ctx) !== 0 || right(ctx) !== 0 ? 1 : 0);
        default:
          throw new ExpressionError(t('engine.expr.err.unknownOperator', { op: node.op }));
      }
    }
    case 'conditional': {
      const condition = compileNode(node.condition, variables, flags);
      const whenTrue = compileNode(node.whenTrue, variables, flags);
      const whenFalse = compileNode(node.whenFalse, variables, flags);
      return (ctx) => (condition(ctx) !== 0 ? whenTrue(ctx) : whenFalse(ctx));
    }
    case 'call': {
      const spec = EXPRESSION_FUNCTIONS[node.name];
      const args = node.args.map((arg) => compileNode(arg, variables, flags));
      const fn = spec.fn;
      if (args.length === 1) {
        const a0 = args[0];
        return (ctx) => fn([a0(ctx)]);
      }
      if (args.length === 2) {
        const [a0, a1] = args;
        return (ctx) => fn([a0(ctx), a1(ctx)]);
      }
      if (args.length === 3) {
        const [a0, a1, a2] = args;
        return (ctx) => fn([a0(ctx), a1(ctx), a2(ctx)]);
      }
      return (ctx) => fn(args.map((arg) => arg(ctx)));
    }
    default:
      throw new ExpressionError(t('engine.expr.err.unknownNode'));
  }
}

const compiledCache = new Map<string, CompiledExpression>();

/** Compile an expression; syntax errors throw ExpressionError */
export function compileExpression(source: string): CompiledExpression {
  const key = source;
  const cached = compiledCache.get(key);
  if (cached) return cached;

  const tokens = tokenize(source);
  const ast = new Parser(tokens).parse();
  const variables = new Set<string>();
  const flags = { usesTime: false };
  const evaluator = compileNode(ast, variables, flags);

  const compiled: CompiledExpression = {
    source,
    variables: [...variables],
    usesTime: flags.usesTime,
    evaluate(ctx: EvalContext): number {
      const result = evaluator(ctx);
      return Number.isFinite(result) ? result : 0;
    },
  };

  if (compiledCache.size > 512) compiledCache.clear();
  compiledCache.set(key, compiled);
  return compiled;
}

export interface ExpressionCheck {
  ok: boolean;
  message?: string;
  position?: number;
  variables: string[];
  usesTime: boolean;
}

/** Validate an expression, used by the editor's live hints and by import validation */
export function checkExpression(source: string): ExpressionCheck {
  try {
    const compiled = compileExpression(source);
    return { ok: true, variables: [...compiled.variables], usesTime: compiled.usesTime };
  } catch (error) {
    const err = error as ExpressionError;
    return {
      ok: false,
      message: err.message,
      position: err.position,
      variables: [],
      usesTime: false,
    };
  }
}
