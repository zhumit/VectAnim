/**
 * Shape property accessors: the single entry point for the properties panel and binding edits.
 *
 * Properties are addressed by string paths (e.g. "Width", "RenderTransform.Rotate.Value",
 * "Points.2.X") so the panel can render them generically, toggle bindings and validate them.
 */

import type { GroupDef, Shape, ValueRef } from '../schema/types';
import { isBindRef } from '../schema/valueRef';
import { t } from '../i18n';

export type PropGroup = 'geometry' | 'appearance' | 'transform';
export type PropKind = 'number' | 'color' | 'angle' | 'text';

export interface PropDescriptor {
  path: string;
  label: string;
  kind: PropKind;
  group: PropGroup;
  step?: number;
  hint?: string;
  /** Whether the property may be bound to a variable */
  bindable: boolean;
}

export function shapePropDescriptors(shape: Shape): PropDescriptor[] {
  const geometry: PropDescriptor[] = [];
  const step = 1;

  switch (shape.Type) {
    case 'Line':
      geometry.push(
        { path: 'X1', label: t('prop.startX'), kind: 'number', group: 'geometry', step, bindable: true },
        { path: 'Y1', label: t('prop.startY'), kind: 'number', group: 'geometry', step, bindable: true },
        { path: 'X2', label: t('prop.endX'), kind: 'number', group: 'geometry', step, bindable: true },
        { path: 'Y2', label: t('prop.endY'), kind: 'number', group: 'geometry', step, bindable: true },
      );
      break;
    case 'Rectangle':
      geometry.push(
        { path: 'X', label: t('prop.x'), kind: 'number', group: 'geometry', step, bindable: true },
        { path: 'Y', label: t('prop.y'), kind: 'number', group: 'geometry', step, bindable: true },
        { path: 'Width', label: t('prop.width'), kind: 'number', group: 'geometry', step, bindable: true },
        { path: 'Height', label: t('prop.height'), kind: 'number', group: 'geometry', step, bindable: true },
        { path: 'RadiusX', label: t('prop.radiusX'), kind: 'number', group: 'geometry', step, bindable: true },
        { path: 'RadiusY', label: t('prop.radiusY'), kind: 'number', group: 'geometry', step, bindable: true },
      );
      break;
    case 'Ellipse':
      geometry.push(
        { path: 'CenterX', label: t('prop.centerX'), kind: 'number', group: 'geometry', step, bindable: true },
        { path: 'CenterY', label: t('prop.centerY'), kind: 'number', group: 'geometry', step, bindable: true },
        { path: 'RadiusX', label: t('prop.ellipseRadiusX'), kind: 'number', group: 'geometry', step, bindable: true },
        { path: 'RadiusY', label: t('prop.ellipseRadiusY'), kind: 'number', group: 'geometry', step, bindable: true },
      );
      break;
    case 'Polygon':
      shape.Points.forEach((_, index) => {
        geometry.push(
          { path: `Points.${index}.X`, label: t('prop.pointX', { n: index + 1 }), kind: 'number', group: 'geometry', step, bindable: true },
          { path: `Points.${index}.Y`, label: t('prop.pointY', { n: index + 1 }), kind: 'number', group: 'geometry', step, bindable: true },
        );
      });
      break;
    case 'Path':
      geometry.push(
        { path: 'OffsetX', label: t('prop.offsetX'), kind: 'number', group: 'geometry', step, bindable: true },
        { path: 'OffsetY', label: t('prop.offsetY'), kind: 'number', group: 'geometry', step, bindable: true },
      );
      break;
    default:
      break;
  }

  const appearance: PropDescriptor[] = [
    { path: 'Fill', label: t('prop.fill'), kind: 'color', group: 'appearance', bindable: true },
    { path: 'Stroke', label: t('prop.stroke'), kind: 'color', group: 'appearance', bindable: true },
    { path: 'StrokeThickness', label: t('prop.strokeThickness'), kind: 'number', group: 'appearance', step: 0.5, bindable: true },
    { path: 'Opacity', label: t('prop.opacity'), kind: 'number', group: 'appearance', step: 0.05, bindable: true, hint: t('prop.opacityHint') },
  ];

  const transform: PropDescriptor[] = [
    { path: 'RenderTransform.Rotate.Value', label: t('prop.rotation'), kind: 'angle', group: 'transform', step: 1, bindable: true },
    { path: 'RenderTransform.Rotate.CenterX', label: t('prop.rotationCenterX'), kind: 'number', group: 'transform', step, bindable: true },
    { path: 'RenderTransform.Rotate.CenterY', label: t('prop.rotationCenterY'), kind: 'number', group: 'transform', step, bindable: true },
  ];

  return [...geometry, ...appearance, ...transform];
}

export function propLabel(path: string): string {
  const found = ['Fill', 'Stroke', 'StrokeThickness', 'Opacity', 'Width', 'Height', 'RadiusX', 'RadiusY', 'X', 'Y'].includes(path);
  return found ? path : path;
}

/** Read a property reference (constant or binding); returns undefined when absent. */
export function getPropRef(shape: Shape, path: string): ValueRef | null | undefined {
  const segments = path.split('.');

  if (segments[0] === 'RenderTransform') {
    const transform = shape.RenderTransform;
    if (!transform) return undefined;
    if (segments[1] === 'Rotate' && transform.Rotate) {
      return transform.Rotate[segments[2] as 'CenterX' | 'CenterY' | 'Value'];
    }
    if (segments[1] === 'Scale' && transform.Scale) {
      return transform.Scale[segments[2] as 'CenterX' | 'CenterY' | 'ValueX' | 'ValueY'];
    }
    if (segments[1] === 'Translate' && transform.Translate) {
      return transform.Translate[segments[2] as 'X' | 'Y'];
    }
    return undefined;
  }

  if (segments[0] === 'Points') {
    if (shape.Type !== 'Polygon') return undefined;
    const index = Number(segments[1]);
    const point = shape.Points[index];
    if (!point) return undefined;
    return segments[2] === 'X' ? point.X : segments[2] === 'Y' ? point.Y : undefined;
  }

  const record = shape as unknown as Record<string, unknown>;
  const value = record[segments[0]];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object' && ('Const' in (value as object) || 'Bind' in (value as object))) {
    return value as ValueRef;
  }
  return undefined;
}

/** Write a property reference (constant or binding), creating containers as needed. */
export function setPropRef(shape: Shape, path: string, ref: ValueRef): boolean {
  const segments = path.split('.');

  if (segments[0] === 'RenderTransform') {
    shape.RenderTransform = shape.RenderTransform ?? {};
    if (segments[1] === 'Rotate') {
      const existing = shape.RenderTransform.Rotate;
      shape.RenderTransform.Rotate = {
        CenterX: existing?.CenterX ?? { Const: 0 },
        CenterY: existing?.CenterY ?? { Const: 0 },
        Value: existing?.Value ?? { Const: 0 },
      };
      (shape.RenderTransform.Rotate as unknown as Record<string, ValueRef>)[segments[2]] = ref;
      return true;
    }
    if (segments[1] === 'Scale') {
      shape.RenderTransform.Scale = shape.RenderTransform.Scale ?? {
        CenterX: { Const: 0 },
        CenterY: { Const: 0 },
        ValueX: { Const: 1 },
        ValueY: { Const: 1 },
      };
      (shape.RenderTransform.Scale as unknown as Record<string, ValueRef>)[segments[2]] = ref;
      return true;
    }
    if (segments[1] === 'Translate') {
      shape.RenderTransform.Translate = shape.RenderTransform.Translate ?? { X: { Const: 0 }, Y: { Const: 0 } };
      (shape.RenderTransform.Translate as unknown as Record<string, ValueRef>)[segments[2]] = ref;
      return true;
    }
    return false;
  }

  if (segments[0] === 'Points') {
    if (shape.Type !== 'Polygon') return false;
    const index = Number(segments[1]);
    const point = shape.Points[index];
    if (!point) return false;
    if (segments[2] === 'X') point.X = ref;
    else if (segments[2] === 'Y') point.Y = ref;
    else return false;
    return true;
  }

  const record = shape as unknown as Record<string, unknown>;
  record[segments[0]] = ref;
  return true;
}

/** Drop a property reference (used after "clear binding" to fall back to a constant). */
export function clearPropRef(shape: Shape, path: string): void {
  const segments = path.split('.');
  if (segments[0] === 'RenderTransform' && segments[1] === 'Rotate' && segments[2] === 'Value') {
    if (shape.RenderTransform?.Rotate) {
      const current = shape.RenderTransform.Rotate.Value;
      shape.RenderTransform.Rotate.Value = isBindRef(current) ? { Const: 0 } : current;
    }
    return;
  }
  if (segments[0] === 'Points') {
    const index = Number(segments[1]);
    const point = shape.Type === 'Polygon' ? shape.Points[index] : undefined;
    if (!point) return;
    if (segments[2] === 'X' && isBindRef(point.X)) point.X = { Const: 0 };
    if (segments[2] === 'Y' && isBindRef(point.Y)) point.Y = { Const: 0 };
    return;
  }
  const record = shape as unknown as Record<string, unknown>;
  const current = record[segments[0]];
  if (current && typeof current === 'object' && isBindRef(current as ValueRef)) {
    record[segments[0]] = { Const: 0 };
  }
}

/** Whether a property path holds a color. */
export function isColorProp(path: string): boolean {
  return path === 'Fill' || path === 'Stroke';
}

/** Collect every binding of a shape as [{path, variable, label}]. */
export function listBindings(shape: Shape): Array<{ path: string; variable: string; label: string }> {
  const out: Array<{ path: string; variable: string; label: string }> = [];
  for (const descriptor of shapePropDescriptors(shape)) {
    const ref = getPropRef(shape, descriptor.path);
    if (ref && isBindRef(ref)) out.push({ path: descriptor.path, variable: ref.Bind, label: descriptor.label });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Groups
 *
 * A group exposes its own transform and opacity so it can be bound to variables and animated
 * exactly like a single shape. Direct manipulation on the canvas keeps baking into the members,
 * so these values start at the identity and act as an extra layer on top of the members.
 * ------------------------------------------------------------------ */

export function groupPropDescriptors(): PropDescriptor[] {
  return [
    {
      path: 'RenderTransform.Translate.X',
      label: t('prop.groupOffsetX'),
      kind: 'number',
      group: 'transform',
      step: 1,
      bindable: true,
      hint: t('prop.groupOffsetHint'),
    },
    {
      path: 'RenderTransform.Translate.Y',
      label: t('prop.groupOffsetY'),
      kind: 'number',
      group: 'transform',
      step: 1,
      bindable: true,
      hint: t('prop.groupOffsetHint'),
    },
    {
      path: 'RenderTransform.Rotate.Value',
      label: t('prop.rotation'),
      kind: 'angle',
      group: 'transform',
      step: 1,
      bindable: true,
      hint: t('prop.groupRotationHint'),
    },
    {
      path: 'RenderTransform.Scale.ValueX',
      label: t('prop.groupScaleX'),
      kind: 'number',
      group: 'transform',
      step: 0.05,
      bindable: true,
      hint: t('prop.groupScaleHint'),
    },
    {
      path: 'RenderTransform.Scale.ValueY',
      label: t('prop.groupScaleY'),
      kind: 'number',
      group: 'transform',
      step: 0.05,
      bindable: true,
      hint: t('prop.groupScaleHint'),
    },
    {
      path: 'Opacity',
      label: t('prop.groupOpacity'),
      kind: 'number',
      group: 'appearance',
      step: 0.05,
      bindable: true,
      hint: t('prop.groupOpacityHint'),
    },
  ];
}

/** Read a group property reference; returns undefined when the field is absent. */
export function getGroupPropRef(group: GroupDef, path: string): ValueRef | undefined {
  const segments = path.split('.');
  if (segments[0] === 'Opacity') return group.Opacity;

  const transform = group.RenderTransform;
  if (!transform) return undefined;
  if (segments[1] === 'Rotate' && transform.Rotate) {
    return transform.Rotate[segments[2] as 'CenterX' | 'CenterY' | 'Value'];
  }
  if (segments[1] === 'Scale' && transform.Scale) {
    return transform.Scale[segments[2] as 'CenterX' | 'CenterY' | 'ValueX' | 'ValueY'];
  }
  if (segments[1] === 'Translate' && transform.Translate) {
    return transform.Translate[segments[2] as 'X' | 'Y'];
  }
  return undefined;
}

/** Write a group property reference, creating the transform containers as needed. */
export function setGroupPropRef(group: GroupDef, path: string, ref: ValueRef): boolean {
  const segments = path.split('.');
  if (segments[0] === 'Opacity') {
    group.Opacity = ref;
    return true;
  }

  group.RenderTransform = group.RenderTransform ?? {};
  if (segments[1] === 'Rotate') {
    const existing = group.RenderTransform.Rotate;
    group.RenderTransform.Rotate = {
      CenterX: existing?.CenterX ?? { Const: 0 },
      CenterY: existing?.CenterY ?? { Const: 0 },
      Value: existing?.Value ?? { Const: 0 },
    };
    (group.RenderTransform.Rotate as unknown as Record<string, ValueRef>)[segments[2]] = ref;
    return true;
  }
  if (segments[1] === 'Scale') {
    group.RenderTransform.Scale = group.RenderTransform.Scale ?? {
      CenterX: group.RenderTransform.Rotate?.CenterX ?? { Const: 0 },
      CenterY: group.RenderTransform.Rotate?.CenterY ?? { Const: 0 },
      ValueX: { Const: 1 },
      ValueY: { Const: 1 },
    };
    (group.RenderTransform.Scale as unknown as Record<string, ValueRef>)[segments[2]] = ref;
    return true;
  }
  if (segments[1] === 'Translate') {
    group.RenderTransform.Translate = group.RenderTransform.Translate ?? { X: { Const: 0 }, Y: { Const: 0 } };
    (group.RenderTransform.Translate as unknown as Record<string, ValueRef>)[segments[2]] = ref;
    return true;
  }
  return false;
}

/** Collect every binding of a group. */
export function listGroupBindings(group: GroupDef): Array<{ path: string; variable: string; label: string }> {
  const out: Array<{ path: string; variable: string; label: string }> = [];
  for (const descriptor of groupPropDescriptors()) {
    const ref = getGroupPropRef(group, descriptor.path);
    if (ref && isBindRef(ref)) out.push({ path: descriptor.path, variable: ref.Bind, label: descriptor.label });
  }
  return out;
}

/** Keep the rotate and scale centers of a group in sync (they share one pivot). */
export function setGroupPivot(group: GroupDef, centerX: number, centerY: number): void {
  group.RenderTransform = group.RenderTransform ?? {};
  const rounded = { x: Math.round(centerX * 1000) / 1000, y: Math.round(centerY * 1000) / 1000 };
  if (group.RenderTransform.Rotate) {
    group.RenderTransform.Rotate.CenterX = { Const: rounded.x };
    group.RenderTransform.Rotate.CenterY = { Const: rounded.y };
  }
  if (group.RenderTransform.Scale) {
    group.RenderTransform.Scale.CenterX = { Const: rounded.x };
    group.RenderTransform.Scale.CenterY = { Const: rounded.y };
  }
}
