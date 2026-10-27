/**
 * Shape geometry helpers (bounding boxes, translation, mirroring, alignment pivots).
 */

import type { Shape, VectAnimDocument } from '../schema/types';
import { resolveNumber, type VariableResolver } from '../schema/valueRef';
import { geometryBounds, resolveShape } from '../engine/resolve';
import { pathBounds, parsePathData, stringifyPathData } from '../engine/pathData';
import type { PathCommand } from '../engine/pathData';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const identityResolver: VariableResolver = () => undefined;

/** Shape bounding box (rotation aware, the axis-aligned box around the four corners) */
export function shapeBounds(shape: Shape, resolver: VariableResolver = identityResolver): Bounds {
  const resolved = resolveShape(shape, resolver);
  let local: Bounds;
  if (resolved.geometry.kind === 'path') {
    try {
      local = pathBounds(parsePathData(resolved.geometry.data).commands);
    } catch {
      local = { x: 0, y: 0, width: 0, height: 0 };
    }
    local = { ...local, x: local.x + resolved.geometry.offsetX, y: local.y + resolved.geometry.offsetY };
  } else {
    local = geometryBounds(resolved.geometry);
  }

  const { angle, cx, cy } = resolved.transform;
  if (!angle) return local;

  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners = [
    { x: local.x, y: local.y },
    { x: local.x + local.width, y: local.y },
    { x: local.x + local.width, y: local.y + local.height },
    { x: local.x, y: local.y + local.height },
  ].map((point) => ({
    x: cx + (point.x - cx) * cos - (point.y - cy) * sin,
    y: cy + (point.x - cx) * sin + (point.y - cy) * cos,
  }));

  const minX = Math.min(...corners.map((p) => p.x));
  const minY = Math.min(...corners.map((p) => p.y));
  const maxX = Math.max(...corners.map((p) => p.x));
  const maxY = Math.max(...corners.map((p) => p.y));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function documentBounds(document: VectAnimDocument, resolver: VariableResolver = identityResolver): Bounds {
  const shapes = document.Shapes.filter((shape) => shape.IsVisible !== false);
  if (!shapes.length) return { x: 0, y: 0, width: document.Canvas.Width, height: document.Canvas.Height };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const shape of shapes) {
    const bounds = shapeBounds(shape, resolver);
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Translate a shape (bound properties are left untouched) */
export function translateShape(shape: Shape, dx: number, dy: number): void {
  const moveRef = (ref: { Const: unknown } | { Bind: string } | undefined, delta: number): void => {
    if (!ref || !('Const' in ref)) return;
    if (typeof ref.Const === 'number') ref.Const = round3(ref.Const + delta);
  };

  switch (shape.Type) {
    case 'Line':
      moveRef(shape.X1, dx);
      moveRef(shape.Y1, dy);
      moveRef(shape.X2, dx);
      moveRef(shape.Y2, dy);
      break;
    case 'Rectangle':
      moveRef(shape.X, dx);
      moveRef(shape.Y, dy);
      break;
    case 'Ellipse':
      moveRef(shape.CenterX, dx);
      moveRef(shape.CenterY, dy);
      break;
    case 'Polygon':
      for (const point of shape.Points) {
        moveRef(point.X, dx);
        moveRef(point.Y, dy);
      }
      break;
    case 'Path':
      shape.OffsetX = round3((shape.OffsetX ?? 0) + dx);
      shape.OffsetY = round3((shape.OffsetY ?? 0) + dy);
      break;
    default:
      break;
  }

  if (shape.RenderTransform?.Rotate) {
    moveRef(shape.RenderTransform.Rotate.CenterX, dx);
    moveRef(shape.RenderTransform.Rotate.CenterY, dy);
  }
  if (shape.RenderTransform?.Scale) {
    moveRef(shape.RenderTransform.Scale.CenterX, dx);
    moveRef(shape.RenderTransform.Scale.CenterY, dy);
  }
}

/** Mirror a shape about a point on the given axis */
export function flipShape(shape: Shape, axis: 'x' | 'y', pivot: number, resolver: VariableResolver = identityResolver): void {
  const mirror = (value: number): number => round3(2 * pivot - value);

  switch (shape.Type) {
    case 'Line': {
      if (axis === 'x') {
        const x1 = mirror(resolveNumber(shape.X1, resolver, 0));
        const x2 = mirror(resolveNumber(shape.X2, resolver, 0));
        if ('Const' in shape.X1) shape.X1 = { Const: x1 };
        if ('Const' in shape.X2) shape.X2 = { Const: x2 };
      } else {
        const y1 = mirror(resolveNumber(shape.Y1, resolver, 0));
        const y2 = mirror(resolveNumber(shape.Y2, resolver, 0));
        if ('Const' in shape.Y1) shape.Y1 = { Const: y1 };
        if ('Const' in shape.Y2) shape.Y2 = { Const: y2 };
      }
      break;
    }
    case 'Rectangle':
      if (axis === 'x' && 'Const' in shape.X) {
        shape.X = { Const: round3(mirror(resolveNumber(shape.X, resolver, 0) + resolveNumber(shape.Width, resolver, 0)) - resolveNumber(shape.Width, resolver, 0)) };
      }
      if (axis === 'y' && 'Const' in shape.Y) {
        shape.Y = { Const: round3(mirror(resolveNumber(shape.Y, resolver, 0) + resolveNumber(shape.Height, resolver, 0)) - resolveNumber(shape.Height, resolver, 0)) };
      }
      break;
    case 'Ellipse':
      if (axis === 'x' && 'Const' in shape.CenterX) shape.CenterX = { Const: mirror(resolveNumber(shape.CenterX, resolver, 0)) };
      if (axis === 'y' && 'Const' in shape.CenterY) shape.CenterY = { Const: mirror(resolveNumber(shape.CenterY, resolver, 0)) };
      break;
    case 'Polygon':
      for (const point of shape.Points) {
        if (axis === 'x' && 'Const' in point.X) point.X = { Const: mirror(resolveNumber(point.X, resolver, 0)) };
        if (axis === 'y' && 'Const' in point.Y) point.Y = { Const: mirror(resolveNumber(point.Y, resolver, 0)) };
      }
      break;
    case 'Path': {
      try {
        const commands = parsePathData(shape.Data).commands;
        const mirrored = mirrorPath(commands, axis, pivot);
        shape.Data = stringifyPathData(mirrored);
      } catch {
        /* ignore paths that cannot be parsed */
      }
      break;
    }
    default:
      break;
  }
}

function mirrorPath(commands: readonly PathCommand[], axis: 'x' | 'y', pivot: number): PathCommand[] {
  const mx = (value: number): number => (axis === 'x' ? 2 * pivot - value : value);
  const my = (value: number): number => (axis === 'y' ? 2 * pivot - value : value);
  return commands.map((command) => {
    switch (command.type) {
      case 'M':
      case 'L':
        return { ...command, x: mx(command.x), y: my(command.y) };
      case 'C':
        return { ...command, x1: mx(command.x1), y1: my(command.y1), x2: mx(command.x2), y2: my(command.y2), x: mx(command.x), y: my(command.y) };
      case 'Q':
        return { ...command, x1: mx(command.x1), y1: my(command.y1), x: mx(command.x), y: my(command.y) };
      case 'A':
        return { ...command, x: mx(command.x), y: my(command.y) };
      case 'Z':
        return command;
      default:
        return command;
    }
  });
}

/** Scale shape geometry (used when the whole canvas is resized) */
export function scaleShape(shape: Shape, sx: number, sy: number): void {
  const scaleRef = (ref: { Const: unknown } | { Bind: string } | undefined, factor: number): void => {
    if (!ref || !('Const' in ref)) return;
    if (typeof ref.Const === 'number') ref.Const = round3(ref.Const * factor);
  };

  switch (shape.Type) {
    case 'Line':
      scaleRef(shape.X1, sx);
      scaleRef(shape.Y1, sy);
      scaleRef(shape.X2, sx);
      scaleRef(shape.Y2, sy);
      break;
    case 'Rectangle':
      scaleRef(shape.X, sx);
      scaleRef(shape.Y, sy);
      scaleRef(shape.Width, sx);
      scaleRef(shape.Height, sy);
      break;
    case 'Ellipse':
      scaleRef(shape.CenterX, sx);
      scaleRef(shape.CenterY, sy);
      scaleRef(shape.RadiusX, sx);
      scaleRef(shape.RadiusY, sy);
      break;
    case 'Polygon':
      for (const point of shape.Points) {
        scaleRef(point.X, sx);
        scaleRef(point.Y, sy);
      }
      break;
    case 'Path':
      shape.OffsetX = round3((shape.OffsetX ?? 0) * sx);
      shape.OffsetY = round3((shape.OffsetY ?? 0) * sy);
      break;
    default:
      break;
  }

  if (shape.RenderTransform?.Rotate) {
    scaleRef(shape.RenderTransform.Rotate.CenterX, sx);
    scaleRef(shape.RenderTransform.Rotate.CenterY, sy);
  }
  if (shape.RenderTransform?.Scale) {
    scaleRef(shape.RenderTransform.Scale.CenterX, sx);
    scaleRef(shape.RenderTransform.Scale.CenterY, sy);
  }
}
