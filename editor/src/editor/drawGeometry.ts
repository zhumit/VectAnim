/**
 * Pure geometry for the drag-based drawing tools.
 *
 * Kept in its own module because the constraint (Shift) and the semicircle arc
 * command are needed both by the preview and by the commit: only a single
 * implementation can guarantee "what you preview is what gets written". It also
 * has no Fabric dependency, which keeps it unit-testable.
 */

import { stringifyPathData, type PathCommand } from '../engine/pathData';

export interface DrawPoint {
  x: number;
  y: number;
}

/** Drag-based tools defined by a "mouse-down → mouse-up" point pair */
export type DragDrawKind = 'line' | 'rect' | 'ellipse' | 'arc';

export function isDragDrawKind(kind: string): kind is DragDrawKind {
  return kind === 'line' || kind === 'rect' || kind === 'ellipse' || kind === 'arc';
}

/** Diameter-direction step for a semicircle arc while Shift is held (45°) */
const ARC_ANGLE_STEP = Math.PI / 4;

/**
 * Shift constraint.
 *  - Rectangle / ellipse: use the longer side for both edges, yielding a square /
 *    circle (the direction follows the quadrant the cursor is in).
 *  - Semicircle arc: snap the diameter direction to a multiple of 45°, keeping the length.
 *  - Line: no constraint.
 */
export function constrainDragPoint(kind: DragDrawKind, start: DrawPoint, point: DrawPoint, shift: boolean): DrawPoint {
  if (!shift) return { x: point.x, y: point.y };

  const dx = point.x - start.x;
  const dy = point.y - start.y;

  if (kind === 'rect' || kind === 'ellipse') {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    return {
      x: start.x + (dx < 0 ? -size : size),
      y: start.y + (dy < 0 ? -size : size),
    };
  }

  if (kind === 'arc') {
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return { x: point.x, y: point.y };
    const angle = Math.round(Math.atan2(dy, dx) / ARC_ANGLE_STEP) * ARC_ANGLE_STEP;
    return { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
  }

  return { x: point.x, y: point.y };
}

/** Rectangle bounding box (unrounded; rounding is centralized in the factory) */
export function rectFromDrag(start: DrawPoint, end: DrawPoint): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

/** Ellipse bounding box → center + radii */
export function ellipseFromDrag(start: DrawPoint, end: DrawPoint): { cx: number; cy: number; rx: number; ry: number } {
  return {
    cx: (start.x + end.x) / 2,
    cy: (start.y + end.y) / 2,
    rx: Math.abs(end.x - start.x) / 2,
    ry: Math.abs(end.y - start.y) / 2,
  };
}

/**
 * Semicircle arc command: the "mouse-down → mouse-up" segment is the diameter,
 * radius = half the chord length, the arc always bulges to the right-hand side
 * of the travel direction (sweep = true).
 * Pass sweep = false to bulge to the other side.
 */
export function semicircleArcCommands(start: DrawPoint, end: DrawPoint, sweep = true): PathCommand[] {
  const radius = Math.hypot(end.x - start.x, end.y - start.y) / 2;
  if (!(radius > 0)) return [];
  return [
    { type: 'M', x: start.x, y: start.y },
    { type: 'A', rx: radius, ry: radius, rotation: 0, largeArc: false, sweep, x: end.x, y: end.y },
  ];
}

/** Semicircle arc → WPF / SVG-compatible path string (world coordinates) */
export function semicircleArcData(start: DrawPoint, end: DrawPoint, sweep = true): string {
  const commands = semicircleArcCommands(start, end, sweep);
  return commands.length ? stringifyPathData(commands) : '';
}
