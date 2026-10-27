import { describe, expect, it } from 'vitest';
import { applyEasing, buildTimeTicks, sampleKeyframes, sortKeyframes, trackDuration } from '../engine/keyframes';
import type { KeyframeDef } from '../schema/types';

const linear: KeyframeDef[] = [
  { Time: 0, Value: 0 },
  { Time: 2, Value: 100 },
  { Time: 4, Value: 0 },
];

describe('Keyframe sampling', () => {
  it('linear interpolation', () => {
    expect(sampleKeyframes(linear, 0, false)).toBe(0);
    expect(sampleKeyframes(linear, 1, false)).toBe(50);
    expect(sampleKeyframes(linear, 2, false)).toBe(100);
    expect(sampleKeyframes(linear, 3, false)).toBe(50);
  });

  it('clamps to first/last value outside the range', () => {
    expect(sampleKeyframes(linear, -5, false)).toBe(0);
    expect(sampleKeyframes(linear, 99, false)).toBe(0);
  });

  it('looping wraps around', () => {
    expect(sampleKeyframes(linear, 5, true)).toBeCloseTo(50, 6);
    expect(sampleKeyframes(linear, 4, true)).toBe(0);
    expect(sampleKeyframes(linear, 9, true)).toBeCloseTo(50, 6);
  });

  it('loop-delay region holds the last frame', () => {
    // period = duration 4 + delay 1 = 5
    expect(sampleKeyframes(linear, 4.5, true, 1)).toBe(0);
    expect(sampleKeyframes(linear, 5.5, true, 1)).toBeCloseTo(25, 6);
    expect(sampleKeyframes(linear, 6, true, 1)).toBeCloseTo(50, 6);
  });

  it('single-frame animation is constant', () => {
    expect(sampleKeyframes([{ Time: 1, Value: 42 }], 0, false)).toBe(42);
    expect(sampleKeyframes([{ Time: 1, Value: 42 }], 10, true)).toBe(42);
  });

  it('empty sequence returns undefined', () => {
    expect(sampleKeyframes([], 1, false)).toBeUndefined();
  });

  it('out-of-order keyframes are sorted first; duplicate times take the later', () => {
    const frames: KeyframeDef[] = [
      { Time: 2, Value: 100 },
      { Time: 0, Value: 0 },
      { Time: 2, Value: 200 },
    ];
    const sorted = sortKeyframes(frames);
    expect(sorted.map((frame) => frame.Time)).toEqual([0, 2]);
    expect(sorted[1].Value).toBe(200);
    // midpoint of 0 → 200
    expect(sampleKeyframes(frames, 1, false)).toBe(100);
  });

  it('easing endpoints are correct and monotonic', () => {
    for (const kind of ['Linear', 'EaseIn', 'EaseOut', 'EaseInOut', 'Step'] as const) {
      expect(applyEasing(kind, 0)).toBe(0);
      if (kind !== 'Step') expect(applyEasing(kind, 1)).toBeCloseTo(1, 6);
    }
    expect(applyEasing('EaseIn', 0.5)).toBeLessThan(0.5);
    expect(applyEasing('EaseOut', 0.5)).toBeGreaterThan(0.5);
    expect(applyEasing('Step', 0.9)).toBe(0);
  });

  it('easing applies to the starting keyframe', () => {
    const frames: KeyframeDef[] = [
      { Time: 0, Value: 0, Easing: 'EaseIn' },
      { Time: 1, Value: 100 },
    ];
    expect(sampleKeyframes(frames, 0.5, false)).toBeCloseTo(25, 6);
  });

  it('timeline ticks and duration', () => {
    expect(trackDuration(linear)).toBe(4);
    const ticks = buildTimeTicks(4, 4);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeCloseTo(4, 6);
    expect(ticks.length).toBeGreaterThan(2);
  });
});
