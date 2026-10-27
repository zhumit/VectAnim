/**
 * Keyframe sampling (TS side, semantics identical to the C# KeyframeTrack).
 *
 * Rules:
 *  - Keyframes are ordered by ascending Time; duplicate times keep the last one.
 *  - Earlier than the first frame → first frame value; later than the last → last frame value (when not looping).
 *  - Loop: period = last frame time + LoopDelay; during the LoopDelay span the last frame value is held.
 *  - Easing comes from the "start keyframe" and applies to the next keyframe.
 */

import type { EasingKind, KeyframeDef, KeyframeAnimationDef } from '../schema/types';

export function applyEasing(kind: EasingKind | undefined, u: number): number {
  const t = u < 0 ? 0 : u > 1 ? 1 : u;
  switch (kind) {
    case 'Step':
      return 0;
    case 'EaseIn':
      return t * t;
    case 'EaseOut':
      return 1 - (1 - t) * (1 - t);
    case 'EaseInOut':
      return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    case 'Linear':
    default:
      return t;
  }
}

export function sortKeyframes(keyframes: readonly KeyframeDef[]): KeyframeDef[] {
  const sorted = [...keyframes].sort((a, b) => a.Time - b.Time);
  const result: KeyframeDef[] = [];
  for (const frame of sorted) {
    const last = result[result.length - 1];
    if (last && Math.abs(last.Time - frame.Time) < 1e-9) {
      result[result.length - 1] = frame;
    } else {
      result.push(frame);
    }
  }
  return result;
}

export function trackDuration(keyframes: readonly KeyframeDef[]): number {
  if (!keyframes.length) return 0;
  let max = 0;
  for (const frame of keyframes) {
    if (frame.Time > max) max = frame.Time;
  }
  return max;
}

/** Sample a keyframe sequence; an empty sequence returns undefined */
export function sampleKeyframes(
  keyframes: readonly KeyframeDef[],
  time: number,
  loop: boolean,
  loopDelay = 0,
): number | undefined {
  const frames = sortKeyframes(keyframes);
  if (!frames.length) return undefined;
  if (frames.length === 1) return frames[0].Value;

  const duration = trackDuration(frames);
  const delay = loopDelay > 0 ? loopDelay : 0;

  let local = time;
  if (loop) {
    const period = duration + delay;
    if (period <= 0) return frames[frames.length - 1].Value;
    local = time % period;
    if (local < 0) local += period;
    if (local > duration) return frames[frames.length - 1].Value;
  } else if (local <= 0) {
    return frames[0].Value;
  } else if (local >= duration) {
    return frames[frames.length - 1].Value;
  }

  // Binary search for the surrounding interval
  let low = 0;
  let high = frames.length - 1;
  while (low < high - 1) {
    const mid = (low + high) >> 1;
    if (frames[mid].Time <= local) low = mid;
    else high = mid;
  }

  const start = frames[low];
  const end = frames[high];
  const span = end.Time - start.Time;
  if (span <= 1e-9) return end.Value;
  const u = (local - start.Time) / span;
  const eased = applyEasing(start.Easing, u);
  return start.Value + (end.Value - start.Value) * eased;
}

export interface AnimationTiming {
  /** Loop period (including LoopDelay); the total duration when not looping */
  period: number;
  loop: boolean;
  loopDelay: number;
  /** Longest period across all keyframe animations, used as the timeline length */
  duration: number;
}

export function computeTiming(animations: readonly KeyframeAnimationDef[]): AnimationTiming {
  let duration = 0;
  let loop = false;
  let loopDelay = 0;
  for (const animation of animations) {
    if (animation.Enabled === false) continue;
    const trackDurationValue = trackDuration(animation.Keyframes);
    if (trackDurationValue > duration) duration = trackDurationValue;
    if (animation.Loop) {
      loop = true;
      loopDelay = Math.max(loopDelay, animation.LoopDelay ?? 0);
    }
  }
  return {
    period: duration + loopDelay,
    loop,
    loopDelay,
    duration,
  };
}

/** Timeline tick generation: picks a 1/2/5×10^n step automatically */
export function buildTimeTicks(duration: number, maxTicks = 10): number[] {
  if (duration <= 0) return [0];
  const rawStep = duration / Math.max(1, maxTicks);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  const ticks: number[] = [];
  for (let value = 0; value <= duration + 1e-9; value += step) {
    ticks.push(Math.round(value * 1000) / 1000);
  }
  return ticks;
}
