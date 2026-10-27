/**
 * Group transforms.
 *
 * A group may carry its own transform on top of its members: translate, then rotate and scale
 * about an explicit center. The editor keeps direct manipulation (drag / scale / rotate on the
 * canvas) baking into the members, so the group transform is an extra layer that exists mainly
 * so a group can be bound to variables and animated like a single shape.
 *
 * The helpers here are pure so the canvas, the preview renderer and the unit tests all agree on
 * the exact same numbers.
 */

import type { GroupDef, RenderTransformDef } from '../schema/types';
import { resolveNumber, type VariableResolver } from '../schema/valueRef';

export interface ResolvedGroupTransform {
  /** Translation applied after rotation and scaling */
  tx: number;
  ty: number;
  /** Rotation in degrees, clockwise positive */
  angle: number;
  /** Rotation / scale center */
  cx: number;
  cy: number;
  /** Scale factors */
  sx: number;
  sy: number;
}

export const IDENTITY_GROUP_TRANSFORM: ResolvedGroupTransform = {
  tx: 0,
  ty: 0,
  angle: 0,
  cx: 0,
  cy: 0,
  sx: 1,
  sy: 1,
};

/** Resolve a group's transform refs against the current variable values. */
export function resolveGroupTransform(
  group: Pick<GroupDef, 'RenderTransform'> | undefined,
  resolver: VariableResolver,
): ResolvedGroupTransform {
  const transform: RenderTransformDef | undefined = group?.RenderTransform;
  if (!transform) return IDENTITY_GROUP_TRANSFORM;

  const rotate = transform.Rotate;
  const scale = transform.Scale;
  const translate = transform.Translate;

  return {
    tx: translate ? resolveNumber(translate.X, resolver, 0) : 0,
    ty: translate ? resolveNumber(translate.Y, resolver, 0) : 0,
    angle: rotate ? resolveNumber(rotate.Value, resolver, 0) : 0,
    cx: rotate ? resolveNumber(rotate.CenterX, resolver, 0) : scale ? resolveNumber(scale.CenterX, resolver, 0) : 0,
    cy: rotate ? resolveNumber(rotate.CenterY, resolver, 0) : scale ? resolveNumber(scale.CenterY, resolver, 0) : 0,
    sx: scale ? resolveNumber(scale.ValueX, resolver, 1) : 1,
    sy: scale ? resolveNumber(scale.ValueY, resolver, 1) : 1,
  };
}

/** Whether the transform is a no-op (nothing to compose, nothing to draw differently). */
export function isIdentityGroupTransform(transform: ResolvedGroupTransform | undefined): boolean {
  if (!transform) return true;
  return (
    transform.tx === 0 &&
    transform.ty === 0 &&
    transform.angle === 0 &&
    transform.sx === 1 &&
    transform.sy === 1
  );
}

/** Map a point from member space into canvas space. */
export function applyGroupPoint(transform: ResolvedGroupTransform, x: number, y: number): { x: number; y: number } {
  const { angle, cx, cy, sx, sy, tx, ty } = transform;
  const dx = (x - cx) * sx;
  const dy = (y - cy) * sy;
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: cx + dx * cos - dy * sin + tx,
    y: cy + dx * sin + dy * cos + ty,
  };
}

/** Map a point from canvas space back into member space (inverse of {@link applyGroupPoint}). */
export function invertGroupPoint(transform: ResolvedGroupTransform, x: number, y: number): { x: number; y: number } {
  const { angle, cx, cy, sx, sy, tx, ty } = transform;
  const radians = (-angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = x - cx - tx;
  const dy = y - cy - ty;
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  return {
    x: cx + (sx === 0 ? 0 : rx / sx),
    y: cy + (sy === 0 ? 0 : ry / sy),
  };
}

/**
 * Compose a group transform with a member's own transform.
 *
 * Both are similarity transforms (translate + rotate + scale), so the result is one as well:
 * angles add up, scale factors multiply and the center is mapped through the group transform.
 * The editor canvas uses this to display the composed result on a single Fabric object.
 */
export function composeGroupTransform(
  group: ResolvedGroupTransform,
  shape: { angle: number; sx: number; sy: number; centerX: number; centerY: number },
): { angle: number; sx: number; sy: number; centerX: number; centerY: number } {
  const center = applyGroupPoint(group, shape.centerX, shape.centerY);
  return {
    angle: shape.angle + group.angle,
    sx: shape.sx * group.sx,
    sy: shape.sy * group.sy,
    centerX: center.x,
    centerY: center.y,
  };
}

/** Inverse of {@link composeGroupTransform}: canvas-space transform back to member space. */
export function invertComposedTransform(
  group: ResolvedGroupTransform,
  composed: { angle: number; sx: number; sy: number; centerX: number; centerY: number },
): { angle: number; sx: number; sy: number; centerX: number; centerY: number } {
  const center = invertGroupPoint(group, composed.centerX, composed.centerY);
  return {
    angle: composed.angle - group.angle,
    sx: group.sx === 0 ? composed.sx : composed.sx / group.sx,
    sy: group.sy === 0 ? composed.sy : composed.sy / group.sy,
    centerX: center.x,
    centerY: center.y,
  };
}
