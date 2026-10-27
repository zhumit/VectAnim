import { describe, expect, it } from 'vitest';
import { EditorStore } from '../editor/store';
import { createEmptyDocument, type VectAnimDocument } from '../schema/types';
import { createShape, createVariable, createExpressionAnimation } from '../schema/factory';
import {
  addShape,
  deleteShapes,
  duplicateShapes,
  renameVariable,
  removeVariable,
  reorderShapes,
  groupShapes,
  ungroupGroup,
  addVariable,
  alignShapes,
  collectVariableUsages,
} from '../editor/commands';
import { getPropRef, setPropRef, listBindings } from '../editor/props';
import { shapeBounds } from '../editor/geometry';

function makeStore(): EditorStore {
  const doc = createEmptyDocument();
  doc.Canvas.Width = 400;
  doc.Canvas.Height = 300;
  return new EditorStore(doc);
}

function addRect(store: EditorStore, x: number, y: number, width = 50, height = 40): string {
  const shape = createShape('Rectangle', { x, y, width, height });
  addShape(store, shape);
  return shape.Id;
}

describe('Document store', () => {
  it('undo and redo', () => {
    const store = makeStore();
    const id = addRect(store, 10, 10);
    expect(store.getDocument().Shapes).toHaveLength(1);

    store.update((draft) => {
      const shape = draft.Shapes[0];
      if (shape.Type === 'Rectangle') shape.Width = { Const: 99 };
    }, { label: 'change width' });

    expect(store.canUndo()).toBe(true);
    store.undo();
    const width = store.getShape(id);
    expect(width?.Type === 'Rectangle' ? width.Width : null).toEqual({ Const: 50 });
    store.redo();
    const width2 = store.getShape(id);
    expect(width2?.Type === 'Rectangle' ? width2.Width : null).toEqual({ Const: 99 });
  });

  it('coalesceKey merges consecutive edits into one history entry', () => {
    const store = makeStore();
    const id = addRect(store, 0, 0);
    for (let value = 1; value <= 5; value += 1) {
      store.update((draft) => {
        const shape = draft.Shapes[0];
        if (shape.Type === 'Rectangle') shape.Height = { Const: value * 10 };
      }, { label: 'drag', coalesceKey: `h-${id}` });
    }
    const depth = store.getHistoryDepth().undo;
    store.undo();
    const shape = store.getShape(id);
    expect(shape?.Type === 'Rectangle' ? shape.Height : null).toEqual({ Const: 40 });
    expect(depth).toBeLessThanOrEqual(2);
  });

  it('deleting shapes also cleans up groups', () => {
    const store = makeStore();
    const a = addRect(store, 0, 0);
    const b = addRect(store, 100, 0);
    groupShapes(store, [a, b]);
    expect(store.getDocument().Groups).toHaveLength(1);

    deleteShapes(store, [a, b]);
    expect(store.getDocument().Groups).toHaveLength(0);
    expect(store.getDocument().Shapes).toHaveLength(0);
  });

  it('duplicating a shape assigns a new id and offsets it', () => {
    const store = makeStore();
    const id = addRect(store, 10, 20);
    const created = duplicateShapes(store, [id]);
    expect(created).toHaveLength(1);
    expect(created[0]).not.toBe(id);
    const copy = store.getShape(created[0]);
    expect(copy?.Type === 'Rectangle' ? copy.X : null).toEqual({ Const: 26 });
  });

  it('z-order changes', () => {
    const store = makeStore();
    const a = addRect(store, 0, 0);
    const b = addRect(store, 10, 0);
    const c = addRect(store, 20, 0);
    reorderShapes(store, [a], 'front');
    const order = [...store.getDocument().Shapes]
      .sort((left, right) => left.ZIndex - right.ZIndex)
      .map((shape) => shape.Id);
    expect(order[order.length - 1]).toBe(a);
    reorderShapes(store, [a], 'back');
    const order2 = [...store.getDocument().Shapes]
      .sort((left, right) => left.ZIndex - right.ZIndex)
      .map((shape) => shape.Id);
    expect(order2[0]).toBe(a);
    expect(order2).toContain(b);
    expect(order2).toContain(c);
  });

  it('ungrouping keeps the shapes', () => {
    const store = makeStore();
    const a = addRect(store, 0, 0);
    const b = addRect(store, 10, 0);
    groupShapes(store, [a, b]);
    const groupId = store.getDocument().Groups[0].GroupId;
    ungroupGroup(store, groupId);
    expect(store.getDocument().Groups).toHaveLength(0);
    expect(store.getDocument().Shapes).toHaveLength(2);
  });
});

describe('Variables and bindings', () => {
  it('renaming a variable updates bindings and expressions', () => {
    const store = makeStore();
    addVariable(store, createVariable('RPM', 100));
    const id = addRect(store, 0, 0);
    store.update((draft) => {
      const shape = draft.Shapes[0];
      if (shape) setPropRef(shape, 'Width', { Bind: 'RPM' });
    });
    store.update((draft) => {
      draft.ExpressionAnimations.push(createExpressionAnimation('Height', 'RPM * 2'));
    });

    const result = renameVariable(store, 'RPM', 'Speed');
    expect(result.ok).toBe(true);

    const shape = store.getShape(id);
    expect(getPropRef(shape!, 'Width')).toEqual({ Bind: 'Speed' });
    expect(store.getDocument().ExpressionAnimations[0].Expression).toBe('Speed * 2');
  });

  it('renaming does not touch variables that share a prefix', () => {
    const store = makeStore();
    addVariable(store, createVariable('RPM', 1));
    addVariable(store, createVariable('RPMTotal', 1));
    store.update((draft) => {
      draft.ExpressionAnimations.push(createExpressionAnimation('RPMTotal', 'RPMTotal + RPM'));
    });
    renameVariable(store, 'RPM', 'Speed');
    expect(store.getDocument().ExpressionAnimations[0].Expression).toBe('RPMTotal + Speed');
  });

  it('deleting a variable clears its bindings and removes animations', () => {
    const store = makeStore();
    addVariable(store, createVariable('Temp', 20));
    const id = addRect(store, 0, 0);
    store.update((draft) => {
      if (draft.Shapes[0]) setPropRef(draft.Shapes[0], 'Height', { Bind: 'Temp' });
      draft.KeyframeAnimations.push({
        Id: 'k1', Name: 'k', TargetVariable: 'Temp', Loop: true, Keyframes: [{ Time: 0, Value: 0 }],
      });
    });

    const usages = collectVariableUsages(store.getDocument(), 'Temp');
    expect(usages.length).toBeGreaterThan(0);

    removeVariable(store, 'Temp');
    const shape = store.getShape(id);
    expect(getPropRef(shape!, 'Height')).toEqual({ Const: 0 });
    expect(store.getDocument().KeyframeAnimations).toHaveLength(0);
  });

  it('binding list', () => {
    const store = makeStore();
    addVariable(store, createVariable('A', 1));
    const id = addRect(store, 0, 0);
    store.update((draft) => {
      const shape = draft.Shapes[0];
      if (shape) {
        setPropRef(shape, 'Width', { Bind: 'A' });
        setPropRef(shape, 'RenderTransform.Rotate.Value', { Bind: 'A' });
      }
    });
    const shape = store.getShape(id)!;
    const bindings = listBindings(shape);
    expect(bindings.map((item) => item.path).sort()).toEqual(['RenderTransform.Rotate.Value', 'Width']);
  });
});

describe('Geometry', () => {
  it('bounds include the rotated bounding box', () => {
    const store = makeStore();
    const id = addRect(store, 0, 0, 100, 50);
    store.update((draft) => {
      const shape = draft.Shapes[0];
      if (shape) {
        shape.RenderTransform = { Rotate: { CenterX: { Const: 50 }, CenterY: { Const: 25 }, Value: { Const: 90 } } };
      }
    });
    const bounds = shapeBounds(store.getShape(id)!);
    expect(bounds.width).toBeCloseTo(50, 6);
    expect(bounds.height).toBeCloseTo(100, 6);
  });

  it('alignment uses the overall bounds', () => {
    const store = makeStore();
    const a = addRect(store, 0, 0, 40, 20);
    const b = addRect(store, 100, 50, 60, 20);
    alignShapes(store, [a, b], 'left');
    const shapeA = store.getShape(a)!;
    const shapeB = store.getShape(b)!;
    const leftA = shapeA.Type === 'Rectangle' ? (shapeA.X as { Const: number }).Const : -1;
    const leftB = shapeB.Type === 'Rectangle' ? (shapeB.X as { Const: number }).Const : -1;
    expect(leftA).toBeCloseTo(leftB, 6);
  });
});

describe('Runtime (TypeScript)', () => {
  it('expressions and keyframes drive variables, external writes win', async () => {
    const { VectAnimRuntime } = await import('../engine/runtime');
    const doc: VectAnimDocument = {
      SchemaVersion: '1.0',
      Canvas: { Width: 100, Height: 100, Background: '#FFFFFF' },
      Variables: [
        { Name: 'Angle', DefaultValue: 0 },
        { Name: 'Pos', DefaultValue: 0 },
        { Name: 'RPM', DefaultValue: 10 },
      ],
      Shapes: [],
      ExpressionAnimations: [{ Id: 'e', TargetVariable: 'Angle', Expression: 'RPM * 6 * t', Enabled: true, Wrap: 360 }],
      KeyframeAnimations: [{ Id: 'k', Name: 'k', TargetVariable: 'Pos', Loop: false, Keyframes: [{ Time: 0, Value: 0 }, { Time: 1, Value: 100 }] }],
      Groups: [],
    };
    const runtime = new VectAnimRuntime(doc);
    runtime.play();
    runtime.tick(0.5);
    expect(runtime.getVariable('Angle')).toBeCloseTo(30, 6);
    expect(runtime.getVariable('Pos')).toBeCloseTo(50, 6);

    // After an external write of RPM=0 the expression recomputes immediately (angle back to zero)
    runtime.setVariable('RPM', 0, true);
    runtime.tick(0.5);
    expect(runtime.getVariable('Angle')).toBeCloseTo(0, 6);

    // When the target variable is written externally the expression no longer overrides it
    runtime.setVariable('RPM', 10, true);
    runtime.setVariable('Angle', 77, true);
    runtime.tick(0.5);
    expect(runtime.getVariable('Angle')).toBeCloseTo(77, 6);
    runtime.clearExternal('Angle');

    runtime.setVariable('RPM', 10, false);
    runtime.tick(0.5);
    expect(runtime.getVariable('Angle')).toBeCloseTo(10 * 6 * runtime.time, 6);

    runtime.stop();
    expect(runtime.time).toBe(0);
  });

  it('expression dependencies are evaluated in topological order', async () => {
    const { VectAnimRuntime } = await import('../engine/runtime');
    const doc: VectAnimDocument = {
      SchemaVersion: '1.0',
      Canvas: { Width: 10, Height: 10, Background: '#FFFFFF' },
      Variables: [
        { Name: 'A', DefaultValue: 1 },
        { Name: 'B', DefaultValue: 0 },
        { Name: 'C', DefaultValue: 0 },
      ],
      Shapes: [],
      ExpressionAnimations: [
        { Id: 'e2', TargetVariable: 'C', Expression: 'B * 10', Enabled: true },
        { Id: 'e1', TargetVariable: 'B', Expression: 'A + 1', Enabled: true },
      ],
      KeyframeAnimations: [],
      Groups: [],
    };
    const runtime = new VectAnimRuntime(doc);
    runtime.recompute();
    expect(runtime.getVariable('B')).toBe(2);
    expect(runtime.getVariable('C')).toBe(20);
  });
});
