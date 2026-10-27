/**
 * WPF Path Mini-Language parsing and Canvas2D drawing.
 *
 * Supports M/L/H/V/C/S/Q/T/A/Z (upper/lower case, relative/absolute), implicit repeated commands
 * and the F0/F1 fill-rule prefix.
 * Why parse it ourselves: the preview side (browser) has no WPF StreamGeometry, so it must ship
 * the same semantics — and the same parser also serves import validation and bounding-box math.
 */

import { t } from '../i18n';

export class PathDataError extends Error {
  public readonly position: number;

  constructor(message: string, position = 0) {
    super(message);
    this.name = 'PathDataError';
    this.position = position;
  }
}

export type PathCommand =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'A'; rx: number; ry: number; rotation: number; largeArc: boolean; sweep: boolean; x: number; y: number }
  | { type: 'Z' };

export interface ParsedPath {
  commands: PathCommand[];
  fillRule: 'EvenOdd' | 'Nonzero';
}

const COMMAND_LETTERS = 'MmLlHhVvCcSsQqTtAaZz';

class Scanner {
  index = 0;

  constructor(private readonly text: string) {}

  get position(): number {
    return this.index;
  }

  skipSeparators(): void {
    while (this.index < this.text.length) {
      const ch = this.text[this.index];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === ',') {
        this.index += 1;
      } else {
        break;
      }
    }
  }

  peek(): string {
    return this.text[this.index] ?? '';
  }

  atEnd(): boolean {
    this.skipSeparators();
    return this.index >= this.text.length;
  }

  readNumber(): number {
    this.skipSeparators();
    const start = this.index;
    const ch = this.text[this.index];
    if (ch === '+' || ch === '-') this.index += 1;
    let digits = 0;
    while (this.index < this.text.length && this.text[this.index] >= '0' && this.text[this.index] <= '9') {
      this.index += 1;
      digits += 1;
    }
    if (this.text[this.index] === '.') {
      this.index += 1;
      while (this.index < this.text.length && this.text[this.index] >= '0' && this.text[this.index] <= '9') {
        this.index += 1;
        digits += 1;
      }
    }
    if (digits === 0) {
      throw new PathDataError(t('engine.path.err.expectedNumber'), start);
    }
    if (this.text[this.index] === 'e' || this.text[this.index] === 'E') {
      const mark = this.index;
      this.index += 1;
      if (this.text[this.index] === '+' || this.text[this.index] === '-') this.index += 1;
      let expDigits = 0;
      while (this.index < this.text.length && this.text[this.index] >= '0' && this.text[this.index] <= '9') {
        this.index += 1;
        expDigits += 1;
      }
      if (expDigits === 0) this.index = mark;
    }
    const raw = this.text.slice(start, this.index);
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new PathDataError(t('engine.path.err.invalidNumber', { text: raw }), start);
    }
    return value;
  }

  readFlag(): boolean {
    this.skipSeparators();
    const ch = this.text[this.index];
    if (ch === '0' || ch === '1') {
      this.index += 1;
      return ch === '1';
    }
    throw new PathDataError(t('engine.path.err.expectedFlag'), this.index);
  }
}

export function parsePathData(data: string): ParsedPath {
  const commands: PathCommand[] = [];
  let fillRule: 'EvenOdd' | 'Nonzero' = 'Nonzero';

  let text = (data ?? '').trim();
  if (!text) return { commands, fillRule };

  // WPF fill-rule prefix: F0 = EvenOdd, F1 = Nonzero
  const fillMatch = /^[Ff]([01])\s*/.exec(text);
  if (fillMatch) {
    fillRule = fillMatch[1] === '0' ? 'EvenOdd' : 'Nonzero';
    text = text.slice(fillMatch[0].length);
  }

  const scanner = new Scanner(text);
  let currentX = 0;
  let currentY = 0;
  let startX = 0;
  let startY = 0;
  let lastControlX = 0;
  let lastControlY = 0;
  let lastCommand = '';
  let previousWasCubic = false;
  let previousWasQuad = false;

  const push = (command: PathCommand): void => {
    commands.push(command);
  };

  while (!scanner.atEnd()) {
    const ch = scanner.peek();
    if (COMMAND_LETTERS.indexOf(ch) < 0) {
      throw new PathDataError(t('engine.path.err.unknownCommand', { command: ch }), scanner.position);
    }
    scanner.index += 1;
    const command = ch;
    const upper = command.toUpperCase();
    const relative = command !== upper;

    switch (upper) {
      case 'M': {
        let first = true;
        do {
          const x = scanner.readNumber();
          const y = scanner.readNumber();
          currentX = relative ? currentX + x : x;
          currentY = relative ? currentY + y : y;
          if (first) {
            push({ type: 'M', x: currentX, y: currentY });
            startX = currentX;
            startY = currentY;
            first = false;
          } else {
            push({ type: 'L', x: currentX, y: currentY });
          }
        } while (!scanner.atEnd() && !isCommandLetter(scanner.peek()));
        previousWasCubic = false;
        previousWasQuad = false;
        break;
      }
      case 'L': {
        do {
          const x = scanner.readNumber();
          const y = scanner.readNumber();
          currentX = relative ? currentX + x : x;
          currentY = relative ? currentY + y : y;
          push({ type: 'L', x: currentX, y: currentY });
        } while (!scanner.atEnd() && !isCommandLetter(scanner.peek()));
        previousWasCubic = false;
        previousWasQuad = false;
        break;
      }
      case 'H': {
        do {
          const x = scanner.readNumber();
          currentX = relative ? currentX + x : x;
          push({ type: 'L', x: currentX, y: currentY });
        } while (!scanner.atEnd() && !isCommandLetter(scanner.peek()));
        previousWasCubic = false;
        previousWasQuad = false;
        break;
      }
      case 'V': {
        do {
          const y = scanner.readNumber();
          currentY = relative ? currentY + y : y;
          push({ type: 'L', x: currentX, y: currentY });
        } while (!scanner.atEnd() && !isCommandLetter(scanner.peek()));
        previousWasCubic = false;
        previousWasQuad = false;
        break;
      }
      case 'C': {
        do {
          const x1 = scanner.readNumber();
          const y1 = scanner.readNumber();
          const x2 = scanner.readNumber();
          const y2 = scanner.readNumber();
          const x = scanner.readNumber();
          const y = scanner.readNumber();
          const ax1 = relative ? currentX + x1 : x1;
          const ay1 = relative ? currentY + y1 : y1;
          const ax2 = relative ? currentX + x2 : x2;
          const ay2 = relative ? currentY + y2 : y2;
          const ax = relative ? currentX + x : x;
          const ay = relative ? currentY + y : y;
          push({ type: 'C', x1: ax1, y1: ay1, x2: ax2, y2: ay2, x: ax, y: ay });
          lastControlX = ax2;
          lastControlY = ay2;
          currentX = ax;
          currentY = ay;
        } while (!scanner.atEnd() && !isCommandLetter(scanner.peek()));
        previousWasCubic = true;
        previousWasQuad = false;
        break;
      }
      case 'S': {
        do {
          const x2 = scanner.readNumber();
          const y2 = scanner.readNumber();
          const x = scanner.readNumber();
          const y = scanner.readNumber();
          const ax2 = relative ? currentX + x2 : x2;
          const ay2 = relative ? currentY + y2 : y2;
          const ax = relative ? currentX + x : x;
          const ay = relative ? currentY + y : y;
          const x1 = previousWasCubic ? 2 * currentX - lastControlX : currentX;
          const y1 = previousWasCubic ? 2 * currentY - lastControlY : currentY;
          push({ type: 'C', x1, y1, x2: ax2, y2: ay2, x: ax, y: ay });
          lastControlX = ax2;
          lastControlY = ay2;
          currentX = ax;
          currentY = ay;
        } while (!scanner.atEnd() && !isCommandLetter(scanner.peek()));
        previousWasCubic = true;
        previousWasQuad = false;
        break;
      }
      case 'Q': {
        do {
          const x1 = scanner.readNumber();
          const y1 = scanner.readNumber();
          const x = scanner.readNumber();
          const y = scanner.readNumber();
          const ax1 = relative ? currentX + x1 : x1;
          const ay1 = relative ? currentY + y1 : y1;
          const ax = relative ? currentX + x : x;
          const ay = relative ? currentY + y : y;
          push({ type: 'Q', x1: ax1, y1: ay1, x: ax, y: ay });
          lastControlX = ax1;
          lastControlY = ay1;
          currentX = ax;
          currentY = ay;
        } while (!scanner.atEnd() && !isCommandLetter(scanner.peek()));
        previousWasQuad = true;
        previousWasCubic = false;
        break;
      }
      case 'T': {
        do {
          const x = scanner.readNumber();
          const y = scanner.readNumber();
          const ax = relative ? currentX + x : x;
          const ay = relative ? currentY + y : y;
          const x1 = previousWasQuad ? 2 * currentX - lastControlX : currentX;
          const y1 = previousWasQuad ? 2 * currentY - lastControlY : currentY;
          push({ type: 'Q', x1, y1, x: ax, y: ay });
          lastControlX = x1;
          lastControlY = y1;
          currentX = ax;
          currentY = ay;
        } while (!scanner.atEnd() && !isCommandLetter(scanner.peek()));
        previousWasQuad = true;
        previousWasCubic = false;
        break;
      }
      case 'A': {
        do {
          const rx = scanner.readNumber();
          const ry = scanner.readNumber();
          const rotation = scanner.readNumber();
          const largeArc = scanner.readFlag();
          const sweep = scanner.readFlag();
          const x = scanner.readNumber();
          const y = scanner.readNumber();
          const ax = relative ? currentX + x : x;
          const ay = relative ? currentY + y : y;
          push({ type: 'A', rx: Math.abs(rx), ry: Math.abs(ry), rotation, largeArc, sweep, x: ax, y: ay });
          currentX = ax;
          currentY = ay;
        } while (!scanner.atEnd() && !isCommandLetter(scanner.peek()));
        previousWasCubic = false;
        previousWasQuad = false;
        break;
      }
      case 'Z': {
        push({ type: 'Z' });
        currentX = startX;
        currentY = startY;
        previousWasCubic = false;
        previousWasQuad = false;
        break;
      }
      default:
        throw new PathDataError(t('engine.path.err.unsupportedCommand', { command }), scanner.position);
    }
    lastCommand = command;
  }

  if (!commands.length) return { commands, fillRule };

  if (!lastCommand) throw new PathDataError(t('engine.path.err.empty'), 0);
  return { commands, fillRule };
}

function isCommandLetter(ch: string): boolean {
  return COMMAND_LETTERS.indexOf(ch) >= 0;
}

/* ------------------------------------------------------------------ *
 * Bounding box
 * ------------------------------------------------------------------ */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function pathBounds(commands: readonly PathCommand[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const include = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  let cx = 0;
  let cy = 0;

  for (const command of commands) {
    switch (command.type) {
      case 'M':
      case 'L':
        include(command.x, command.y);
        cx = command.x;
        cy = command.y;
        break;
      case 'C': {
        // Cubic Bézier extrema
        for (const t of cubicExtrema(cx, command.x1, command.x2, command.x)) {
          include(cubicAt(cx, command.x1, command.x2, command.x, t), cubicAt(cy, command.y1, command.y2, command.y, t));
        }
        include(command.x, command.y);
        cx = command.x;
        cy = command.y;
        break;
      }
      case 'Q': {
        for (const t of quadExtrema(cx, command.x1, command.x)) {
          include(quadAt(cx, command.x1, command.x, t), quadAt(cy, command.y1, command.y, t));
        }
        include(command.x, command.y);
        cx = command.x;
        cy = command.y;
        break;
      }
      case 'A': {
        for (const segment of arcToCubics(cx, cy, command)) {
          include(segment.x, segment.y);
        }
        include(command.x, command.y);
        cx = command.x;
        cy = command.y;
        break;
      }
      case 'Z':
        break;
    }
  }

  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -3 * p0 + 9 * p1 - 9 * p2 + 3 * p3;
  const b = 6 * p0 - 12 * p1 + 6 * p2;
  const c = -3 * p0 + 3 * p1;
  const out: number[] = [];
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) > 1e-9) {
      const t = -c / b;
      if (t > 0 && t < 1) out.push(t);
    }
    return out;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return out;
  const sq = Math.sqrt(disc);
  for (const t of [(-b + sq) / (2 * a), (-b - sq) / (2 * a)]) {
    if (t > 0 && t < 1) out.push(t);
  }
  return out;
}

function quadAt(p0: number, p1: number, p2: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2;
}

function quadExtrema(p0: number, p1: number, p2: number): number[] {
  const denom = p0 - 2 * p1 + p2;
  if (Math.abs(denom) < 1e-9) return [];
  const t = (p0 - p1) / denom;
  return t > 0 && t < 1 ? [t] : [];
}

/* ------------------------------------------------------------------ *
 * Arc → cubic Bézier
 * ------------------------------------------------------------------ */

interface CubicSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x: number;
  y: number;
}

export function arcToCubics(
  x0: number,
  y0: number,
  arc: { rx: number; ry: number; rotation: number; largeArc: boolean; sweep: boolean; x: number; y: number },
): CubicSegment[] {
  const { rx, ry, rotation, largeArc, sweep, x, y } = arc;
  if (rx === 0 || ry === 0) {
    return [{ x1: x0, y1: y0, x2: x, y2: y, x, y }];
  }
  if (Math.abs(x0 - x) < 1e-9 && Math.abs(y0 - y) < 1e-9) {
    return [];
  }

  const phi = (rotation * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx2 = (x0 - x) / 2;
  const dy2 = (y0 - y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  let rxs = rx * rx;
  let rys = ry * ry;
  const lambda = (x1p * x1p) / rxs + (y1p * y1p) / rys;
  let scaledRx = rx;
  let scaledRy = ry;
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    scaledRx = rx * scale;
    scaledRy = ry * scale;
    rxs = scaledRx * scaledRx;
    rys = scaledRy * scaledRy;
  }

  const sign = largeArc === sweep ? -1 : 1;
  const numerator = Math.max(0, rxs * rys - rxs * y1p * y1p - rys * x1p * x1p);
  const denominator = rxs * y1p * y1p + rys * x1p * x1p;
  const coef = denominator === 0 ? 0 : sign * Math.sqrt(numerator / denominator);
  const cxp = (coef * scaledRx * y1p) / scaledRy;
  const cyp = (-coef * scaledRy * x1p) / scaledRx;

  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2;

  const angleOf = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    if (len === 0) return 0;
    let ang = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) ang = -ang;
    return ang;
  };

  const ux = (x1p - cxp) / scaledRx;
  const uy = (y1p - cyp) / scaledRy;
  const vx = (-x1p - cxp) / scaledRx;
  const vy = (-y1p - cyp) / scaledRy;

  let theta1 = angleOf(1, 0, ux, uy);
  let deltaTheta = angleOf(ux, uy, vx, vy);
  if (!sweep && deltaTheta > 0) deltaTheta -= 2 * Math.PI;
  if (sweep && deltaTheta < 0) deltaTheta += 2 * Math.PI;

  const segments = Math.max(1, Math.ceil(Math.abs(deltaTheta) / (Math.PI / 2)));
  const delta = deltaTheta / segments;
  const t = (4 / 3) * Math.tan(delta / 4);

  const out: CubicSegment[] = [];
  let cosT1 = Math.cos(theta1);
  let sinT1 = Math.sin(theta1);
  let currentX = x0;
  let currentY = y0;

  for (let i = 0; i < segments; i += 1) {
    const theta2 = theta1 + delta;
    const cosT2 = Math.cos(theta2);
    const sinT2 = Math.sin(theta2);

    const e1x = cosPhi * scaledRx * cosT1 - sinPhi * scaledRy * sinT1 + cx;
    const e1y = sinPhi * scaledRx * cosT1 + cosPhi * scaledRy * sinT1 + cy;
    const e2x = cosPhi * scaledRx * cosT2 - sinPhi * scaledRy * sinT2 + cx;
    const e2y = sinPhi * scaledRx * cosT2 + cosPhi * scaledRy * sinT2 + cy;

    const d1x = -scaledRx * sinT1 * cosPhi - scaledRy * cosT1 * sinPhi;
    const d1y = -scaledRx * sinT1 * sinPhi + scaledRy * cosT1 * cosPhi;
    const d2x = -scaledRx * sinT2 * cosPhi - scaledRy * cosT2 * sinPhi;
    const d2y = -scaledRx * sinT2 * sinPhi + scaledRy * cosT2 * cosPhi;

    const isLast = i === segments - 1;
    const endX = isLast ? x : e2x;
    const endY = isLast ? y : e2y;

    out.push({
      x1: currentX + t * d1x,
      y1: currentY + t * d1y,
      x2: e2x - t * d2x,
      y2: e2y - t * d2y,
      x: endX,
      y: endY,
    });

    theta1 = theta2;
    cosT1 = cosT2;
    sinT1 = sinT2;
    currentX = endX;
    currentY = endY;
    void e1x;
    void e1y;
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Canvas2D drawing
 * ------------------------------------------------------------------ */

export interface PathDrawTarget {
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void;
  quadraticCurveTo(x1: number, y1: number, x: number, y: number): void;
  closePath(): void;
}

/** Append the path commands to a 2D context (the caller handles beginPath / fill / stroke) */
export function tracePath(ctx: PathDrawTarget, commands: readonly PathCommand[]): void {
  let cx = 0;
  let cy = 0;
  for (const command of commands) {
    switch (command.type) {
      case 'M':
        ctx.moveTo(command.x, command.y);
        cx = command.x;
        cy = command.y;
        break;
      case 'L':
        ctx.lineTo(command.x, command.y);
        cx = command.x;
        cy = command.y;
        break;
      case 'C':
        ctx.bezierCurveTo(command.x1, command.y1, command.x2, command.y2, command.x, command.y);
        cx = command.x;
        cy = command.y;
        break;
      case 'Q':
        ctx.quadraticCurveTo(command.x1, command.y1, command.x, command.y);
        cx = command.x;
        cy = command.y;
        break;
      case 'A':
        for (const segment of arcToCubics(cx, cy, command)) {
          ctx.bezierCurveTo(segment.x1, segment.y1, segment.x2, segment.y2, segment.x, segment.y);
        }
        cx = command.x;
        cy = command.y;
        break;
      case 'Z':
        ctx.closePath();
        break;
    }
  }
}

/** Convert the path commands into polylines of only M/L points (for WPF Shape mode or rough collision) */
export function flattenPath(commands: readonly PathCommand[], tolerance = 0.5): Array<Array<{ x: number; y: number }>> {
  const subpaths: Array<Array<{ x: number; y: number }>> = [];
  let current: Array<{ x: number; y: number }> | null = null;
  let cx = 0;
  let cy = 0;

  const pushPoint = (x: number, y: number): void => {
    if (!current) {
      current = [{ x, y }];
      subpaths.push(current);
    } else {
      current.push({ x, y });
    }
  };

  for (const command of commands) {
    switch (command.type) {
      case 'M':
        current = [{ x: command.x, y: command.y }];
        subpaths.push(current);
        cx = command.x;
        cy = command.y;
        break;
      case 'L':
        pushPoint(command.x, command.y);
        cx = command.x;
        cy = command.y;
        break;
      case 'C': {
        const steps = estimateSteps(tolerance, Math.hypot(command.x - cx, command.y - cy) + Math.hypot(command.x1 - cx, command.y1 - cy) + Math.hypot(command.x2 - command.x1, command.y2 - command.y1));
        for (let i = 1; i <= steps; i += 1) {
          const t = i / steps;
          pushPoint(cubicAt(cx, command.x1, command.x2, command.x, t), cubicAt(cy, command.y1, command.y2, command.y, t));
        }
        cx = command.x;
        cy = command.y;
        break;
      }
      case 'Q': {
        const steps = estimateSteps(tolerance, Math.hypot(command.x - cx, command.y - cy) + Math.hypot(command.x1 - cx, command.y1 - cy));
        for (let i = 1; i <= steps; i += 1) {
          const t = i / steps;
          pushPoint(quadAt(cx, command.x1, command.x, t), quadAt(cy, command.y1, command.y, t));
        }
        cx = command.x;
        cy = command.y;
        break;
      }
      case 'A':
        for (const segment of arcToCubics(cx, cy, command)) {
          const steps = 6;
          for (let i = 1; i <= steps; i += 1) {
            const t = i / steps;
            pushPoint(
              cubicAt(cx, segment.x1, segment.x2, segment.x, t),
              cubicAt(cy, segment.y1, segment.y2, segment.y, t),
            );
          }
          cx = segment.x;
          cy = segment.y;
        }
        cx = command.x;
        cy = command.y;
        break;
      case 'Z':
        if (current && current.length) {
          const first = current[0];
          current.push({ x: first.x, y: first.y });
          cx = first.x;
          cy = first.y;
        }
        break;
    }
  }

  return subpaths;
}

function estimateSteps(tolerance: number, length: number): number {
  const safeTolerance = Math.max(0.05, tolerance);
  return Math.max(2, Math.min(64, Math.ceil(length / (safeTolerance * 8))));
}

/** Serialize into the WPF mini-language (normalizes the format after SVG import) */
export function stringifyPathData(commands: readonly PathCommand[], fillRule: 'EvenOdd' | 'Nonzero' = 'Nonzero'): string {
  const parts: string[] = [];
  if (fillRule === 'EvenOdd') parts.push('F0');
  const fmt = (value: number): string => {
    const rounded = Math.round(value * 1000) / 1000;
    return String(rounded);
  };
  for (const command of commands) {
    switch (command.type) {
      case 'M':
        parts.push(`M ${fmt(command.x)},${fmt(command.y)}`);
        break;
      case 'L':
        parts.push(`L ${fmt(command.x)},${fmt(command.y)}`);
        break;
      case 'C':
        parts.push(`C ${fmt(command.x1)},${fmt(command.y1)} ${fmt(command.x2)},${fmt(command.y2)} ${fmt(command.x)},${fmt(command.y)}`);
        break;
      case 'Q':
        parts.push(`Q ${fmt(command.x1)},${fmt(command.y1)} ${fmt(command.x)},${fmt(command.y)}`);
        break;
      case 'A':
        parts.push(`A ${fmt(command.rx)},${fmt(command.ry)} ${fmt(command.rotation)} ${command.largeArc ? 1 : 0} ${command.sweep ? 1 : 0} ${fmt(command.x)},${fmt(command.y)}`);
        break;
      case 'Z':
        parts.push('Z');
        break;
    }
  }
  return parts.join(' ');
}
