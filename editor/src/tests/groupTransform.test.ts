import { describe, expect, it } from 'vitest';
import {
  IDENTITY_GROUP_TRANSFORM,
  applyGroupPoint,
  composeGroupTransform,
  invertComposedTransform,
  invertGroupPoint,
  isIdentityGroupTransform,
  resolveGroupTransform,
  type ResolvedGroupTransform,
} from '../engine/groupTransform';
import { resolveDocument } from '../engine/resolve';
import { createEmptyDocument, type GroupDef, type Shape } from '../schema/types';

const rotate90: ResolvedGroupTransform = { tx: 0, ty: 0, angle: 90, cx: 100, cy: 100, sx: 1, sy: 1 };

function rectangle(id: string, x: number, y: number): Shape {
  return {
    Id: id,
    Name: id,
    Type: 'Rectangle',
    IsVisible: true,
    ZIndex: 0,
    X: { Const: x },
    Y: { Const: y },
    Width: { Const: 20 },
    Height: { Const: 20 },
  };
}

describe('group transform', () => {
  it('resolves to the identity when the group has no transform', () => {
    const group: GroupDef = { GroupId: 'g', Name: 'G', ShapeIds: ['a'], Visible: true };
    expect(isIdentityGroupTransform(resolveGroupTransform(group, () => undefined))).toBe(true);
    expect(resolveGroupTransform(group, () => undefined)).toBe(IDENTITY_GROUP_TRANSFORM);
  });

  it('resolves bound values from variables', () => {
    const group: GroupDef = {
      GroupId: 'g',
      Name: 'G',
      ShapeIds: ['a'],
      Visible: true,
      RenderTransform: {
        Rotate: { CenterX: { Const: 10 }, CenterY: { Const: 20 }, Value: { Bind: 'Angle' } },
        Translate: { X: { Bind: 'Dx' }, Y: { Const: 5 } },
      },
    };
    const resolved = resolveGroupTransform(group, (name) => (name === 'Angle' ? 45 : name === 'Dx' ? 7 : undefined));
    expect(resolved.angle).toBe(45);
    expect(resolved.tx).toBe(7);
    expect(resolved.ty).toBe(5);
    expect(resolved.cx).toBe(10);
    expect(resolved.cy).toBe(20);
  });

  it('rotates around the pivot and then translates', () => {
    // (110,100) is 10px right of the pivot → a clockwise 90° turn puts it 10px below
    const moved = applyGroupPoint(rotate90, 110, 100);
    expect(moved.x).toBeCloseTo(100, 6);
    expect(moved.y).toBeCloseTo(110, 6);

    const offset = applyGroupPoint({ ...rotate90, tx: 5, ty: -5 }, 110, 100);
    expect(offset.x).toBeCloseTo(105, 6);
    expect(offset.y).toBeCloseTo(105, 6);
  });

  it('inverts a point back to member space', () => {
    const transform: ResolvedGroupTransform = { tx: 12, ty: -8, angle: 37, cx: 40, cy: 60, sx: 1.5, sy: 0.75 };
    const world = applyGroupPoint(transform, 123, 45);
    const back = invertGroupPoint(transform, world.x, world.y);
    expect(back.x).toBeCloseTo(123, 6);
    expect(back.y).toBeCloseTo(45, 6);
  });

  it('composes and inverts a shape transform', () => {
    const transform: ResolvedGroupTransform = { tx: 3, ty: 4, angle: 30, cx: 50, cy: 50, sx: 2, sy: 2 };
    const shape = { angle: 10, sx: 1.2, sy: 1.2, centerX: 60, centerY: 70 };
    const composed = composeGroupTransform(transform, shape);

    expect(composed.angle).toBeCloseTo(40, 6);
    expect(composed.sx).toBeCloseTo(2.4, 6);

    const back = invertComposedTransform(transform, composed);
    expect(back.angle).toBeCloseTo(10, 6);
    expect(back.sx).toBeCloseTo(1.2, 6);
    expect(back.centerX).toBeCloseTo(60, 6);
    expect(back.centerY).toBeCloseTo(70, 6);
  });

  it('keeps the identity fast path', () => {
    expect(isIdentityGroupTransform(undefined)).toBe(true);
    expect(isIdentityGroupTransform({ ...IDENTITY_GROUP_TRANSFORM })).toBe(true);
    expect(isIdentityGroupTransform({ ...IDENTITY_GROUP_TRANSFORM, angle: 1 })).toBe(false);
    expect(isIdentityGroupTransform({ ...IDENTITY_GROUP_TRANSFORM, sx: 1.01 })).toBe(false);
  });
});

describe('resolveDocument with groups', () => {
  it('attaches the group transform and multiplies the opacity', () => {
    const document = createEmptyDocument();
    document.Shapes = [rectangle('a', 0, 0)];
    document.Groups = [
      {
        GroupId: 'g1',
        Name: 'G',
        ShapeIds: ['a'],
        Visible: true,
        Opacity: { Const: 0.5 },
        RenderTransform: { Rotate: { CenterX: { Const: 10 }, CenterY: { Const: 10 }, Value: { Bind: 'Angle' } } },
      },
    ];

    const resolved = resolveDocument(document, (name) => (name === 'Angle' ? 90 : undefined));
    expect(resolved).toHaveLength(1);
    expect(resolved[0].opacity).toBeCloseTo(0.5, 6);
    expect(resolved[0].groupTransform?.angle).toBe(90);
    expect(resolved[0].groupTransform?.cx).toBe(10);
  });

  it('omits the group transform when it is the identity', () => {
    const document = createEmptyDocument();
    document.Shapes = [rectangle('a', 0, 0)];
    document.Groups = [{ GroupId: 'g1', Name: 'G', ShapeIds: ['a'], Visible: true }];

    const [resolved] = resolveDocument(document, () => undefined);
    expect(resolved.groupTransform).toBeUndefined();
    expect(resolved.opacity).toBe(1);
  });
});
