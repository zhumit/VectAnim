/**
 * SVG import: convert primitives in an SVG into VectAnim shapes.
 *
 * Strategy:
 *  - Rely on Fabric's SVG parser to handle transforms / viewBox / gradients etc.
 *  - Map rectangle / ellipse / polygon / polyline / path to native types
 *    (so they can still be edited with control points).
 *  - Other types (text, images, clipping paths) degrade to "skip + warn"; we
 *    never emit half-finished shapes.
 *  - All coordinates are emitted in world space, and rotation is preserved as
 *    RenderTransform.Rotate.
 */

import { t } from '../i18n';
import {
  Circle as FabricCircle,
  Ellipse as FabricEllipse,
  FabricObject,
  Group,
  Path as FabricPath,
  Polygon as FabricPolygon,
  Polyline as FabricPolyline,
  Rect as FabricRect,
  util,
  loadSVGFromString,
} from 'fabric';
import type { Shape, ValueRef } from '../schema/types';
import { createShape } from '../schema/factory';
import { normalizeColor } from '../engine/color';
import { pathBounds, stringifyPathData, type PathCommand } from '../engine/pathData';

export interface SvgImportResult {
  shapes: Shape[];
  warnings: string[];
  width: number;
  height: number;
}

type Matrix = [number, number, number, number, number, number];

function c(value: number): ValueRef {
  return { Const: Math.round(value * 1000) / 1000 };
}

function multiply(a: Matrix, b: Matrix): Matrix {
  return util.multiplyTransformMatrices(a, b) as Matrix;
}

export async function importSvg(svgText: string, options: { offsetX?: number; offsetY?: number; scale?: number } = {}): Promise<SvgImportResult> {
  const warnings: string[] = [];
  const shapes: Shape[] = [];
  const offsetX = options.offsetX ?? 0;
  const offsetY = options.offsetY ?? 0;
  const extraScale = options.scale ?? 1;

  const parsed = await loadSVGFromString(svgText);
  const size = measureSvg(svgText);
  const objects = parsed.objects.filter((object): object is FabricObject => !!object);

  const rootMatrix: Matrix = [extraScale, 0, 0, extraScale, offsetX, offsetY];

  const walk = (object: FabricObject, parent: Matrix): void => {
    if (object instanceof Group && !(object instanceof FabricPolygon) && !(object instanceof FabricPolyline)) {
      const groupMatrix = multiply(parent, object.calcTransformMatrix() as Matrix);
      for (const child of object.getObjects()) walk(child, groupMatrix);
      return;
    }
    const matrix = multiply(parent, object.calcTransformMatrix() as Matrix);
    const converted = convertObject(object, matrix, warnings);
    if (converted) shapes.push(converted);
  };

  for (const object of objects) walk(object, rootMatrix);

  if (!shapes.length) warnings.push(t('engine.svg.noShapes'));

  return { shapes, warnings, width: size.width * extraScale, height: size.height * extraScale };
}

function measureSvg(svgText: string): { width: number; height: number } {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  const read = (attr: string, fallback: number): number => {
    const raw = svg.getAttribute(attr);
    if (!raw) return fallback;
    const value = parseFloat(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  let width = read('width', 0);
  let height = read('height', 0);
  if (!width || !height) {
    const viewBox = svg.getAttribute('viewBox');
    if (viewBox) {
      const parts = viewBox.split(/[\s,]+/).map(Number);
      if (parts.length === 4) {
        width = parts[2];
        height = parts[3];
      }
    }
  }
  return { width: width || 800, height: height || 600 };
}

function readPaint(object: FabricObject, key: 'fill' | 'stroke'): string | null {
  const raw = (object as unknown as Record<string, unknown>)[key];
  if (typeof raw !== 'string') return null;
  if (!raw || raw === 'none' || raw === 'transparent') return null;
  return normalizeColor(raw);
}

function convertObject(object: FabricObject, matrix: Matrix, warnings: string[]): Shape | null {
  const decomposed = util.qrDecompose(matrix);
  const center = { x: decomposed.translateX, y: decomposed.translateY };
  const sx = Math.abs(decomposed.scaleX) || 1;
  const sy = Math.abs(decomposed.scaleY) || 1;
  const angle = normalizeAngle(decomposed.angle);
  const fill = readPaint(object, 'fill');
  const stroke = readPaint(object, 'stroke');
  const strokeWidth = Number((object as unknown as Record<string, unknown>).strokeWidth) || 0;

  const applyCommon = (shape: Shape): Shape => {
    shape.Fill = fill ? { Const: fill } : null;
    shape.Stroke = stroke ? { Const: stroke } : null;
    shape.StrokeThickness = { Const: Math.max(0.1, Math.round(strokeWidth * ((sx + sy) / 2) * 100) / 100) };
    const opacity = typeof object.opacity === 'number' ? object.opacity : 1;
    if (opacity < 1) shape.Opacity = { Const: Math.round(opacity * 1000) / 1000 };
    if (angle !== 0) {
      shape.RenderTransform = {
        Rotate: { CenterX: c(center.x), CenterY: c(center.y), Value: c(angle) },
      };
    }
    return shape;
  };

  if (object instanceof FabricRect) {
    const width = object.width * sx;
    const height = object.height * sy;
    const shape = createShape('Rectangle', {
      x: center.x - width / 2,
      y: center.y - height / 2,
      width,
      height,
    }, { name: t('engine.svg.name.rectangle') });
    if (shape.Type === 'Rectangle') {
      if (object.rx) shape.RadiusX = c(object.rx * sx);
      if (object.ry) shape.RadiusY = c(object.ry * sy);
    }
    return applyCommon(shape);
  }

  if (object instanceof FabricCircle) {
    const radius = object.radius;
    const shape = createShape('Ellipse', {
      cx: center.x,
      cy: center.y,
      rx: radius * sx,
      ry: radius * sy,
    }, { name: t('engine.svg.name.circle') });
    return applyCommon(shape);
  }

  if (object instanceof FabricEllipse) {
    const shape = createShape('Ellipse', {
      cx: center.x,
      cy: center.y,
      rx: object.rx * sx,
      ry: object.ry * sy,
    }, { name: t('engine.svg.name.ellipse') });
    return applyCommon(shape);
  }

  if (object instanceof FabricPolygon || object instanceof FabricPolyline) {
    const points = object.points.map((point) => ({ x: point.x, y: point.y }));
    const localCenter = boundsCenter(points);
    const worldPoints = points.map((point) => ({
      x: center.x + (point.x - localCenter.x) * sx,
      y: center.y + (point.y - localCenter.y) * sy,
    }));

    if (worldPoints.length === 2) {
      const shape = createShape('Line', {
        x1: worldPoints[0].x,
        y1: worldPoints[0].y,
        x2: worldPoints[1].x,
        y2: worldPoints[1].y,
      }, { name: t('engine.svg.name.line') });
      const applied = applyCommon(shape);
      applied.RenderTransform = undefined;
      return applied;
    }

    const shape = createShape('Polygon', { points: worldPoints }, { name: t('engine.svg.name.polygon') });
    if (shape.Type === 'Polygon') shape.IsClosed = object instanceof FabricPolygon;
    const applied = applyCommon(shape);
    // Vertices are already in world coordinates, no rotation needed
    applied.RenderTransform = undefined;
    return applied;
  }

  if (object instanceof FabricPath) {
    const simplified = util.makePathSimpler(object.path) as unknown as Array<Array<string | number>>;
    const commands = toPathCommands(simplified);
    if (!commands.length) {
      warnings.push(t('engine.svg.skipPath'));
      return null;
    }
    const bounds = pathBounds(commands);
    const localCenter = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const scaled = commands.map((command) => transformCommand(command, localCenter, center, sx, sy));
    const shape = createShape('Path', { x: 0, y: 0 }, { name: t('engine.svg.name.path') });
    if (shape.Type === 'Path') {
      shape.Data = stringifyPathData(scaled);
      const newBounds = pathBounds(scaled);
      shape.OffsetX = 0;
      shape.OffsetY = 0;
      void newBounds;
    }
    const applied = applyCommon(shape);
    applied.RenderTransform = undefined;
    return applied;
  }

  warnings.push(t('engine.svg.skipElement', { name: object.constructor?.name ?? t('engine.svg.unknownElement') }));
  return null;
}

function toPathCommands(path: Array<Array<string | number>>): PathCommand[] {
  const out: PathCommand[] = [];
  for (const raw of path) {
    const command = String(raw[0]);
    const nums = raw.slice(1).map(Number);
    switch (command) {
      case 'M':
        out.push({ type: 'M', x: nums[0], y: nums[1] });
        break;
      case 'L':
        out.push({ type: 'L', x: nums[0], y: nums[1] });
        break;
      case 'C':
        out.push({ type: 'C', x1: nums[0], y1: nums[1], x2: nums[2], y2: nums[3], x: nums[4], y: nums[5] });
        break;
      case 'Q':
        out.push({ type: 'Q', x1: nums[0], y1: nums[1], x: nums[2], y: nums[3] });
        break;
      case 'A':
        out.push({ type: 'A', rx: nums[0], ry: nums[1], rotation: nums[2], largeArc: !!nums[3], sweep: !!nums[4], x: nums[5], y: nums[6] });
        break;
      case 'Z':
        out.push({ type: 'Z' });
        break;
      default:
        break;
    }
  }
  return out;
}

function transformCommand(
  command: PathCommand,
  localCenter: { x: number; y: number },
  center: { x: number; y: number },
  sx: number,
  sy: number,
): PathCommand {
  const mapX = (x: number): number => center.x + (x - localCenter.x) * sx;
  const mapY = (y: number): number => center.y + (y - localCenter.y) * sy;
  switch (command.type) {
    case 'M':
    case 'L':
      return { ...command, x: mapX(command.x), y: mapY(command.y) };
    case 'C':
      return { ...command, x1: mapX(command.x1), y1: mapY(command.y1), x2: mapX(command.x2), y2: mapY(command.y2), x: mapX(command.x), y: mapY(command.y) };
    case 'Q':
      return { ...command, x1: mapX(command.x1), y1: mapY(command.y1), x: mapX(command.x), y: mapY(command.y) };
    case 'A':
      return { ...command, rx: Math.abs(command.rx * sx), ry: Math.abs(command.ry * sy), x: mapX(command.x), y: mapY(command.y) };
    case 'Z':
      return command;
    default:
      return command;
  }
}

function boundsCenter(points: Array<{ x: number; y: number }>): { x: number; y: number } {
  if (!points.length) return { x: 0, y: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

function normalizeAngle(angle: number): number {
  const wrapped = angle % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped <= -180 ? wrapped + 360 : wrapped;
}
