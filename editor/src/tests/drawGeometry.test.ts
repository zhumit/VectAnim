import { describe, expect, it } from 'vitest';
import {
  constrainDragPoint,
  ellipseFromDrag,
  isDragDrawKind,
  rectFromDrag,
  semicircleArcCommands,
  semicircleArcData,
} from '../editor/drawGeometry';
import { parsePathData, pathBounds } from '../engine/pathData';

describe('Shift constraint', () => {
  it('rectangle with Shift uses the longer side as the edge (drag to bottom-right)', () => {
    expect(constrainDragPoint('rect', { x: 0, y: 0 }, { x: 80, y: 30 }, true)).toEqual({ x: 80, y: 80 });
  });

  it('rectangle with Shift keeps the drag direction (drag to top-left)', () => {
    expect(constrainDragPoint('rect', { x: 100, y: 100 }, { x: 40, y: 70 }, true)).toEqual({ x: 40, y: 40 });
  });

  it('ellipse with Shift becomes a circle (equal width/height)', () => {
    const start = { x: 10, y: 10 };
    const end = constrainDragPoint('ellipse', start, { x: 60, y: 130 }, true);
    const box = ellipseFromDrag(start, end);
    expect(box.rx).toBeCloseTo(60, 6);
    expect(box.ry).toBeCloseTo(60, 6);
  });

  it('without Shift the point is returned unchanged', () => {
    const point = { x: 80, y: 30 };
    expect(constrainDragPoint('rect', { x: 0, y: 0 }, point, false)).toEqual(point);
  });

  it('semicircle arc with Shift snaps the diameter direction to a 45° step, length preserved', () => {
    const start = { x: 0, y: 0 };
    const snapped = constrainDragPoint('arc', start, { x: 100, y: 12 }, true);
    const length = Math.hypot(snapped.x, snapped.y);
    expect(length).toBeCloseTo(Math.hypot(100, 12), 6);
    expect(snapped.y).toBeCloseTo(0, 6);
  });

  it('drag-tool classification', () => {
    expect(isDragDrawKind('arc')).toBe(true);
    expect(isDragDrawKind('polygon')).toBe(false);
  });
});

describe('drag → bounding box', () => {
  it('reverse drag still normalizes to top-left + positive size', () => {
    expect(rectFromDrag({ x: 100, y: 100 }, { x: 40, y: 70 })).toEqual({ x: 40, y: 70, width: 60, height: 30 });
  });
});

describe('semicircle arc path', () => {
  it('uses the drag chord as diameter → M + A commands', () => {
    const commands = semicircleArcCommands({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual({ type: 'M', x: 0, y: 0 });
    expect(commands[1]).toMatchObject({ type: 'A', rx: 50, ry: 50, rotation: 0, largeArc: false, sweep: true, x: 100, y: 0 });
  });

  it('bulge direction can be flipped', () => {
    const normal = semicircleArcCommands({ x: 0, y: 0 }, { x: 100, y: 0 }, true)[1];
    const flipped = semicircleArcCommands({ x: 0, y: 0 }, { x: 100, y: 0 }, false)[1];
    expect(normal).toMatchObject({ sweep: true });
    expect(flipped).toMatchObject({ sweep: false });
  });

  it('zero-length drag produces no path', () => {
    expect(semicircleArcCommands({ x: 5, y: 5 }, { x: 5, y: 5 })).toHaveLength(0);
    expect(semicircleArcData({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe('');
  });

  it('output is restorable by the path parser; bounds match the diameter', () => {
    const data = semicircleArcData({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(data.startsWith('M 0,0 A 50,50')).toBe(true);
    const parsed = parsePathData(data);
    expect(parsed.commands).toHaveLength(2);
    const bounds = pathBounds(parsed.commands);
    // The arc bulges toward -Y: x spans 0..100, y spans -50..0
    expect(bounds.x).toBeCloseTo(0, 6);
    expect(bounds.width).toBeCloseTo(100, 6);
    expect(bounds.y).toBeCloseTo(-50, 6);
    expect(bounds.height).toBeCloseTo(50, 6);
  });
});
