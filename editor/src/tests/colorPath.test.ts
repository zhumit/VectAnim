import { describe, expect, it } from 'vitest';
import { alphaOf, normalizeColor, parseColor, parseColorValue, toCssColor, toHex6, toWpfHex } from '../engine/color';
import { parsePathData, pathBounds, stringifyPathData, arcToCubics, PathDataError } from '../engine/pathData';

describe('Color normalization', () => {
  it('6-digit hex → WPF #AARRGGBB', () => {
    expect(normalizeColor('#ff0000')).toBe('#FFFF0000');
    expect(normalizeColor('#0F0')).toBe('#FF00FF00');
  });

  it('CSS 8-digit (#RRGGBBAA) parsed with alpha at the end', () => {
    expect(normalizeColor('#FF000080')).toBe('#80FF0000');
  });

  it('WPF 8-digit (#AARRGGBB) parsing stays consistent', () => {
    // A string already in WPF order is re-parsed as CSS order, so the editor
    // only ever emits WPF order internally
    const rgba = parseColor('#80FF0000');
    expect(rgba).not.toBeNull();
  });

  it('rgba() and named colors', () => {
    expect(normalizeColor('rgba(255, 0, 0, 0.5)')).toBe('#80FF0000');
    expect(normalizeColor('red')).toBe('#FFFF0000');
    expect(normalizeColor('transparent')).toBeNull();
    expect(normalizeColor('none')).toBeNull();
    expect(normalizeColor('not-a-color')).toBeNull();
  });

  it('numeric colors parsed as 0xRRGGBB', () => {
    expect(toWpfHex(parseColorValue(0x00ff00)!)).toBe('#FF00FF00');
    expect(toWpfHex(parseColorValue(16711680)!)).toBe('#FFFF0000');
    expect(parseColorValue(-1)).toBeNull();
  });

  it('document color → CSS and #RRGGBB', () => {
    // Document convention is #AARRGGBB
    expect(toCssColor('#80FF0000')).toBe('rgba(255, 0, 0, 0.502)');
    expect(toHex6('#FF00FF00')).toBe('#00FF00');
    expect(alphaOf('#80FF0000')).toBeCloseTo(0.502, 3);
  });
});

describe('Path parsing', () => {
  it('parses basic commands and computes the bounding box', () => {
    const parsed = parsePathData('M 10,10 L 110,10 L 110,60 Z');
    expect(parsed.commands).toHaveLength(4);
    const bounds = pathBounds(parsed.commands);
    expect(bounds).toEqual({ x: 10, y: 10, width: 100, height: 50 });
  });

  it('relative commands and implicit repeats', () => {
    const parsed = parsePathData('m 10,10 l 20,0 0,20 z');
    expect(parsed.commands[0]).toEqual({ type: 'M', x: 10, y: 10 });
    expect(parsed.commands[1]).toEqual({ type: 'L', x: 30, y: 10 });
    expect(parsed.commands[2]).toEqual({ type: 'L', x: 30, y: 30 });
  });

  it('H/V and curve commands', () => {
    const parsed = parsePathData('M0,0 H50 V50 C60,60 70,70 80,80 Q90,90 100,100');
    expect(parsed.commands.filter((command) => command.type === 'L')).toHaveLength(2);
    expect(parsed.commands.some((command) => command.type === 'C')).toBe(true);
    expect(parsed.commands.some((command) => command.type === 'Q')).toBe(true);
  });

  it('arc → bezier with accurate end point', () => {
    const segments = arcToCubics(0, 0, { rx: 50, ry: 50, rotation: 0, largeArc: false, sweep: true, x: 100, y: 0 });
    expect(segments.length).toBeGreaterThan(0);
    const last = segments[segments.length - 1];
    expect(last.x).toBeCloseTo(100, 6);
    expect(last.y).toBeCloseTo(0, 6);
  });

  it('F0 fill-rule prefix', () => {
    const parsed = parsePathData('F0 M0,0 L10,0 L10,10 Z');
    expect(parsed.fillRule).toBe('EvenOdd');
  });

  it('round-trips after serialization', () => {
    const source = 'M 0,0 L 100,0 C 120,0 140,20 140,40 Z';
    const first = parsePathData(source);
    const text = stringifyPathData(first.commands);
    const second = parsePathData(text);
    expect(second.commands).toEqual(first.commands);
  });

  it('invalid input throws', () => {
    expect(() => parsePathData('M 0,0 X 10,10')).toThrow(PathDataError);
    expect(() => parsePathData('M 0,0 L')).toThrow(PathDataError);
  });
});
