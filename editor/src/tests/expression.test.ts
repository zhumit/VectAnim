import { describe, expect, it } from 'vitest';
import { checkExpression, compileExpression, ExpressionError, tokenize } from '../engine/expression';

function evaluate(source: string, variables: Record<string, number> = {}, t = 0): number {
  const compiled = compileExpression(source);
  return compiled.evaluate({ get: (name) => variables[name], t });
}

describe('Expression engine', () => {
  it('basic arithmetic and operator precedence', () => {
    expect(evaluate('1 + 2 * 3')).toBe(7);
    expect(evaluate('(1 + 2) * 3')).toBe(9);
    expect(evaluate('10 / 4')).toBe(2.5);
    expect(evaluate('10 % 3')).toBe(1);
    expect(evaluate('2 ^ 3 ^ 2')).toBe(512);
    expect(evaluate('-2 ^ 2')).toBe(-4);
    expect(evaluate('2 ^ -1')).toBe(0.5);
  });

  it('division by zero returns 0 instead of Infinity/NaN', () => {
    expect(evaluate('5 / 0')).toBe(0);
    expect(evaluate('5 % 0')).toBe(0);
  });

  it('variables and time t', () => {
    expect(evaluate('RPM * 6 * t', { RPM: 100 }, 2)).toBe(1200);
    expect(evaluate('t', {}, 3.5)).toBe(3.5);
  });

  it('undefined variables are treated as 0', () => {
    expect(evaluate('Missing + 5')).toBe(5);
  });

  it('trigonometric functions use degrees', () => {
    expect(evaluate('sin(30)')).toBeCloseTo(0.5, 10);
    expect(evaluate('cos(60)')).toBeCloseTo(0.5, 10);
    expect(evaluate('atan2(1, 1)')).toBeCloseTo(45, 10);
    expect(evaluate('asin(0.5)')).toBeCloseTo(30, 10);
  });

  it('whitelisted functions', () => {
    expect(evaluate('clamp(150, 0, 100)')).toBe(100);
    expect(evaluate('lerp(0, 10, 0.25)')).toBe(2.5);
    expect(evaluate('mod(-30, 360)')).toBe(330);
    expect(evaluate('round(3.14159, 2)')).toBe(3.14);
    expect(evaluate('min(3, 1, 2)')).toBe(1);
    expect(evaluate('max(3, 1, 2)')).toBe(3);
    expect(evaluate('if(2 > 1, 10, 20)')).toBe(10);
  });

  it('comparison, logical and ternary operators', () => {
    expect(evaluate('1 < 2')).toBe(1);
    expect(evaluate('1 > 2')).toBe(0);
    expect(evaluate('1 == 1 && 2 > 1')).toBe(1);
    expect(evaluate('0 || 0')).toBe(0);
    expect(evaluate('!0')).toBe(1);
    expect(evaluate('1 ? 5 : 9')).toBe(5);
  });

  it('constants pi / e', () => {
    expect(evaluate('pi')).toBeCloseTo(Math.PI, 10);
    expect(evaluate('e')).toBeCloseTo(Math.E, 10);
  });

  it('rejects functions outside the whitelist', () => {
    expect(() => compileExpression('System.IO.File.Delete("x")')).toThrow(ExpressionError);
    // String literals are unsupported and are rejected at the lexing stage
    // (no eval, no reflection — inherently immune to injection)
    expect(() => compileExpression('eval("1")')).toThrow(ExpressionError);
    expect(() => compileExpression('System(1)')).toThrow(/Unsupported function/);
    expect(checkExpression('abs(-1)').ok).toBe(true);
    expect(checkExpression('danger(1)').ok).toBe(false);
  });

  it('syntax errors report a position', () => {
    const result = checkExpression('1 + ');
    expect(result.ok).toBe(false);
    expect(result.message).toBeTruthy();
    expect(() => tokenize('1 @ 2')).toThrow(ExpressionError);
  });

  it('collects dependency variables and the t flag', () => {
    const compiled = compileExpression('RPM * 6 * t + Offset');
    expect(compiled.variables).toEqual(expect.arrayContaining(['RPM', 'Offset']));
    expect(compiled.usesTime).toBe(true);
    expect(compileExpression('RPM * 2').usesTime).toBe(false);
  });

  it('caches identical expression instances', () => {
    expect(compileExpression('RPM + 1')).toBe(compileExpression('RPM + 1'));
  });

  it('nested functions and negative arguments', () => {
    expect(evaluate('clamp(sin(-90) * 10, -5, 5)')).toBe(-5);
    expect(evaluate('sqrt(16) + abs(-4)')).toBe(8);
  });
});
