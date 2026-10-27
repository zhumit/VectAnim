/**
 * Document validation and normalization.
 *
 * Principles:
 *  - Import is "lenient": fix whatever can be fixed (fill in defaults, skip invalid shapes) and
 *    report every problem individually.
 *  - Export is "strict": run the validation before exporting; error-level problems block the export
 *    and point at the offending location.
 *  - A missing field must never crash the runtime — industrial files may well have been hand-edited.
 */

import {
  EASING_KINDS,
  SCHEMA_VERSION,
  SHAPE_TYPES,
  type CanvasDef,
  type EasingKind,
  type ExpressionAnimationDef,
  type GroupDef,
  type KeyframeAnimationDef,
  type KeyframeDef,
  type LineCapStyle,
  type LineJoinStyle,
  type RenderTransformDef,
  type Shape,
  type ShapeType,
  type ValueRef,
  type VariableDef,
  type VectAnimDocument,
} from './types';
import { parseColor } from '../engine/color';
import { isConstRef } from './valueRef';
import { checkExpression } from '../engine/expression';
import { parsePathData } from '../engine/pathData';
import { t } from '../i18n';

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  path: string;
  message: string;
  severity: Severity;
}

export interface ValidationResult {
  document: VectAnimDocument;
  issues: Issue[];
  hasErrors: boolean;
}

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

class IssueCollector {
  readonly issues: Issue[] = [];

  error(path: string, message: string): void {
    this.issues.push({ path, message, severity: 'error' });
  }

  warn(path: string, message: string): void {
    this.issues.push({ path, message, severity: 'warning' });
  }

  info(path: string, message: string): void {
    this.issues.push({ path, message, severity: 'info' });
  }

  get hasErrors(): boolean {
    return this.issues.some((issue) => issue.severity === 'error');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value);
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true' || lowered === '1') return true;
    if (lowered === 'false' || lowered === '0') return false;
  }
  return fallback;
}

/** Parse a ValueRef; returns undefined when invalid */
function parseValueRef(raw: unknown, path: string, issues: IssueCollector, kind: 'number' | 'any' = 'number'): ValueRef | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw)) {
    issues.error(path, t('schema.issue.valueRefNotObject', { type: typeof raw }));
    return undefined;
  }
  if ('Bind' in raw) {
    const name = asString(raw.Bind).trim();
    if (!name) {
      issues.error(path, t('schema.issue.bindNameEmpty'));
      return undefined;
    }
    return { Bind: name };
  }
  if ('Const' in raw) {
    const value = raw.Const;
    if (kind === 'number') {
      const numeric = asNumber(value, Number.NaN);
      if (!Number.isFinite(numeric)) {
        issues.error(path, t('schema.issue.constNotNumber', { value: String(value) }));
        return undefined;
      }
      return { Const: numeric };
    }
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      return { Const: value };
    }
    issues.error(path, t('schema.issue.constTypeUnsupported'));
    return undefined;
  }
  issues.error(path, t('schema.issue.valueRefMissingKey'));
  return undefined;
}

function requireNumberRef(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: IssueCollector,
  fallback: number,
): ValueRef {
  const parsed = parseValueRef(source[key], `${path}.${key}`, issues);
  if (parsed) return parsed;
  if (source[key] === undefined) {
    issues.warn(`${path}.${key}`, t('schema.issue.missingRequired', { fallback }));
  }
  return { Const: fallback };
}

function optionalNumberRef(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: IssueCollector,
): ValueRef | undefined {
  if (source[key] === undefined || source[key] === null) return undefined;
  return parseValueRef(source[key], `${path}.${key}`, issues);
}

function parseColorRef(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: IssueCollector,
): ValueRef | null | undefined {
  if (!(key in source)) return undefined;
  const raw = source[key];
  if (raw === null) return null;
  // { "Const": null } also means "no fill / no stroke" — a common form in hand-written files
  if (isObject(raw) && 'Const' in raw && raw.Const === null) return null;
  const parsed = parseValueRef(raw, `${path}.${key}`, issues, 'any');
  if (!parsed) return null;
  if ('Const' in parsed) {
    const text = asString(parsed.Const);
    if (text === '' || text === 'none' || text === 'transparent') return null;
    if (!parseColor(text)) {
      issues.warn(`${path}.${key}`, t('schema.issue.unknownColor', { color: text }));
    }
  }
  return parsed;
}

function parseRenderTransform(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): RenderTransformDef | undefined {
  if (!isObject(raw)) return undefined;
  const result: RenderTransformDef = {};

  if (isObject(raw.Rotate)) {
    result.Rotate = {
      CenterX: requireNumberRef(raw.Rotate, 'CenterX', `${path}.Rotate`, issues, 0),
      CenterY: requireNumberRef(raw.Rotate, 'CenterY', `${path}.Rotate`, issues, 0),
      Value: requireNumberRef(raw.Rotate, 'Value', `${path}.Rotate`, issues, 0),
    };
  }
  if (isObject(raw.Scale)) {
    result.Scale = {
      CenterX: requireNumberRef(raw.Scale, 'CenterX', `${path}.Scale`, issues, 0),
      CenterY: requireNumberRef(raw.Scale, 'CenterY', `${path}.Scale`, issues, 0),
      ValueX: requireNumberRef(raw.Scale, 'ValueX', `${path}.Scale`, issues, 1),
      ValueY: requireNumberRef(raw.Scale, 'ValueY', `${path}.Scale`, issues, 1),
    };
  }
  if (isObject(raw.Translate)) {
    result.Translate = {
      X: requireNumberRef(raw.Translate, 'X', `${path}.Translate`, issues, 0),
      Y: requireNumberRef(raw.Translate, 'Y', `${path}.Translate`, issues, 0),
    };
  }
  return Object.keys(result).length ? result : undefined;
}

function parseShape(raw: unknown, index: number, issues: IssueCollector, usedIds: Set<string>): Shape | null {
  const path = `Shapes[${index}]`;
  if (!isObject(raw)) {
    issues.error(path, t('schema.issue.shapeNotObject'));
    return null;
  }

  const type = asString(raw.Type) as ShapeType;
  if (!SHAPE_TYPES.includes(type)) {
    issues.error(`${path}.Type`, t('schema.issue.unsupportedShapeType', { type }));
    return null;
  }

  let id = asString(raw.Id).trim();
  if (!id) {
    id = `shape_${index + 1}`;
    issues.warn(`${path}.Id`, t('schema.issue.missingId', { id }));
  }
  if (usedIds.has(id)) {
    const unique = `${id}_${index + 1}`;
    issues.warn(`${path}.Id`, t('schema.issue.duplicateId', { id, unique }));
    id = unique;
  }
  usedIds.add(id);

  const common = {
    Id: id,
    Name: asString(raw.Name, id),
    Type: type,
    IsVisible: asBool(raw.IsVisible, true),
    ZIndex: asNumber(raw.ZIndex, index * 10),
    Opacity: optionalNumberRef(raw, 'Opacity', path, issues),
    Fill: parseColorRef(raw, 'Fill', path, issues),
    Stroke: parseColorRef(raw, 'Stroke', path, issues),
    StrokeThickness: optionalNumberRef(raw, 'StrokeThickness', path, issues) ?? { Const: 1 },
    LineCap: normalizeLineCap(raw.LineCap, `${path}.LineCap`, issues),
    LineJoin: normalizeLineJoin(raw.LineJoin, `${path}.LineJoin`, issues),
    RenderTransform: parseRenderTransform(raw.RenderTransform, `${path}.RenderTransform`, issues),
  };

  switch (type) {
    case 'Line':
      return {
        ...common,
        Type: 'Line',
        X1: requireNumberRef(raw, 'X1', path, issues, 0),
        Y1: requireNumberRef(raw, 'Y1', path, issues, 0),
        X2: requireNumberRef(raw, 'X2', path, issues, 0),
        Y2: requireNumberRef(raw, 'Y2', path, issues, 0),
      };
    case 'Rectangle':
      return {
        ...common,
        Type: 'Rectangle',
        X: requireNumberRef(raw, 'X', path, issues, 0),
        Y: requireNumberRef(raw, 'Y', path, issues, 0),
        Width: requireNumberRef(raw, 'Width', path, issues, 0),
        Height: requireNumberRef(raw, 'Height', path, issues, 0),
        RadiusX: optionalNumberRef(raw, 'RadiusX', path, issues),
        RadiusY: optionalNumberRef(raw, 'RadiusY', path, issues),
      };
    case 'Ellipse':
      return {
        ...common,
        Type: 'Ellipse',
        CenterX: requireNumberRef(raw, 'CenterX', path, issues, 0),
        CenterY: requireNumberRef(raw, 'CenterY', path, issues, 0),
        RadiusX: requireNumberRef(raw, 'RadiusX', path, issues, 10),
        RadiusY: requireNumberRef(raw, 'RadiusY', path, issues, 10),
      };
    case 'Polygon': {
      const points = asArray(raw.Points).map((point, pointIndex) => {
        if (!isObject(point)) {
          issues.error(`${path}.Points[${pointIndex}]`, t('schema.issue.pointNotObject'));
          return null;
        }
        return {
          X: requireNumberRef(point, 'X', `${path}.Points[${pointIndex}]`, issues, 0),
          Y: requireNumberRef(point, 'Y', `${path}.Points[${pointIndex}]`, issues, 0),
        };
      }).filter((point): point is { X: ValueRef; Y: ValueRef } => point !== null);

      if (points.length < 2) {
        issues.error(`${path}.Points`, t('schema.issue.polygonTooFewPoints', { count: points.length }));
      }
      return { ...common, Type: 'Polygon', Points: points, IsClosed: asBool(raw.IsClosed, true) };
    }
    case 'Path': {
      const data = asString(raw.Data).trim();
      if (!data) {
        issues.error(`${path}.Data`, t('schema.issue.pathDataEmpty'));
      } else {
        try {
          parsePathData(data);
        } catch (error) {
          issues.error(`${path}.Data`, t('schema.issue.pathDataInvalid', { error: error instanceof Error ? error.message : String(error) }));
        }
      }
      return {
        ...common,
        Type: 'Path',
        Data: data,
        OffsetX: raw.OffsetX === undefined ? undefined : asNumber(raw.OffsetX, 0),
        OffsetY: raw.OffsetY === undefined ? undefined : asNumber(raw.OffsetY, 0),
      };
    }
    default:
      return null;
  }
}

function normalizeLineCap(raw: unknown, path: string, issues: IssueCollector): LineCapStyle | undefined {
  if (raw === undefined) return undefined;
  const value = asString(raw);
  const map: Record<string, LineCapStyle> = { flat: 'Flat', butt: 'Flat', round: 'Round', square: 'Square' };
  const resolved = map[value.toLowerCase()];
  if (!resolved) {
    issues.warn(path, t('schema.issue.unknownLineCap', { value }));
    return undefined;
  }
  return resolved;
}

function normalizeLineJoin(raw: unknown, path: string, issues: IssueCollector): LineJoinStyle | undefined {
  if (raw === undefined) return undefined;
  const value = asString(raw);
  const map: Record<string, LineJoinStyle> = { miter: 'Miter', bevel: 'Bevel', round: 'Round' };
  const resolved = map[value.toLowerCase()];
  if (!resolved) {
    issues.warn(path, t('schema.issue.unknownLineJoin', { value }));
    return undefined;
  }
  return resolved;
}

export interface ValidateOptions {
  /** Strict mode: upgrade some warnings to errors (used when exporting) */
  strict?: boolean;
}

export function validateDocument(raw: unknown, options: ValidateOptions = {}): ValidationResult {
  const issues = new IssueCollector();

  if (!isObject(raw)) {
    issues.error('$', t('schema.issue.rootNotObject'));
    return { document: emptyDocument(), issues: issues.issues, hasErrors: true };
  }

  const schemaVersion = asString(raw.SchemaVersion, SCHEMA_VERSION);
  if (!/^1\./.test(schemaVersion)) {
    issues.warn('SchemaVersion', t('schema.issue.schemaVersionMismatch', { version: schemaVersion, current: SCHEMA_VERSION }));
  }

  const canvas = parseCanvas(raw.Canvas, issues);

  const variableNames = new Set<string>();
  const variables: VariableDef[] = [];
  asArray(raw.Variables).forEach((item, index) => {
    const path = `Variables[${index}]`;
    if (!isObject(item)) {
      issues.error(path, t('schema.issue.variableNotObject'));
      return;
    }
    const name = asString(item.Name).trim();
    if (!name) {
      issues.error(`${path}.Name`, t('schema.issue.variableNameEmpty'));
      return;
    }
    if (!IDENTIFIER_PATTERN.test(name)) {
      issues.warn(`${path}.Name`, t('schema.issue.variableNamePattern', { name }));
    }
    if (variableNames.has(name)) {
      issues.error(`${path}.Name`, t('schema.issue.variableNameDuplicate', { name }));
      return;
    }
    variableNames.add(name);

    const defaultValue = asNumber(item.DefaultValue, 0);
    const min = item.Min === undefined ? undefined : asNumber(item.Min, Number.NaN);
    const max = item.Max === undefined ? undefined : asNumber(item.Max, Number.NaN);
    if (Number.isFinite(min as number) && Number.isFinite(max as number) && (min as number) > (max as number)) {
      issues.warn(`${path}`, t('schema.issue.minGreaterThanMax', { min: min as number, max: max as number }));
    }
    variables.push({
      Name: name,
      DefaultValue: defaultValue,
      Description: item.Description === undefined ? undefined : asString(item.Description),
      Min: Number.isFinite(min) ? min : undefined,
      Max: Number.isFinite(max) ? max : undefined,
      Unit: item.Unit === undefined ? undefined : asString(item.Unit),
      Decimals: item.Decimals === undefined ? undefined : asNumber(item.Decimals, 0),
    });
  });

  const usedIds = new Set<string>();
  const shapes: Shape[] = [];
  asArray(raw.Shapes).forEach((item, index) => {
    const shape = parseShape(item, index, issues, usedIds);
    if (shape) shapes.push(shape);
  });

  const groups = parseGroups(raw.Groups, usedIds, issues);
  const expressionAnimations = parseExpressionAnimations(raw.ExpressionAnimations, variableNames, issues);
  const keyframeAnimations = parseKeyframeAnimations(raw.KeyframeAnimations, variableNames, issues);

  const document: VectAnimDocument = {
    SchemaVersion: SCHEMA_VERSION,
    Canvas: canvas,
    Variables: variables,
    Shapes: shapes,
    ExpressionAnimations: expressionAnimations,
    KeyframeAnimations: keyframeAnimations,
    Groups: groups,
    Meta: isObject(raw.Meta)
      ? {
          Title: raw.Meta.Title === undefined ? undefined : asString(raw.Meta.Title),
          Description: raw.Meta.Description === undefined ? undefined : asString(raw.Meta.Description),
          Author: raw.Meta.Author === undefined ? undefined : asString(raw.Meta.Author),
          CreatedAt: raw.Meta.CreatedAt === undefined ? undefined : asString(raw.Meta.CreatedAt),
          UpdatedAt: raw.Meta.UpdatedAt === undefined ? undefined : asString(raw.Meta.UpdatedAt),
        }
      : undefined,
  };

  if (options.strict && issues.hasErrors) {
    // In strict mode the report is kept; the caller decides whether to block the export
  }

  return { document, issues: issues.issues, hasErrors: issues.hasErrors };
}

function parseCanvas(raw: unknown, issues: IssueCollector): CanvasDef {
  if (!isObject(raw)) {
    issues.warn('Canvas', t('schema.issue.canvasMissing'));
    return { Width: 800, Height: 600, Background: '#FFFFFFFF' };
  }
  const width = asNumber(raw.Width, 800);
  const height = asNumber(raw.Height, 600);
  if (!(width > 0) || !(height > 0)) {
    issues.error('Canvas', t('schema.issue.canvasSizeInvalid', { width, height }));
  }
  const background = asString(raw.Background, '#FFFFFFFF');
  if (!parseColor(background)) {
    issues.warn('Canvas.Background', t('schema.issue.canvasBackgroundInvalid', { color: background }));
  }
  return {
    Width: width > 0 ? width : 800,
    Height: height > 0 ? height : 600,
    Background: parseColor(background) ? background : '#FFFFFFFF',
  };
}

function parseGroups(raw: unknown, shapeIds: Set<string>, issues: IssueCollector): GroupDef[] {
  const groups: GroupDef[] = [];
  const usedGroupIds = new Set<string>();
  const assigned = new Set<string>();

  asArray(raw).forEach((item, index) => {
    const path = `Groups[${index}]`;
    if (!isObject(item)) {
      issues.error(path, t('schema.issue.groupNotObject'));
      return;
    }
    let groupId = asString(item.GroupId).trim() || `group_${index + 1}`;
    if (usedGroupIds.has(groupId)) {
      const unique = `${groupId}_${index + 1}`;
      issues.warn(`${path}.GroupId`, t('schema.issue.duplicateGroupId', { id: groupId, unique }));
      groupId = unique;
    }
    usedGroupIds.add(groupId);

    const ids: string[] = [];
    for (const rawId of asArray(item.ShapeIds)) {
      const id = asString(rawId).trim();
      if (!id) continue;
      if (!shapeIds.has(id)) {
        issues.warn(`${path}.ShapeIds`, t('schema.issue.groupUnknownShape', { id }));
        continue;
      }
      if (assigned.has(id)) {
        issues.warn(`${path}.ShapeIds`, t('schema.issue.groupShapeAlreadyAssigned', { id }));
        continue;
      }
      assigned.add(id);
      ids.push(id);
    }

    groups.push({
      GroupId: groupId,
      Name: asString(item.Name, groupId),
      ShapeIds: ids,
      Visible: asBool(item.Visible, true),
      Opacity: parseGroupOpacity(item.Opacity, `${path}.Opacity`, issues),
      RenderTransform: parseRenderTransform(item.RenderTransform, `${path}.RenderTransform`, issues),
      Locked: item.Locked === undefined ? undefined : asBool(item.Locked, false),
    });
  });

  return groups;
}

/**
 * Group opacity accepts a bare number as well as a ValueRef: v1.0 files (and anything written by
 * hand) use `"Opacity": 0.5`, while the editor writes `{ "Const": 0.5 }` or `{ "Bind": "..." }`.
 */
function parseGroupOpacity(raw: unknown, path: string, issues: IssueCollector): ValueRef | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number') {
    return { Const: clamp01(Number.isFinite(raw) ? raw : 1) };
  }
  const parsed = parseValueRef(raw, path, issues);
  if (!parsed) return undefined;
  if ('Const' in parsed) return { Const: clamp01(asNumber(parsed.Const, 1)) };
  return parsed;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function parseExpressionAnimations(
  raw: unknown,
  variableNames: Set<string>,
  issues: IssueCollector,
): ExpressionAnimationDef[] {
  const result: ExpressionAnimationDef[] = [];
  const usedIds = new Set<string>();

  asArray(raw).forEach((item, index) => {
    const path = `ExpressionAnimations[${index}]`;
    if (!isObject(item)) {
      issues.error(path, t('schema.issue.expressionNotObject'));
      return;
    }
    const target = asString(item.TargetVariable).trim();
    if (!target) {
      issues.error(`${path}.TargetVariable`, t('schema.issue.missingTarget'));
      return;
    }
    if (!variableNames.has(target)) {
      issues.warn(`${path}.TargetVariable`, t('schema.issue.targetUndefined', { target }));
    }
    let id = asString(item.Id).trim() || `expr_${index + 1}`;
    if (usedIds.has(id)) id = `${id}_${index + 1}`;
    usedIds.add(id);

    const expression = asString(item.Expression).trim();
    if (!expression) {
      issues.error(`${path}.Expression`, t('schema.issue.expressionEmpty'));
      return;
    }
    const check = checkExpression(expression);
    if (!check.ok) {
      issues.error(`${path}.Expression`, t('schema.issue.expressionSyntax', { error: check.message ?? '' }));
      return;
    }
    for (const variable of check.variables) {
      if (!variableNames.has(variable) && variable !== target) {
        issues.warn(`${path}.Expression`, t('schema.issue.expressionUndefinedVariable', { variable }));
      }
    }

    const wrap = item.Wrap === undefined ? undefined : asNumber(item.Wrap, 0);
    result.push({
      Id: id,
      TargetVariable: target,
      Expression: expression,
      Enabled: asBool(item.Enabled, true),
      Wrap: wrap && wrap > 0 ? wrap : undefined,
    });
  });

  return result;
}

function parseKeyframeAnimations(
  raw: unknown,
  variableNames: Set<string>,
  issues: IssueCollector,
): KeyframeAnimationDef[] {
  const result: KeyframeAnimationDef[] = [];
  const usedIds = new Set<string>();

  asArray(raw).forEach((item, index) => {
    const path = `KeyframeAnimations[${index}]`;
    if (!isObject(item)) {
      issues.error(path, t('schema.issue.keyframeAnimationNotObject'));
      return;
    }
    const target = asString(item.TargetVariable).trim();
    if (!target) {
      issues.error(`${path}.TargetVariable`, t('schema.issue.missingTarget'));
      return;
    }
    if (!variableNames.has(target)) {
      issues.warn(`${path}.TargetVariable`, t('schema.issue.targetUndefined', { target }));
    }
    let id = asString(item.Id).trim() || `kf_${index + 1}`;
    if (usedIds.has(id)) id = `${id}_${index + 1}`;
    usedIds.add(id);

    const keyframes: KeyframeDef[] = [];
    asArray(item.Keyframes).forEach((frame, frameIndex) => {
      if (!isObject(frame)) {
        issues.error(`${path}.Keyframes[${frameIndex}]`, t('schema.issue.keyframeNotObject'));
        return;
      }
      const time = asNumber(frame.Time, Number.NaN);
      const value = asNumber(frame.Value, Number.NaN);
      if (!Number.isFinite(time) || !Number.isFinite(value)) {
        issues.error(`${path}.Keyframes[${frameIndex}]`, t('schema.issue.keyframeTimeValueNotNumber'));
        return;
      }
      if (time < 0) {
        issues.warn(`${path}.Keyframes[${frameIndex}].Time`, t('schema.issue.keyframeNegativeTime'));
      }
      const easingRaw = asString(frame.Easing, 'Linear') as EasingKind;
      const easing: EasingKind = EASING_KINDS.includes(easingRaw as EasingKind) ? (easingRaw as EasingKind) : 'Linear';
      if (easingRaw !== 'Linear' && easing !== easingRaw) {
        issues.warn(`${path}.Keyframes[${frameIndex}].Easing`, t('schema.issue.unknownEasing', { easing: easingRaw }));
      }
      keyframes.push({ Time: Math.max(0, time), Value: value, Easing: easing });
    });

    if (!keyframes.length) {
      issues.warn(path, t('schema.issue.keyframesEmpty'));
      return;
    }

    keyframes.sort((a, b) => a.Time - b.Time);

    result.push({
      Id: id,
      Name: asString(item.Name, id),
      TargetVariable: target,
      Loop: asBool(item.Loop, false),
      Keyframes: keyframes,
      Enabled: item.Enabled === undefined ? true : asBool(item.Enabled, true),
      LoopDelay: item.LoopDelay === undefined ? 0 : Math.max(0, asNumber(item.LoopDelay, 0)),
    });
  });

  return result;
}

function emptyDocument(): VectAnimDocument {
  return {
    SchemaVersion: SCHEMA_VERSION,
    Canvas: { Width: 800, Height: 600, Background: '#FFFFFFFF' },
    Variables: [],
    Shapes: [],
    ExpressionAnimations: [],
    KeyframeAnimations: [],
    Groups: [],
  };
}

/** Parse JSON text and validate it */
export function parseDocumentText(text: string): ValidationResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      document: emptyDocument(),
      issues: [{ path: '$', message: t('schema.issue.jsonParseFailed', { error: error instanceof Error ? error.message : String(error) }), severity: 'error' }],
      hasErrors: true,
    };
  }
  return validateDocument(raw);
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

function cleanValueRef(ref: ValueRef | null | undefined): unknown {
  if (!ref) return undefined;
  if ('Bind' in ref) return { Bind: ref.Bind };
  return { Const: ref.Const };
}

function cleanTransform(transform: RenderTransformDef | undefined): unknown {
  if (!transform) return undefined;
  const out: Record<string, unknown> = {};
  if (transform.Rotate) {
    out.Rotate = {
      CenterX: cleanValueRef(transform.Rotate.CenterX),
      CenterY: cleanValueRef(transform.Rotate.CenterY),
      Value: cleanValueRef(transform.Rotate.Value),
    };
  }
  if (transform.Scale) {
    out.Scale = {
      CenterX: cleanValueRef(transform.Scale.CenterX),
      CenterY: cleanValueRef(transform.Scale.CenterY),
      ValueX: cleanValueRef(transform.Scale.ValueX),
      ValueY: cleanValueRef(transform.Scale.ValueY),
    };
  }
  if (transform.Translate) {
    out.Translate = { X: cleanValueRef(transform.Translate.X), Y: cleanValueRef(transform.Translate.Y) };
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanShape(shape: Shape): Record<string, unknown> {
  const out: Record<string, unknown> = {
    Id: shape.Id,
    Name: shape.Name,
    Type: shape.Type,
    IsVisible: shape.IsVisible,
    ZIndex: shape.ZIndex,
  };

  if (shape.Opacity) out.Opacity = cleanValueRef(shape.Opacity);
  if (shape.Fill !== undefined) out.Fill = shape.Fill === null ? null : cleanValueRef(shape.Fill);
  if (shape.Stroke !== undefined) out.Stroke = shape.Stroke === null ? null : cleanValueRef(shape.Stroke);
  if (shape.StrokeThickness) out.StrokeThickness = cleanValueRef(shape.StrokeThickness);
  if (shape.LineCap) out.LineCap = shape.LineCap;
  if (shape.LineJoin) out.LineJoin = shape.LineJoin;

  switch (shape.Type) {
    case 'Line':
      out.X1 = cleanValueRef(shape.X1);
      out.Y1 = cleanValueRef(shape.Y1);
      out.X2 = cleanValueRef(shape.X2);
      out.Y2 = cleanValueRef(shape.Y2);
      break;
    case 'Rectangle':
      out.X = cleanValueRef(shape.X);
      out.Y = cleanValueRef(shape.Y);
      out.Width = cleanValueRef(shape.Width);
      out.Height = cleanValueRef(shape.Height);
      if (shape.RadiusX) out.RadiusX = cleanValueRef(shape.RadiusX);
      if (shape.RadiusY) out.RadiusY = cleanValueRef(shape.RadiusY);
      break;
    case 'Ellipse':
      out.CenterX = cleanValueRef(shape.CenterX);
      out.CenterY = cleanValueRef(shape.CenterY);
      out.RadiusX = cleanValueRef(shape.RadiusX);
      out.RadiusY = cleanValueRef(shape.RadiusY);
      break;
    case 'Polygon':
      out.Points = shape.Points.map((point) => ({ X: cleanValueRef(point.X), Y: cleanValueRef(point.Y) }));
      out.IsClosed = shape.IsClosed !== false;
      break;
    case 'Path':
      out.Data = shape.Data;
      if (shape.OffsetX) out.OffsetX = shape.OffsetX;
      if (shape.OffsetY) out.OffsetY = shape.OffsetY;
      break;
  }

  const transform = cleanTransform(shape.RenderTransform);
  if (transform) out.RenderTransform = transform;
  return out;
}

/** Serialize to normalized JSON text (fixed field order, for easy version diffing) */
export function serializeDocument(document: VectAnimDocument, pretty = true): string {
  const payload = {
    SchemaVersion: SCHEMA_VERSION,
    Canvas: {
      Width: round(document.Canvas.Width),
      Height: round(document.Canvas.Height),
      Background: document.Canvas.Background,
    },
    Variables: document.Variables.map((variable) => {
      const out: Record<string, unknown> = { Name: variable.Name, DefaultValue: round(variable.DefaultValue) };
      if (variable.Description !== undefined) out.Description = variable.Description;
      if (variable.Min !== undefined) out.Min = round(variable.Min);
      if (variable.Max !== undefined) out.Max = round(variable.Max);
      if (variable.Unit !== undefined) out.Unit = variable.Unit;
      if (variable.Decimals !== undefined) out.Decimals = variable.Decimals;
      return out;
    }),
    Shapes: [...document.Shapes]
      .sort((a, b) => (a.ZIndex === b.ZIndex ? 0 : a.ZIndex - b.ZIndex))
      .map(cleanShape),
    ExpressionAnimations: document.ExpressionAnimations.map((item) => {
      const out: Record<string, unknown> = {
        Id: item.Id,
        TargetVariable: item.TargetVariable,
        Expression: item.Expression,
        Enabled: item.Enabled,
      };
      if (item.Wrap) out.Wrap = item.Wrap;
      return out;
    }),
    KeyframeAnimations: document.KeyframeAnimations.map((item) => {
      const out: Record<string, unknown> = {
        Id: item.Id,
        Name: item.Name,
        TargetVariable: item.TargetVariable,
        Loop: item.Loop,
        Keyframes: item.Keyframes.map((frame) => {
          const frameOut: Record<string, unknown> = { Time: round(frame.Time), Value: round(frame.Value) };
          if (frame.Easing && frame.Easing !== 'Linear') frameOut.Easing = frame.Easing;
          return frameOut;
        }),
      };
      if (item.Enabled === false) out.Enabled = false;
      if (item.LoopDelay) out.LoopDelay = item.LoopDelay;
      return out;
    }),
    Groups: document.Groups.map((group) => {
      const out: Record<string, unknown> = {
        GroupId: group.GroupId,
        Name: group.Name,
        ShapeIds: [...group.ShapeIds],
        Visible: group.Visible,
      };
      if (group.Opacity !== undefined && !(isConstRef(group.Opacity) && group.Opacity.Const === 1)) {
        out.Opacity = cleanValueRef(group.Opacity);
      }
      const transform = cleanTransform(group.RenderTransform);
      if (transform) out.RenderTransform = transform;
      if (group.Locked) out.Locked = true;
      return out;
    }),
    ...(document.Meta ? { Meta: { ...document.Meta } } : {}),
  };

  return JSON.stringify(payload, null, pretty ? 2 : 0);
}

function round(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10000) / 10000;
}
