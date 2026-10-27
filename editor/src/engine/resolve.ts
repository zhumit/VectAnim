/**
 * Resolve the document + variable values into a "directly drawable numeric model".
 * The fields map one-to-one onto the WPF-side ResolvedShape, so both renderers agree.
 */

import type { Shape, VectAnimDocument, ValueRef } from '../schema/types';
import { isBindRef, isConstRef, resolveNumber, type VariableResolver } from '../schema/valueRef';
import { parseDocColor, rgbaToCss } from './color';
import {
  isIdentityGroupTransform,
  resolveGroupTransform,
  type ResolvedGroupTransform,
} from './groupTransform';

/**
 * Resolve a color property: constant string / numeric color (0xRRGGBB) / numeric variable binding.
 * The result is a CSS color, ready for Canvas2D and SVG.
 */
export function resolveColorRef(ref: ValueRef | null | undefined, resolver: VariableResolver): string | null {
  if (!ref) return null;
  if (isConstRef(ref)) {
    const rgba = parseDocColor(typeof ref.Const === 'number' ? ref.Const : String(ref.Const));
    return rgba && rgba.a > 0 ? rgbaToCss(rgba) : null;
  }
  if (isBindRef(ref)) {
    const value = resolver(ref.Bind);
    if (value === undefined) return null;
    const rgba = parseDocColor(typeof value === 'number' ? value : String(value));
    return rgba && rgba.a > 0 ? rgbaToCss(rgba) : null;
  }
  return null;
}

export interface ResolvedTransform {
  /** Degrees, clockwise */
  angle: number;
  cx: number;
  cy: number;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

export type ResolvedGeometry =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'rect'; x: number; y: number; width: number; height: number; rx: number; ry: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'polygon'; points: Array<{ x: number; y: number }>; closed: boolean }
  | { kind: 'path'; data: string; offsetX: number; offsetY: number };

export interface ResolvedShape {
  id: string;
  name: string;
  type: Shape['Type'];
  visible: boolean;
  zIndex: number;
  opacity: number;
  fill: string | null;
  stroke: string | null;
  strokeThickness: number;
  lineCap: 'Flat' | 'Round' | 'Square';
  lineJoin: 'Miter' | 'Bevel' | 'Round';
  transform: ResolvedTransform;
  geometry: ResolvedGeometry;
  groupId?: string;
  /** Group transform to apply before this shape's own transform (absent when the group is identity) */
  groupTransform?: ResolvedGroupTransform;
  /** Original document object, for looking the shape back up after a hit test */
  source: Shape;
}

export interface ResolveOptions {
  /** Ignore group visibility (the editor canvas needs to show the shape on its own) */
  ignoreGroupVisibility?: boolean;
}

export function resolveShape(shape: Shape, resolver: VariableResolver): ResolvedShape {
  const base = {
    id: shape.Id,
    name: shape.Name,
    type: shape.Type,
    zIndex: Number.isFinite(shape.ZIndex) ? shape.ZIndex : 0,
    opacity: clamp01(resolveNumber(shape.Opacity, resolver, 1)),
    fill: resolveColorRef(shape.Fill, resolver),
    stroke: resolveColorRef(shape.Stroke, resolver),
    strokeThickness: Math.max(0, resolveNumber(shape.StrokeThickness, resolver, 1)),
    lineCap: shape.LineCap ?? 'Flat',
    lineJoin: shape.LineJoin ?? 'Miter',
    transform: resolveTransform(shape, resolver),
    visible: shape.IsVisible !== false,
    source: shape,
  };

  let geometry: ResolvedGeometry;
  switch (shape.Type) {
    case 'Line':
      geometry = {
        kind: 'line',
        x1: resolveNumber(shape.X1, resolver, 0),
        y1: resolveNumber(shape.Y1, resolver, 0),
        x2: resolveNumber(shape.X2, resolver, 0),
        y2: resolveNumber(shape.Y2, resolver, 0),
      };
      break;
    case 'Rectangle':
      geometry = {
        kind: 'rect',
        x: resolveNumber(shape.X, resolver, 0),
        y: resolveNumber(shape.Y, resolver, 0),
        width: Math.max(0, resolveNumber(shape.Width, resolver, 0)),
        height: Math.max(0, resolveNumber(shape.Height, resolver, 0)),
        rx: Math.max(0, resolveNumber(shape.RadiusX, resolver, 0)),
        ry: Math.max(0, resolveNumber(shape.RadiusY, resolver, 0)),
      };
      break;
    case 'Ellipse':
      geometry = {
        kind: 'ellipse',
        cx: resolveNumber(shape.CenterX, resolver, 0),
        cy: resolveNumber(shape.CenterY, resolver, 0),
        rx: Math.max(0, resolveNumber(shape.RadiusX, resolver, 0)),
        ry: Math.max(0, resolveNumber(shape.RadiusY, resolver, 0)),
      };
      break;
    case 'Polygon':
      geometry = {
        kind: 'polygon',
        points: (shape.Points ?? []).map((point) => ({
          x: resolveNumber(point.X, resolver, 0),
          y: resolveNumber(point.Y, resolver, 0),
        })),
        closed: shape.IsClosed !== false,
      };
      break;
    case 'Path':
      geometry = {
        kind: 'path',
        data: shape.Data ?? '',
        offsetX: shape.OffsetX ?? 0,
        offsetY: shape.OffsetY ?? 0,
      };
      break;
    default:
      geometry = { kind: 'rect', x: 0, y: 0, width: 0, height: 0, rx: 0, ry: 0 };
      break;
  }

  return { ...base, geometry } as ResolvedShape;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function resolveTransform(shape: Shape, resolver: VariableResolver): ResolvedTransform {
  const rotate = shape.RenderTransform?.Rotate;
  const scale = shape.RenderTransform?.Scale;
  const translate = shape.RenderTransform?.Translate;

  const angle = rotate ? resolveNumber(rotate.Value, resolver, 0) : 0;
  const cx = rotate ? resolveNumber(rotate.CenterX, resolver, 0) : 0;
  const cy = rotate ? resolveNumber(rotate.CenterY, resolver, 0) : 0;

  const sx = scale ? resolveNumber(scale.ValueX, resolver, 1) : 1;
  const sy = scale ? resolveNumber(scale.ValueY, resolver, 1) : 1;

  const tx = translate ? resolveNumber(translate.X, resolver, 0) : 0;
  const ty = translate ? resolveNumber(translate.Y, resolver, 0) : 0;

  return { angle, cx, cy, sx, sy, tx, ty };
}

/** Resolve a whole document and return the visible shapes sorted by ZIndex */
export function resolveDocument(
  document: VectAnimDocument,
  resolver: VariableResolver,
  options: ResolveOptions = {},
): ResolvedShape[] {
  const groupById = new Map<string, { visible: boolean; opacity: number; transform: ResolvedGroupTransform }>();
  for (const group of document.Groups ?? []) {
    groupById.set(group.GroupId, {
      visible: group.Visible !== false,
      opacity: clamp01(resolveNumber(group.Opacity, resolver, 1)),
      transform: resolveGroupTransform(group, resolver),
    });
  }
  const shapeGroup = new Map<string, string>();
  for (const group of document.Groups ?? []) {
    for (const id of group.ShapeIds ?? []) shapeGroup.set(id, group.GroupId);
  }

  const resolved: ResolvedShape[] = [];
  (document.Shapes ?? []).forEach((shape, index) => {
    const item = resolveShape(shape, resolver);
    const groupId = shapeGroup.get(shape.Id);
    if (groupId) {
      item.groupId = groupId;
      const group = groupById.get(groupId);
      if (group) {
        if (!options.ignoreGroupVisibility) item.visible = item.visible && group.visible;
        item.opacity = clamp01(item.opacity * group.opacity);
        if (!isIdentityGroupTransform(group.transform)) item.groupTransform = group.transform;
      }
    }
    if (!Number.isFinite(item.zIndex)) item.zIndex = index;
    resolved.push(item);
  });

  resolved.sort((a, b) => (a.zIndex === b.zIndex ? 0 : a.zIndex - b.zIndex));
  return resolved;
}

/** Bounding box of the shape in its unrotated state */
export function geometryBounds(geometry: ResolvedGeometry): { x: number; y: number; width: number; height: number } {
  switch (geometry.kind) {
    case 'line': {
      const x = Math.min(geometry.x1, geometry.x2);
      const y = Math.min(geometry.y1, geometry.y2);
      return { x, y, width: Math.abs(geometry.x2 - geometry.x1), height: Math.abs(geometry.y2 - geometry.y1) };
    }
    case 'rect':
      return { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height };
    case 'ellipse':
      return {
        x: geometry.cx - geometry.rx,
        y: geometry.cy - geometry.ry,
        width: geometry.rx * 2,
        height: geometry.ry * 2,
      };
    case 'polygon': {
      if (!geometry.points.length) return { x: 0, y: 0, width: 0, height: 0 };
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const point of geometry.points) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    case 'path': {
      return { x: geometry.offsetX, y: geometry.offsetY, width: 0, height: 0 };
    }
    default:
      return { x: 0, y: 0, width: 0, height: 0 };
  }
}
