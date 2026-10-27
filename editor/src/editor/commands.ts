/**
 * Document-level commands: every operation that mutates the document goes through here,
 * so labels, history coalescing and reference maintenance stay consistent.
 *
 * Convention: commands never touch Fabric, they only change the document; the canvas
 * repaints itself through the store subscription.
 */

import type {
  EasingKind,
  ExpressionAnimationDef,
  GroupDef,
  KeyframeAnimationDef,
  KeyframeDef,
  Shape,
  VariableDef,
  VectAnimDocument,
} from '../schema/types';
import { newId, sanitizeVariableName, uniqueName } from '../schema/factory';
import { isBindRef } from '../schema/valueRef';
import { t } from '../i18n';
import type { EditorStore } from './store';
import { shapeBounds, translateShape, flipShape, scaleShape } from './geometry';

const Z_STEP = 10;

/* ---------------------------------------------------------------------- *
 * Shapes
 * ---------------------------------------------------------------------- */

export function addShape(store: EditorStore, shape: Shape, label = t('cmd.addShape')): void {
  store.update((draft) => {
    const maxZ = draft.Shapes.reduce((max, item) => Math.max(max, item.ZIndex), 0);
    shape.ZIndex = maxZ + Z_STEP;
    draft.Shapes.push(shape);
  }, { label });
  store.setSelection([shape.Id]);
}

export function addShapes(store: EditorStore, shapes: Shape[], label = t('cmd.importShapes')): void {
  store.update((draft) => {
    let maxZ = draft.Shapes.reduce((max, item) => Math.max(max, item.ZIndex), 0);
    for (const shape of shapes) {
      maxZ += Z_STEP;
      shape.ZIndex = maxZ;
      draft.Shapes.push(shape);
    }
  }, { label });
  store.setSelection(shapes.map((shape) => shape.Id));
}

export function applyShapeEdits(store: EditorStore, edits: Array<{ shape: Shape; label: string }>): void {
  if (!edits.length) return;
  store.update((draft) => {
    for (const edit of edits) {
      const index = draft.Shapes.findIndex((shape) => shape.Id === edit.shape.Id);
      if (index >= 0) draft.Shapes[index] = edit.shape;
    }
  }, { label: edits[0].label });
}

export function deleteShapes(store: EditorStore, ids: readonly string[]): void {
  if (!ids.length) return;
  const set = new Set(ids);
  store.update((draft) => {
    draft.Shapes = draft.Shapes.filter((shape) => !set.has(shape.Id));
    draft.Groups = draft.Groups
      .map((group) => ({ ...group, ShapeIds: group.ShapeIds.filter((id) => !set.has(id)) }))
      .filter((group) => group.ShapeIds.length > 0);
  }, { label: t('cmd.deleteShapes', { count: ids.length }) });
  store.setSelection([]);
}

export function duplicateShapes(store: EditorStore, ids: readonly string[], offset = 16): string[] {
  const source = store.getDocument().Shapes.filter((shape) => ids.includes(shape.Id));
  if (!source.length) return [];
  const newIds: string[] = [];

  store.update((draft) => {
    const maxZ = draft.Shapes.reduce((max, item) => Math.max(max, item.ZIndex), 0);
    const sourceGroups = new Set<string>();
    for (const shape of source) {
      const group = draft.Groups.find((item) => item.ShapeIds.includes(shape.Id));
      if (group) sourceGroups.add(group.GroupId);
    }

    const idMap = new Map<string, string>();
    source.forEach((shape, index) => {
      const clone = JSON.parse(JSON.stringify(shape)) as Shape;
      clone.Id = newId(shape.Type.toLowerCase());
      clone.Name = copyName(shape.Name);
      clone.ZIndex = maxZ + Z_STEP * (index + 1);
      translateShape(clone, offset, offset);
      draft.Shapes.push(clone);
      idMap.set(shape.Id, clone.Id);
      newIds.push(clone.Id);
    });

    // Duplicating a whole group keeps the grouping relationship
    for (const groupId of sourceGroups) {
      const group = draft.Groups.find((item) => item.GroupId === groupId);
      if (!group) continue;
      const fullySelected = group.ShapeIds.every((id) => ids.includes(id));
      if (!fullySelected) continue;
      draft.Groups.push({
        ...group,
        GroupId: newId('group'),
        Name: copyName(group.Name),
        ShapeIds: group.ShapeIds.map((id) => idMap.get(id)).filter((id): id is string => !!id),
      });
    }
  }, { label: t('cmd.duplicateShapes', { count: source.length }) });

  store.setSelection(newIds);
  return newIds;
}

/** Snapshot for drag-copy: geometry of the selected shapes plus any fully covered groups. */
export interface ShapeCopiesSnapshot {
  shapes: Shape[];
  groups: Array<{ Name: string; ShapeIds: string[] }>;
}

/**
 * Insert a snapshot into the document (used by Ctrl + drag copy).
 * The geometry in the snapshot has already been translated by the canvas layer to the drop
 * position; this only assigns new ids, raises the z-order and copies grouping.
 */
export function insertShapeCopies(
  store: EditorStore,
  snapshot: ShapeCopiesSnapshot,
  label = t('cmd.dragCopy'),
): string[] {
  if (!snapshot.shapes.length) return [];
  const newIds: string[] = [];
  store.update((draft) => {
    const maxZ = draft.Shapes.reduce((max, item) => Math.max(max, item.ZIndex), 0);
    const idMap = new Map<string, string>();
    snapshot.shapes.forEach((shape, index) => {
      const clone = JSON.parse(JSON.stringify(shape)) as Shape;
      clone.Id = newId(shape.Type.toLowerCase());
      clone.Name = copyName(shape.Name);
      clone.ZIndex = maxZ + Z_STEP * (index + 1);
      draft.Shapes.push(clone);
      idMap.set(shape.Id, clone.Id);
      newIds.push(clone.Id);
    });

    for (const group of snapshot.groups) {
      const shapeIds = group.ShapeIds.map((id) => idMap.get(id)).filter((id): id is string => !!id);
      if (!shapeIds.length) continue;
      draft.Groups.push({
        GroupId: newId('group'),
        Name: copyName(group.Name),
        ShapeIds: shapeIds,
        Visible: true,
      });
    }
  }, { label });
  return newIds;
}

/** Name for a duplicated object, e.g. "Gear" → "Gear copy". */
function copyName(name: string): string {
  return t('cmd.copySuffix', { name });
}

export type ZOrderMode = 'front' | 'back' | 'forward' | 'backward';
export function reorderShapes(store: EditorStore, ids: readonly string[], mode: ZOrderMode): void {
  if (!ids.length) return;
  const labels: Record<ZOrderMode, string> = {
    front: t('cmd.front'),
    back: t('cmd.back'),
    forward: t('cmd.forward'),
    backward: t('cmd.backward'),
  };

  store.update((draft) => {
    const sorted = [...draft.Shapes].sort((a, b) => (a.ZIndex === b.ZIndex ? 0 : a.ZIndex - b.ZIndex));
    const set = new Set(ids);
    let ordered = sorted;
    if (mode === 'front') {
      ordered = [...sorted.filter((shape) => !set.has(shape.Id)), ...sorted.filter((shape) => set.has(shape.Id))];
    } else if (mode === 'back') {
      ordered = [...sorted.filter((shape) => set.has(shape.Id)), ...sorted.filter((shape) => !set.has(shape.Id))];
    } else {
      const step = mode === 'forward' ? 1 : -1;
      const list = [...sorted];
      const indices = list
        .map((shape, index) => ({ shape, index }))
        .filter((item) => set.has(item.shape.Id))
        .map((item) => item.index);
      const sequence = mode === 'forward' ? [...indices].reverse() : indices;
      for (const index of sequence) {
        const target = index + step;
        if (target < 0 || target >= list.length) continue;
        if (set.has(list[target].Id)) continue;
        [list[index], list[target]] = [list[target], list[index]];
      }
      ordered = list;
    }
    ordered.forEach((shape, index) => {
      shape.ZIndex = (index + 1) * Z_STEP;
    });
  }, { label: labels[mode] });
}

export function groupShapes(store: EditorStore, ids: readonly string[]): void {
  if (ids.length < 2) return;
  store.update((draft) => {
    const set = new Set(ids);
    // Remove the members from their previous groups
    for (const group of draft.Groups) {
      group.ShapeIds = group.ShapeIds.filter((id) => !set.has(id));
    }
    draft.Groups = draft.Groups.filter((group) => group.ShapeIds.length > 0);
    const name = uniqueName(t('cmd.groupName'), draft.Groups.map((group) => group.Name));
    draft.Groups.push({ GroupId: newId('group'), Name: name, ShapeIds: [...ids], Visible: true });
  }, { label: t('cmd.group', { count: ids.length }) });
}

export function ungroupShapes(store: EditorStore, ids: readonly string[]): void {
  const set = new Set(ids);
  const groupIds = store.getDocument().Groups
    .filter((group) => group.ShapeIds.some((id) => set.has(id)))
    .map((group) => group.GroupId);
  if (!groupIds.length) return;
  store.update((draft) => {
    draft.Groups = draft.Groups.filter((group) => !groupIds.includes(group.GroupId));
  }, { label: t('cmd.ungroup') });
}

export function ungroupGroup(store: EditorStore, groupId: string): void {
  store.update((draft) => {
    draft.Groups = draft.Groups.filter((group) => group.GroupId !== groupId);
  }, { label: t('cmd.ungroup') });
}

export function setGroupVisible(store: EditorStore, groupId: string, visible: boolean): void {
  store.update((draft) => {
    const group = draft.Groups.find((item) => item.GroupId === groupId);
    if (group) group.Visible = visible;
  }, { label: visible ? t('cmd.showGroup') : t('cmd.hideGroup'), coalesceKey: `group-visible-${groupId}` });
}

export function renameGroup(store: EditorStore, groupId: string, name: string): void {
  store.update((draft) => {
    const group = draft.Groups.find((item) => item.GroupId === groupId);
    if (group) group.Name = name;
  }, { label: t('cmd.renameGroup'), coalesceKey: `group-name-${groupId}` });
}

export function setShapeVisible(store: EditorStore, id: string, visible: boolean): void {
  store.update((draft) => {
    const shape = draft.Shapes.find((item) => item.Id === id);
    if (shape) shape.IsVisible = visible;
  }, { label: visible ? t('cmd.showShape') : t('cmd.hideShape'), coalesceKey: `visible-${id}` });
}

export function renameShape(store: EditorStore, id: string, name: string): void {
  store.update((draft) => {
    const shape = draft.Shapes.find((item) => item.Id === id);
    if (shape) shape.Name = name;
  }, { label: t('cmd.renameShape'), coalesceKey: `rename-${id}` });
}

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

export function alignShapes(store: EditorStore, ids: readonly string[], mode: AlignMode): void {
  if (ids.length < 2) return;
  const labels: Record<AlignMode, string> = {
    left: t('cmd.alignLeft'),
    hcenter: t('cmd.alignCenterH'),
    right: t('cmd.alignRight'),
    top: t('cmd.alignTop'),
    vcenter: t('cmd.alignCenterV'),
    bottom: t('cmd.alignBottom'),
  };
  const shapes = store.getDocument().Shapes.filter((shape) => ids.includes(shape.Id));
  const boxes = shapes.map((shape) => ({ shape, box: shapeBounds(shape) }));
  const minX = Math.min(...boxes.map((item) => item.box.x));
  const maxX = Math.max(...boxes.map((item) => item.box.x + item.box.width));
  const minY = Math.min(...boxes.map((item) => item.box.y));
  const maxY = Math.max(...boxes.map((item) => item.box.y + item.box.height));

  const deltas = new Map<string, { dx: number; dy: number }>();
  for (const { shape, box } of boxes) {
    let dx = 0;
    let dy = 0;
    switch (mode) {
      case 'left':
        dx = minX - box.x;
        break;
      case 'right':
        dx = maxX - (box.x + box.width);
        break;
      case 'hcenter':
        dx = (minX + maxX) / 2 - (box.x + box.width / 2);
        break;
      case 'top':
        dy = minY - box.y;
        break;
      case 'bottom':
        dy = maxY - (box.y + box.height);
        break;
      case 'vcenter':
        dy = (minY + maxY) / 2 - (box.y + box.height / 2);
        break;
    }
    deltas.set(shape.Id, { dx, dy });
  }

  store.update((draft) => {
    for (const shape of draft.Shapes) {
      const delta = deltas.get(shape.Id);
      if (delta) translateShape(shape, delta.dx, delta.dy);
    }
  }, { label: labels[mode] });
}

export function distributeShapes(store: EditorStore, ids: readonly string[], axis: 'x' | 'y'): void {
  if (ids.length < 3) return;
  const shapes = store.getDocument().Shapes.filter((shape) => ids.includes(shape.Id));
  const items = shapes
    .map((shape) => ({ shape, box: shapeBounds(shape) }))
    .sort((a, b) => (axis === 'x' ? a.box.x - b.box.x : a.box.y - b.box.y));

  const first = items[0].box;
  const last = items[items.length - 1].box;
  const totalSpan = axis === 'x'
    ? last.x + last.width - first.x
    : last.y + last.height - first.y;
  const totalSize = items.reduce((sum, item) => sum + (axis === 'x' ? item.box.width : item.box.height), 0);
  const gap = (totalSpan - totalSize) / (items.length - 1);

  let cursor = axis === 'x' ? first.x : first.y;
  const deltas = new Map<string, number>();
  for (const item of items) {
    const current = axis === 'x' ? item.box.x : item.box.y;
    deltas.set(item.shape.Id, cursor - current);
    cursor += (axis === 'x' ? item.box.width : item.box.height) + gap;
  }

  store.update((draft) => {
    for (const shape of draft.Shapes) {
      const delta = deltas.get(shape.Id);
      if (delta === undefined) continue;
      translateShape(shape, axis === 'x' ? delta : 0, axis === 'y' ? delta : 0);
    }
  }, { label: axis === 'x' ? t('cmd.distributeH') : t('cmd.distributeV') });
}

export function flipShapes(store: EditorStore, ids: readonly string[], axis: 'x' | 'y'): void {
  if (!ids.length) return;
  const shapes = store.getDocument().Shapes.filter((shape) => ids.includes(shape.Id));
  const boxes = shapes.map((shape) => shapeBounds(shape));
  const pivot = axis === 'x'
    ? (Math.min(...boxes.map((box) => box.x)) + Math.max(...boxes.map((box) => box.x + box.width))) / 2
    : (Math.min(...boxes.map((box) => box.y)) + Math.max(...boxes.map((box) => box.y + box.height))) / 2;

  store.update((draft) => {
    for (const shape of draft.Shapes) {
      if (ids.includes(shape.Id)) flipShape(shape, axis, pivot);
    }
  }, { label: axis === 'x' ? t('cmd.flipH') : t('cmd.flipV') });
}

export function nudgeShapes(store: EditorStore, ids: readonly string[], dx: number, dy: number): void {
  if (!ids.length) return;
  store.update((draft) => {
    for (const shape of draft.Shapes) {
      if (ids.includes(shape.Id)) translateShape(shape, dx, dy);
    }
  }, { label: t('cmd.moveShapes'), coalesceKey: 'nudge' });
}

/* ---------------------------------------------------------------------- *
 * Canvas
 * ---------------------------------------------------------------------- */

export function setCanvasSize(store: EditorStore, width: number, height: number, background?: string, scaleContent = false): void {
  const doc = store.getDocument();
  const prevWidth = doc.Canvas.Width;
  const prevHeight = doc.Canvas.Height;
  store.update((draft) => {
    draft.Canvas.Width = Math.max(16, Math.round(width));
    draft.Canvas.Height = Math.max(16, Math.round(height));
    if (background) draft.Canvas.Background = background;
    if (scaleContent && prevWidth > 0 && prevHeight > 0) {
      const sx = draft.Canvas.Width / prevWidth;
      const sy = draft.Canvas.Height / prevHeight;
      for (const shape of draft.Shapes) scaleShape(shape, sx, sy);
    }
  }, { label: t('cmd.canvasSize') });
}

export function setCanvasBackground(store: EditorStore, background: string): void {
  store.update((draft) => {
    draft.Canvas.Background = background;
  }, { label: t('cmd.canvasBackground'), coalesceKey: 'canvas-bg' });
}

/* ---------------------------------------------------------------------- *
 * Variables
 * ---------------------------------------------------------------------- */

export function addVariable(store: EditorStore, variable: VariableDef): boolean {
  const doc = store.getDocument();
  if (doc.Variables.some((item) => item.Name === variable.Name)) return false;
  store.update((draft) => {
    draft.Variables.push({ ...variable, Name: sanitizeVariableName(variable.Name) });
  }, { label: t('cmd.addVariable') });
  return true;
}

export function updateVariable(store: EditorStore, name: string, patch: Partial<VariableDef>): void {
  store.update((draft) => {
    const variable = draft.Variables.find((item) => item.Name === name);
    if (!variable) return;
    Object.assign(variable, patch);
  }, { label: t('cmd.updateVariable'), coalesceKey: `var-${name}` });
}

export function removeVariable(store: EditorStore, name: string): { usedBy: string[] } {
  const doc = store.getDocument();
  const usedBy = collectVariableUsages(doc, name);
  store.update((draft) => {
    draft.Variables = draft.Variables.filter((item) => item.Name !== name);
    draft.ExpressionAnimations = draft.ExpressionAnimations.filter((item) => item.TargetVariable !== name);
    draft.KeyframeAnimations = draft.KeyframeAnimations.filter((item) => item.TargetVariable !== name);
    // Clear shape bindings, falling back to the constant 0
    for (const shape of draft.Shapes) clearBindingsTo(shape, name);
  }, { label: t('cmd.removeVariable', { name }) });
  return { usedBy };
}

/** Rename a variable and rewrite every reference (bindings, expressions, animation targets). */
export function renameVariable(store: EditorStore, oldName: string, rawNewName: string): { ok: boolean; message?: string } {
  const newName = sanitizeVariableName(rawNewName);
  if (!newName) return { ok: false, message: t('cmd.errorNameEmpty') };
  if (newName === oldName) return { ok: true };
  const doc = store.getDocument();
  if (doc.Variables.some((item) => item.Name === newName)) return { ok: false, message: t('cmd.errorNameExists', { name: newName }) };

  store.update((draft) => {
    const variable = draft.Variables.find((item) => item.Name === oldName);
    if (!variable) return;
    variable.Name = newName;

    for (const shape of draft.Shapes) {
      rewriteBindings(shape, (ref) => {
        if (isBindRef(ref) && ref.Bind === oldName) return { Bind: newName };
        return ref;
      });
    }

    for (const animation of draft.ExpressionAnimations) {
      if (animation.TargetVariable === oldName) animation.TargetVariable = newName;
      animation.Expression = renameInExpression(animation.Expression, oldName, newName);
    }
    for (const animation of draft.KeyframeAnimations) {
      if (animation.TargetVariable === oldName) animation.TargetVariable = newName;
    }
  }, { label: t('cmd.renameVariable', { from: oldName, to: newName }) });

  return { ok: true };
}

function renameInExpression(expression: string, oldName: string, newName: string): string {
  const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(oldName)}(?![A-Za-z0-9_])`, 'g');
  return expression.replace(pattern, newName);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function collectVariableUsages(doc: VectAnimDocument, name: string): string[] {
  const usages: string[] = [];
  for (const shape of doc.Shapes) {
    const paths: string[] = [];
    rewriteBindings(shape, (ref, path) => {
      if (isBindRef(ref) && ref.Bind === name) paths.push(path);
      return ref;
    });
    if (paths.length) usages.push(`${shape.Name}(${paths.join(', ')})`);
  }
  for (const animation of doc.ExpressionAnimations) {
    if (animation.TargetVariable === name) usages.push(t('cmd.usageExpressionTarget', { name }));
    else if (new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`).test(animation.Expression)) {
      usages.push(t('cmd.usageExpression', { expression: animation.Expression }));
    }
  }
  for (const animation of doc.KeyframeAnimations) {
    if (animation.TargetVariable === name) usages.push(t('cmd.usageKeyframes', { name: animation.Name }));
  }
  return usages;
}

/** Walk every ValueRef of a shape (transforms included); the callback returns the new ref. */
function rewriteBindings(shape: Shape, mapper: (ref: import('../schema/types').ValueRef, path: string) => import('../schema/types').ValueRef): void {
  const visit = (ref: import('../schema/types').ValueRef | null | undefined, path: string): import('../schema/types').ValueRef | null | undefined => {
    if (!ref) return ref;
    return mapper(ref, path);
  };

  const assign = (key: string, value: import('../schema/types').ValueRef | null | undefined): void => {
    if (value === undefined) return;
    (shape as unknown as Record<string, unknown>)[key] = value;
  };

  assign('Opacity', visit(shape.Opacity, 'Opacity'));
  assign('Fill', visit(shape.Fill, 'Fill'));
  assign('Stroke', visit(shape.Stroke, 'Stroke'));
  assign('StrokeThickness', visit(shape.StrokeThickness, 'StrokeThickness'));

  switch (shape.Type) {
    case 'Line':
      assign('X1', visit(shape.X1, 'X1'));
      assign('Y1', visit(shape.Y1, 'Y1'));
      assign('X2', visit(shape.X2, 'X2'));
      assign('Y2', visit(shape.Y2, 'Y2'));
      break;
    case 'Rectangle':
      assign('X', visit(shape.X, 'X'));
      assign('Y', visit(shape.Y, 'Y'));
      assign('Width', visit(shape.Width, 'Width'));
      assign('Height', visit(shape.Height, 'Height'));
      assign('RadiusX', visit(shape.RadiusX, 'RadiusX'));
      assign('RadiusY', visit(shape.RadiusY, 'RadiusY'));
      break;
    case 'Ellipse':
      assign('CenterX', visit(shape.CenterX, 'CenterX'));
      assign('CenterY', visit(shape.CenterY, 'CenterY'));
      assign('RadiusX', visit(shape.RadiusX, 'RadiusX'));
      assign('RadiusY', visit(shape.RadiusY, 'RadiusY'));
      break;
    case 'Polygon':
      shape.Points.forEach((point, index) => {
        point.X = mapper(point.X, `Points.${index}.X`);
        point.Y = mapper(point.Y, `Points.${index}.Y`);
      });
      break;
    case 'Path':
      break;
    default:
      break;
  }

  if (shape.RenderTransform?.Rotate) {
    shape.RenderTransform.Rotate.CenterX = mapper(shape.RenderTransform.Rotate.CenterX, 'Rotate.CenterX');
    shape.RenderTransform.Rotate.CenterY = mapper(shape.RenderTransform.Rotate.CenterY, 'Rotate.CenterY');
    shape.RenderTransform.Rotate.Value = mapper(shape.RenderTransform.Rotate.Value, 'Rotate.Value');
  }
  if (shape.RenderTransform?.Scale) {
    shape.RenderTransform.Scale.CenterX = mapper(shape.RenderTransform.Scale.CenterX, 'Scale.CenterX');
    shape.RenderTransform.Scale.CenterY = mapper(shape.RenderTransform.Scale.CenterY, 'Scale.CenterY');
    shape.RenderTransform.Scale.ValueX = mapper(shape.RenderTransform.Scale.ValueX, 'Scale.ValueX');
    shape.RenderTransform.Scale.ValueY = mapper(shape.RenderTransform.Scale.ValueY, 'Scale.ValueY');
  }
  if (shape.RenderTransform?.Translate) {
    shape.RenderTransform.Translate.X = mapper(shape.RenderTransform.Translate.X, 'Translate.X');
    shape.RenderTransform.Translate.Y = mapper(shape.RenderTransform.Translate.Y, 'Translate.Y');
  }
}

function clearBindingsTo(shape: Shape, variableName: string): void {
  rewriteBindings(shape, (ref) => (isBindRef(ref) && ref.Bind === variableName ? { Const: 0 } : ref));
}

/* ---------------------------------------------------------------------- *
 * Animations
 * ---------------------------------------------------------------------- */

export function addExpressionAnimation(store: EditorStore, animation: ExpressionAnimationDef): void {
  store.update((draft) => {
    draft.ExpressionAnimations.push(animation);
  }, { label: t('cmd.addExpression') });
}

export function updateExpressionAnimation(store: EditorStore, id: string, patch: Partial<ExpressionAnimationDef>): void {
  store.update((draft) => {
    const target = draft.ExpressionAnimations.find((item) => item.Id === id);
    if (target) Object.assign(target, patch);
  }, { label: t('cmd.updateExpression'), coalesceKey: `expr-${id}` });
}

export function removeExpressionAnimation(store: EditorStore, id: string): void {
  store.update((draft) => {
    draft.ExpressionAnimations = draft.ExpressionAnimations.filter((item) => item.Id !== id);
  }, { label: t('cmd.removeExpression') });
}

export function addKeyframeAnimation(store: EditorStore, animation: KeyframeAnimationDef): void {
  store.update((draft) => {
    draft.KeyframeAnimations.push(animation);
  }, { label: t('cmd.addKeyframeAnimation') });
}

export function updateKeyframeAnimation(store: EditorStore, id: string, patch: Partial<KeyframeAnimationDef>): void {
  store.update((draft) => {
    const target = draft.KeyframeAnimations.find((item) => item.Id === id);
    if (target) Object.assign(target, patch);
  }, { label: t('cmd.updateKeyframeAnimation'), coalesceKey: `kf-${id}` });
}

export function removeKeyframeAnimation(store: EditorStore, id: string): void {
  store.update((draft) => {
    draft.KeyframeAnimations = draft.KeyframeAnimations.filter((item) => item.Id !== id);
  }, { label: t('cmd.removeKeyframeAnimation') });
}

export function addKeyframe(store: EditorStore, animationId: string, keyframe: KeyframeDef): void {
  store.update((draft) => {
    const target = draft.KeyframeAnimations.find((item) => item.Id === animationId);
    if (!target) return;
    target.Keyframes.push(keyframe);
    target.Keyframes.sort((a, b) => a.Time - b.Time);
  }, { label: t('cmd.addKeyframe') });
}

export function updateKeyframe(store: EditorStore, animationId: string, index: number, patch: Partial<KeyframeDef>): void {
  store.update((draft) => {
    const target = draft.KeyframeAnimations.find((item) => item.Id === animationId);
    const frame = target?.Keyframes[index];
    if (!target || !frame) return;
    Object.assign(frame, patch);
    target.Keyframes.sort((a, b) => a.Time - b.Time);
  }, { label: t('cmd.updateKeyframe'), coalesceKey: `kf-${animationId}-${index}` });
}

export function removeKeyframe(store: EditorStore, animationId: string, index: number): void {
  store.update((draft) => {
    const target = draft.KeyframeAnimations.find((item) => item.Id === animationId);
    if (!target) return;
    target.Keyframes.splice(index, 1);
  }, { label: t('cmd.removeKeyframe') });
}

export function setKeyframeEasing(store: EditorStore, animationId: string, index: number, easing: EasingKind): void {
  updateKeyframe(store, animationId, index, { Easing: easing });
}

/* ---------------------------------------------------------------------- *
 * Group helpers
 * ---------------------------------------------------------------------- */

export function groupOf(doc: VectAnimDocument, shapeId: string): GroupDef | undefined {
  return doc.Groups.find((group) => group.ShapeIds.includes(shapeId));
}

export function expandSelectionWithGroups(doc: VectAnimDocument, ids: readonly string[]): string[] {
  const result = new Set(ids);
  for (const id of ids) {
    const group = groupOf(doc, id);
    if (group) for (const memberId of group.ShapeIds) result.add(memberId);
  }
  return [...result];
}
