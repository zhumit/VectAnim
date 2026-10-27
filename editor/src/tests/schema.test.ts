import { describe, expect, it } from 'vitest';
import { parseDocumentText, serializeDocument, validateDocument } from '../schema/validate';
import type { VectAnimDocument } from '../schema/types';
import gearDemo from '../../../samples/gear-demo.vectanim.json';
import industrialDemo from '../../../samples/industrial-panel.vectanim.json';

const samples: Array<[string, unknown]> = [
  ['Gear demo', gearDemo],
  ['Industrial panel demo', industrialDemo],
];

describe('Document validation', () => {
  for (const [name, raw] of samples) {
    it(`${name} passes validation without errors`, () => {
      const result = validateDocument(raw);
      const errors = result.issues.filter((issue) => issue.severity === 'error');
      expect(errors).toEqual([]);
      expect(result.hasErrors).toBe(false);
      expect(result.document.Shapes.length).toBe((raw as VectAnimDocument).Shapes.length);
      expect(result.document.Variables.length).toBe((raw as VectAnimDocument).Variables.length);
    });
  }

  it('export → re-import round-trips losslessly', () => {
    const first = validateDocument(gearDemo).document;
    const text = serializeDocument(first);
    const second = parseDocumentText(text);
    expect(second.hasErrors).toBe(false);

    expect(second.document.Shapes.map((shape) => shape.Id).sort())
      .toEqual(first.Shapes.map((shape) => shape.Id).sort());
    expect(second.document.Variables).toEqual(first.Variables);
    expect(second.document.Groups).toEqual(first.Groups);

    // Re-serializing must produce identical text (idempotent)
    expect(serializeDocument(second.document)).toBe(text);
  });

  it('preserves variable bindings and expressions', () => {
    const doc = validateDocument(gearDemo).document;
    const gear = doc.Shapes.find((shape) => shape.Id === 'gear_01');
    expect(gear?.RenderTransform?.Rotate?.Value).toEqual({ Bind: 'GearAngle' });

    const text = serializeDocument(doc);
    const reparsed = parseDocumentText(text).document;
    const gearAgain = reparsed.Shapes.find((shape) => shape.Id === 'gear_01');
    expect(gearAgain?.RenderTransform?.Rotate?.Value).toEqual({ Bind: 'GearAngle' });
    expect(reparsed.ExpressionAnimations.some((item) => item.TargetVariable === 'GearAngle')).toBe(true);
  });

  it('fills defaults and warns when optional fields are missing', () => {
    const result = validateDocument({
      SchemaVersion: '1.0',
      Canvas: { Width: 100, Height: 100, Background: '#fff' },
      Variables: [],
      Shapes: [
        { Id: 'a', Name: 'Rectangle', Type: 'Rectangle', X: { Const: 0 }, Y: { Const: 0 }, Width: { Const: 10 }, Height: { Const: 10 } },
      ],
      ExpressionAnimations: [],
      KeyframeAnimations: [],
      Groups: [],
    });
    expect(result.hasErrors).toBe(false);
    const shape = result.document.Shapes[0];
    expect(shape.IsVisible).toBe(true);
    expect(shape.ZIndex).toBe(0);
    expect(shape.Fill).toBeUndefined();
  });

  it('duplicate Ids are renamed automatically', () => {
    const result = validateDocument({
      Canvas: { Width: 100, Height: 100 },
      Shapes: [
        { Id: 'dup', Type: 'Rectangle', X: { Const: 0 }, Y: { Const: 0 }, Width: { Const: 1 }, Height: { Const: 1 } },
        { Id: 'dup', Type: 'Rectangle', X: { Const: 0 }, Y: { Const: 0 }, Width: { Const: 1 }, Height: { Const: 1 } },
      ],
    });
    expect(new Set(result.document.Shapes.map((shape) => shape.Id)).size).toBe(2);
  });

  it('unknown shape types are dropped with an error', () => {
    const result = validateDocument({
      Canvas: { Width: 100, Height: 100 },
      Shapes: [{ Id: 'x', Type: 'Text', X: { Const: 0 } }],
    });
    expect(result.document.Shapes).toHaveLength(0);
    expect(result.hasErrors).toBe(true);
  });

  it('expression syntax errors are rejected', () => {
    const result = validateDocument({
      Canvas: { Width: 100, Height: 100 },
      Variables: [{ Name: 'A', DefaultValue: 0 }],
      ExpressionAnimations: [{ Id: 'e1', TargetVariable: 'A', Expression: '1 +', Enabled: true }],
    });
    expect(result.hasErrors).toBe(true);
    expect(result.document.ExpressionAnimations).toHaveLength(0);
  });

  it('referencing undefined variables only warns', () => {
    const result = validateDocument({
      Canvas: { Width: 100, Height: 100 },
      Variables: [{ Name: 'A', DefaultValue: 0 }],
      ExpressionAnimations: [{ Id: 'e1', TargetVariable: 'A', Expression: 'B * 2', Enabled: true }],
    });
    expect(result.hasErrors).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('undefined variable'))).toBe(true);
  });

  it('invalid path data is rejected', () => {
    const result = validateDocument({
      Canvas: { Width: 100, Height: 100 },
      Shapes: [{ Id: 'p', Type: 'Path', Data: 'M 0,0 X 1,1' }],
    });
    expect(result.hasErrors).toBe(true);
  });

  it('group references to missing shapes are removed', () => {
    const result = validateDocument({
      Canvas: { Width: 100, Height: 100 },
      Shapes: [{ Id: 'a', Type: 'Ellipse', CenterX: { Const: 0 }, CenterY: { Const: 0 }, RadiusX: { Const: 1 }, RadiusY: { Const: 1 } }],
      Groups: [{ GroupId: 'g1', Name: 'Group', ShapeIds: ['a', 'ghost'], Visible: true }],
    });
    expect(result.document.Groups[0].ShapeIds).toEqual(['a']);
    expect(result.issues.some((issue) => issue.message.includes('does not exist'))).toBe(true);
  });

  it('JSON syntax errors produce an error message', () => {
    const result = parseDocumentText('{ not json');
    expect(result.hasErrors).toBe(true);
    expect(result.issues[0].message).toContain('Failed to parse JSON');
  });
});
