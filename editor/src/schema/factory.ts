/**
 * Document object factory: unified default styles and Id generation, so that
 * newly created shapes are "ready to use" and conform to the Schema.
 */

import { t } from '../i18n';
import type {
  ExpressionAnimationDef,
  KeyframeAnimationDef,
  Shape,
  ShapeType,
  ValueRef,
  VariableDef,
} from './types';

let counter = 0;

export function newId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  const random = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0');
  return `${prefix}_${Date.now().toString(36)}${random}${counter.toString(36)}`;
}

export function uniqueName(base: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}

/** Build a valid variable name (referenceable from expressions) */
export function sanitizeVariableName(raw: string): string {
  const trimmed = (raw ?? '').trim();
  const ascii = trimmed.replace(/[^A-Za-z0-9_]/g, '_');
  const withPrefix = /^[A-Za-z_]/.test(ascii) ? ascii : `v_${ascii}`;
  return withPrefix.replace(/_+/g, '_').slice(0, 48) || 'Var';
}

export const DEFAULT_STYLE = {
  fill: '#3B82F6',
  stroke: '#1E3A8A',
  strokeThickness: 1.5,
};

const DEFAULT_TEXT_COLOR = '#111827';

export interface ShapeCreateOptions {
  name?: string;
  fill?: string | null;
  stroke?: string | null;
  strokeThickness?: number;
  zIndex?: number;
}

function c(value: number): ValueRef {
  return { Const: round(value) };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Geometry parameters (world coordinates) */
export interface ShapeGeometryInput {
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  cx?: number;
  cy?: number;
  rx?: number;
  ry?: number;
  points?: Array<{ x: number; y: number }>;
}

/** Create a shape of the given type (geometry uses world coordinates) */
export function createShape(type: ShapeType, geometry: ShapeGeometryInput, options: ShapeCreateOptions = {}): Shape {
  const common = {
    Id: newId(type.toLowerCase()),
    Name: options.name ?? defaultShapeName(type),
    IsVisible: true,
    ZIndex: options.zIndex ?? 0,
    Fill: options.fill === null ? null : { Const: options.fill ?? DEFAULT_STYLE.fill },
    Stroke: options.stroke === null ? null : { Const: options.stroke ?? DEFAULT_STYLE.stroke },
    StrokeThickness: c(options.strokeThickness ?? DEFAULT_STYLE.strokeThickness),
  } as const;

  switch (type) {
    case 'Line':
      return {
        ...common,
        Type: 'Line',
        X1: c(geometry.x1 ?? 0),
        Y1: c(geometry.y1 ?? 0),
        X2: c(geometry.x2 ?? 0),
        Y2: c(geometry.y2 ?? 0),
      };
    case 'Rectangle':
      return {
        ...common,
        Type: 'Rectangle',
        X: c(geometry.x ?? 0),
        Y: c(geometry.y ?? 0),
        Width: c(geometry.width ?? 100),
        Height: c(geometry.height ?? 100),
      };
    case 'Ellipse':
      return {
        ...common,
        Type: 'Ellipse',
        CenterX: c(geometry.cx ?? 0),
        CenterY: c(geometry.cy ?? 0),
        RadiusX: c(geometry.rx ?? 50),
        RadiusY: c(geometry.ry ?? 50),
      };
    case 'Polygon':
      return {
        ...common,
        Type: 'Polygon',
        Points: (geometry.points ?? []).map((point) => ({ X: c(point.x), Y: c(point.y) })),
        IsClosed: true,
      };
    case 'Path':
      return {
        ...common,
        Type: 'Path',
        Data: 'M 0,0 L 100,0 L 100,100 Z',
        OffsetX: geometry.x ?? 0,
        OffsetY: geometry.y ?? 0,
      };
    default:
      throw new Error(t('schema.error.unsupportedShapeType', { type }));
  }
}

export function defaultShapeName(type: ShapeType): string {
  switch (type) {
    case 'Line':
      return t('schema.shapeName.line');
    case 'Rectangle':
      return t('schema.shapeName.rectangle');
    case 'Ellipse':
      return t('schema.shapeName.ellipse');
    case 'Polygon':
      return t('schema.shapeName.polygon');
    case 'Path':
      return t('schema.shapeName.path');
    default:
      return t('schema.shapeName.generic');
  }
}

export function createVariable(name: string, defaultValue = 0, options: Partial<VariableDef> = {}): VariableDef {
  return {
    Name: sanitizeVariableName(name),
    DefaultValue: defaultValue,
    Description: options.Description ?? '',
    Min: options.Min,
    Max: options.Max,
    Unit: options.Unit,
    Decimals: options.Decimals,
  };
}

export function createExpressionAnimation(targetVariable: string, expression = '0', options: Partial<ExpressionAnimationDef> = {}): ExpressionAnimationDef {
  return {
    Id: newId('expr'),
    TargetVariable: targetVariable,
    Expression: expression,
    Enabled: true,
    ...options,
  };
}

export function createKeyframeAnimation(targetVariable: string, options: Partial<KeyframeAnimationDef> = {}): KeyframeAnimationDef {
  return {
    Id: newId('kf'),
    Name: options.Name ?? t('schema.animation.defaultName', { target: targetVariable }),
    TargetVariable: targetVariable,
    Loop: true,
    Keyframes: options.Keyframes ?? [
      { Time: 0, Value: 0, Easing: 'EaseInOut' },
      { Time: 1, Value: 100, Easing: 'EaseInOut' },
      { Time: 2, Value: 0, Easing: 'EaseInOut' },
    ],
    Enabled: true,
    LoopDelay: 0,
  };
}

export const COLOR_PRESETS = [
  '#3B82F6',
  '#0EA5E9',
  '#10B981',
  '#F59E0B',
  '#EF4444',
  '#8B5CF6',
  '#EC4899',
  '#64748B',
  '#111827',
  '#FFFFFF',
];

export { DEFAULT_TEXT_COLOR };
