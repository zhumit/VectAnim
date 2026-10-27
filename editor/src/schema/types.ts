/**
 * VectAnim Schema v1.0 — the data contract shared by the editor and the WPF runtime.
 *
 * Conventions:
 *  1. All JSON field names are PascalCase, 1:1 with C# deserialization, with no name mapping.
 *  2. Coordinate system: origin at the top-left (0,0), X to the right, Y downward, in WPF
 *     device-independent pixels (DIP).
 *  3. Every animatable numeric/color property uses the ValueRef union: { "Const": x } or { "Bind": "variableName" }.
 *  4. Rotation is in degrees (°), clockwise positive (matching Fabric.angle and WPF RotateTransform.Angle).
 *  5. Fields marked "extension" are optional v1.0 additions; absent means the identity transform, so
 *     older readers can safely ignore them.
 */

import { t } from '../i18n';

export const SCHEMA_VERSION = '1.0' as const;

/* ------------------------------------------------------------------ *
 * Property value union
 * ------------------------------------------------------------------ */

/** Constant value: number, color string, boolean */
export type ConstantValue = number | string | boolean;

/** Property value reference: a constant or a variable binding */
export type ValueRef =
  | { Const: ConstantValue }
  | { Bind: string };

/* ------------------------------------------------------------------ *
 * Canvas and variables
 * ------------------------------------------------------------------ */

export interface CanvasDef {
  Width: number;
  Height: number;
  /** CSS color string, e.g. #ffffff / rgba(0,0,0,0) / transparent */
  Background: string;
}

export interface VariableDef {
  Name: string;
  DefaultValue: number;
  Description?: string;
  /** Lower bound (reference for the editor slider and runtime clamping) */
  Min?: number;
  /** Upper bound */
  Max?: number;
  /** Unit, used for display in the editor / host application only */
  Unit?: string;
  /** Decimal places, used for display in the editor / host application only */
  Decimals?: number;
}

/* ------------------------------------------------------------------ *
 * Transform
 * ------------------------------------------------------------------ */

export interface RotateDef {
  CenterX: ValueRef;
  CenterY: ValueRef;
  /** Angle in degrees, clockwise positive */
  Value: ValueRef;
}

/** Extension: scale (around the given center); combined with Rotate, scaling is applied first */
export interface ScaleDef {
  CenterX: ValueRef;
  CenterY: ValueRef;
  ValueX: ValueRef;
  ValueY: ValueRef;
}

/** Extension: translate */
export interface TranslateDef {
  X: ValueRef;
  Y: ValueRef;
}

export interface RenderTransformDef {
  Rotate?: RotateDef;
  Scale?: ScaleDef;
  Translate?: TranslateDef;
}

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

export type ShapeType = 'Line' | 'Rectangle' | 'Ellipse' | 'Polygon' | 'Path';

export type LineCapStyle = 'Flat' | 'Round' | 'Square';
export type LineJoinStyle = 'Miter' | 'Bevel' | 'Round';

export interface PointRef {
  X: ValueRef;
  Y: ValueRef;
}

export interface ShapeBase {
  Id: string;
  Name: string;
  Type: ShapeType;
  IsVisible: boolean;
  /** Z-order; larger values sit on top, equal values follow array order */
  ZIndex: number;
  /** Extension: opacity 0..1, defaults to 1 */
  Opacity?: ValueRef;
  /** Fill color; null or absent means no fill */
  Fill?: ValueRef | null;
  Stroke?: ValueRef | null;
  StrokeThickness?: ValueRef;
  /** Extension: line cap style */
  LineCap?: LineCapStyle;
  /** Extension: line join style */
  LineJoin?: LineJoinStyle;
  RenderTransform?: RenderTransformDef;
}

export interface LineShape extends ShapeBase {
  Type: 'Line';
  X1: ValueRef;
  Y1: ValueRef;
  X2: ValueRef;
  Y2: ValueRef;
}

export interface RectangleShape extends ShapeBase {
  Type: 'Rectangle';
  /** Top-left X (of the unrotated bounding box) */
  X: ValueRef;
  Y: ValueRef;
  Width: ValueRef;
  Height: ValueRef;
  /** Extension: corner radius */
  RadiusX?: ValueRef;
  RadiusY?: ValueRef;
}

export interface EllipseShape extends ShapeBase {
  Type: 'Ellipse';
  CenterX: ValueRef;
  CenterY: ValueRef;
  RadiusX: ValueRef;
  RadiusY: ValueRef;
}

export interface PolygonShape extends ShapeBase {
  Type: 'Polygon';
  Points: PointRef[];
  /** Extension: whether the polygon is closed, defaults to true */
  IsClosed?: boolean;
}

export interface PathShape extends ShapeBase {
  Type: 'Path';
  /** WPF Path Mini-Language (StreamGeometry), e.g. "M 0,0 L 10,10 Z" */
  Data: string;
  /** Extension: world position of the path's local origin (for moving the whole path), defaults to 0,0 */
  OffsetX?: number;
  OffsetY?: number;
}

export type Shape =
  | LineShape
  | RectangleShape
  | EllipseShape
  | PolygonShape
  | PathShape;

/* ------------------------------------------------------------------ *
 * Groups
 * ------------------------------------------------------------------ */

export interface GroupDef {
  GroupId: string;
  Name: string;
  ShapeIds: string[];
  Visible: boolean;
  /**
   * Extension: group-level opacity 0..1. A bare number is accepted for backward compatibility
   * and normalized to { Const: number } by the validator.
   */
  Opacity?: ValueRef;
  /**
   * Extension: transform applied to the whole group, on top of every member's own transform.
   * Order matches the shapes: translate → rotate (about CenterX/CenterY) → scale (about the same
   * center). Absent means the identity transform, so older readers keep working.
   */
  RenderTransform?: RenderTransformDef;
  /** Extension: locked flag (editor semantics, ignored by the runtime) */
  Locked?: boolean;
}

/* ------------------------------------------------------------------ *
 * Animations
 * ------------------------------------------------------------------ */

export interface ExpressionAnimationDef {
  Id: string;
  /** Name of the variable being driven */
  TargetVariable: string;
  /**
   * Expression; may use: variable names, t (seconds), pi, e,
   * and the whitelisted functions: sin cos tan asin acos atan atan2 sqrt abs min max pow floor ceil
   * round sign exp log clamp lerp if(cond,a,b) mod
   */
  Expression: string;
  Enabled: boolean;
  /** Extension: modulo applied to the result, for wrapping angles (e.g. 360) */
  Wrap?: number;
}

export type EasingKind =
  | 'Linear'
  | 'Step'
  | 'EaseIn'
  | 'EaseOut'
  | 'EaseInOut';

export interface KeyframeDef {
  /** Seconds */
  Time: number;
  Value: number;
  /** Extension: easing from this keyframe to the next, defaults to Linear */
  Easing?: EasingKind;
}

export interface KeyframeAnimationDef {
  Id: string;
  Name: string;
  TargetVariable: string;
  Loop: boolean;
  Keyframes: KeyframeDef[];
  /** Extension: enabled flag, defaults to true */
  Enabled?: boolean;
  /** Extension: pause in seconds between loops, defaults to 0 */
  LoopDelay?: number;
}

/* ------------------------------------------------------------------ *
 * Document
 * ------------------------------------------------------------------ */

export interface DocumentMeta {
  Title?: string;
  Description?: string;
  Author?: string;
  CreatedAt?: string;
  UpdatedAt?: string;
}

export interface VectAnimDocument {
  SchemaVersion: string;
  Canvas: CanvasDef;
  Variables: VariableDef[];
  Shapes: Shape[];
  ExpressionAnimations: ExpressionAnimationDef[];
  KeyframeAnimations: KeyframeAnimationDef[];
  Groups: GroupDef[];
  /** Extension: document metadata */
  Meta?: DocumentMeta;
}

/* ------------------------------------------------------------------ *
 * Convenience constants
 * ------------------------------------------------------------------ */

export const DEFAULT_CANVAS: CanvasDef = {
  Width: 800,
  Height: 600,
  Background: '#ffffff',
};

export const SHAPE_TYPES: readonly ShapeType[] = [
  'Line',
  'Rectangle',
  'Ellipse',
  'Polygon',
  'Path',
];

export const EASING_KINDS: readonly EasingKind[] = [
  'Linear',
  'Step',
  'EaseIn',
  'EaseOut',
  'EaseInOut',
];

export function createEmptyDocument(): VectAnimDocument {
  return {
    SchemaVersion: SCHEMA_VERSION,
    Canvas: { ...DEFAULT_CANVAS },
    Variables: [],
    Shapes: [],
    ExpressionAnimations: [],
    KeyframeAnimations: [],
    Groups: [],
    Meta: {
      Title: t('schema.document.untitled'),
      CreatedAt: new Date().toISOString(),
      UpdatedAt: new Date().toISOString(),
    },
  };
}
