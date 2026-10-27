/**
 * VectAnim runtime (TS side) — behaviour matches the WPF VectAnimRuntime.
 *
 * Responsibilities:
 *  - Variable table (with the "external writes win" policy)
 *  - Expression animations (dependency topological sort, cycle detection, Wrap modulo)
 *  - Keyframe animations (linear / easing / loop / LoopDelay)
 *  - Frame advance (t accumulates from the start of playback; pausing does not accumulate)
 *
 * The runtime powers the editor's "live preview" and can also serve as a standalone web player core.
 */

import type {
  ExpressionAnimationDef,
  KeyframeAnimationDef,
  VariableDef,
  VectAnimDocument,
} from '../schema/types';
import { t } from '../i18n';
import { compileExpression, type CompiledExpression } from './expression';
import { computeTiming, sampleKeyframes, trackDuration } from './keyframes';
import { euclideanMod } from './expression';

export interface RuntimeWarning {
  kind: 'missing-variable' | 'expression' | 'cycle' | 'keyframe' | 'document';
  message: string;
  target?: string;
}

interface ExpressionTrack {
  def: ExpressionAnimationDef;
  compiled: CompiledExpression | null;
  error?: string;
}

export class VectAnimRuntime {
  private document: VectAnimDocument;
  private readonly values = new Map<string, number>();
  private readonly defaults = new Map<string, number>();
  private readonly external = new Set<string>();
  private expressionTracks: ExpressionTrack[] = [];
  private keyframeTracks: KeyframeAnimationDef[] = [];
  private warnings: RuntimeWarning[] = [];
  private warnedMissing = new Set<string>();

  /** Current animation time (seconds) */
  private currentTime = 0;
  private isPlaying = false;
  private version = 0;

  constructor(document: VectAnimDocument) {
    this.document = document;
    this.loadDocument(document);
  }

  /* ---------------------------------------------------------------- *
   * Document
   * ---------------------------------------------------------------- */

  loadDocument(document: VectAnimDocument): void {
    this.document = document;
    this.values.clear();
    this.defaults.clear();
    this.external.clear();
    this.warnings = [];
    this.warnedMissing.clear();
    this.currentTime = 0;

    for (const variable of document.Variables ?? []) {
      const fallback = Number.isFinite(variable.DefaultValue) ? variable.DefaultValue : 0;
      this.defaults.set(variable.Name, fallback);
      this.values.set(variable.Name, fallback);
    }

    this.expressionTracks = (document.ExpressionAnimations ?? []).map((def) => {
      try {
        return { def, compiled: compileExpression(def.Expression) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.warnings.push({
          kind: 'expression',
          message: t('engine.runtime.expressionInvalid', { expression: def.Expression, error: message }),
          target: def.TargetVariable,
        });
        return { def, compiled: null, error: message };
      }
    });
    this.expressionTracks = this.sortExpressionTracks(this.expressionTracks);

    this.keyframeTracks = (document.KeyframeAnimations ?? []).filter((track) => track.Enabled !== false);

    for (const track of this.expressionTracks) {
      if (!this.defaults.has(track.def.TargetVariable)) {
        this.warnings.push({
          kind: 'missing-variable',
          message: t('engine.runtime.expressionTargetMissing', { name: track.def.TargetVariable }),
          target: track.def.TargetVariable,
        });
        this.defaults.set(track.def.TargetVariable, 0);
        this.values.set(track.def.TargetVariable, 0);
      }
    }
    for (const track of this.keyframeTracks) {
      if (!this.defaults.has(track.TargetVariable)) {
        this.warnings.push({
          kind: 'missing-variable',
          message: t('engine.runtime.keyframeTargetMissing', { animation: track.Name, name: track.TargetVariable }),
          target: track.TargetVariable,
        });
        this.defaults.set(track.TargetVariable, 0);
        this.values.set(track.TargetVariable, 0);
      }
    }

    this.version += 1;
    // Compute once at t=0 right away so the first frame already shows the driven result
    this.recompute();
  }

  getDocument(): VectAnimDocument {
    return this.document;
  }

  getWarnings(): readonly RuntimeWarning[] {
    return this.warnings;
  }

  getVersion(): number {
    return this.version;
  }

  /** Evaluate expression animations in dependency order to avoid a one-frame lag from "read before compute" */
  private sortExpressionTracks(tracks: ExpressionTrack[]): ExpressionTrack[] {
    const byTarget = new Map<string, ExpressionTrack>();
    for (const track of tracks) byTarget.set(track.def.TargetVariable, track);

    const visited = new Set<string>();
    const visiting = new Set<string>();
    const ordered: ExpressionTrack[] = [];

    const visit = (track: ExpressionTrack): void => {
      const name = track.def.TargetVariable;
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        this.warnings.push({ kind: 'cycle', message: t('engine.runtime.cycle', { name }), target: name });
        return;
      }
      visiting.add(name);
      for (const dependency of track.compiled?.variables ?? []) {
        const dependencyTrack = byTarget.get(dependency);
        if (dependencyTrack && dependencyTrack !== track) visit(dependencyTrack);
      }
      visiting.delete(name);
      visited.add(name);
      ordered.push(track);
    };

    for (const track of tracks) visit(track);
    return ordered;
  }

  /* ---------------------------------------------------------------- *
   * Variables
   * ---------------------------------------------------------------- */

  setVariable(name: string, value: number, external = true): void {
    if (!Number.isFinite(value)) return;
    if (!this.defaults.has(name)) {
      this.defaults.set(name, 0);
      this.warnings.push({ kind: 'missing-variable', message: t('engine.runtime.writeUndefined', { name }), target: name });
    }
    this.values.set(name, value);
    if (external) this.external.add(name);
    this.version += 1;
    // Recompute the dependent expressions right after an external write, so the static (paused) frame follows too
    this.recompute();
  }

  getVariable(name: string): number {
    return this.values.get(name) ?? 0;
  }

  hasVariable(name: string): boolean {
    return this.defaults.has(name);
  }

  isExternallyDriven(name: string): boolean {
    return this.external.has(name);
  }

  clearExternal(name?: string): void {
    if (name === undefined) this.external.clear();
    else this.external.delete(name);
    this.version += 1;
    this.recompute();
  }

  /** Reset to the default values and clear the external-write markers */
  resetVariables(): void {
    this.values.clear();
    for (const [name, value] of this.defaults) this.values.set(name, value);
    this.external.clear();
    this.currentTime = 0;
    this.version += 1;
  }

  getVariableDefs(): readonly VariableDef[] {
    return this.document.Variables ?? [];
  }

  /** For the resolver: read a variable (returns undefined when it does not exist) */
  readonly readVariable = (name: string): number | undefined => {
    const value = this.values.get(name);
    if (value === undefined) {
      if (!this.warnedMissing.has(name)) {
        this.warnedMissing.add(name);
        this.warnings.push({ kind: 'missing-variable', message: t('engine.runtime.readUndefined', { name }), target: name });
      }
      return undefined;
    }
    return value;
  };

  /* ---------------------------------------------------------------- *
   * Playback control
   * ---------------------------------------------------------------- */

  get time(): number {
    return this.currentTime;
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  play(): void {
    this.isPlaying = true;
  }

  pause(): void {
    this.isPlaying = false;
  }

  stop(): void {
    this.isPlaying = false;
    this.currentTime = 0;
    this.recompute();
  }

  seek(time: number): void {
    this.currentTime = Math.max(0, time);
    this.recompute();
  }

  /** Advance one frame (seconds). While paused time does not advance, but expressions still recompute from external variables */
  tick(deltaSeconds: number): boolean {
    const clamped = Math.max(0, Math.min(1, deltaSeconds));
    if (this.isPlaying) {
      this.currentTime += clamped;
    }
    return this.recompute();
  }

  /** Recompute all built-in animation variables; returns whether anything changed */
  recompute(): boolean {
    let changed = false;

    // 1) Expression animations (in dependency order)
    const context = { get: this.readVariable, t: this.currentTime };
    for (const track of this.expressionTracks) {
      if (!track.def.Enabled || !track.compiled) continue;
      const target = track.def.TargetVariable;
      if (this.external.has(target)) continue; // external writes win
      let value = track.compiled.evaluate(context);
      const wrap = track.def.Wrap;
      if (typeof wrap === 'number' && wrap > 0) value = euclideanMod(value, wrap);
      const previous = this.values.get(target) ?? 0;
      if (previous !== value) {
        this.values.set(target, value);
        changed = true;
      }
    }

    // 2) Keyframe animations
    for (const track of this.keyframeTracks) {
      const target = track.TargetVariable;
      if (this.external.has(target)) continue;
      const sampled = sampleKeyframes(track.Keyframes, this.currentTime, track.Loop, track.LoopDelay ?? 0);
      if (sampled === undefined) continue;
      const previous = this.values.get(target) ?? 0;
      if (previous !== sampled) {
        this.values.set(target, sampled);
        changed = true;
      }
    }

    if (changed) this.version += 1;
    return changed;
  }

  /** Total animation duration (for the timeline) */
  getTimelineDuration(): number {
    let duration = 0;
    for (const track of this.keyframeTracks) {
      duration = Math.max(duration, trackDuration(track.Keyframes));
    }
    if (duration <= 0) {
      const timing = computeTiming(this.document.KeyframeAnimations ?? []);
      duration = timing.period;
    }
    return duration > 0 ? duration : 5;
  }

  /** Loop progress (0..1) at the current time, for the timeline cursor */
  getLoopPhase(): number {
    const duration = this.getTimelineDuration();
    if (duration <= 0) return 0;
    const phase = (this.currentTime % duration) / duration;
    return phase < 0 ? phase + 1 : phase;
  }
}
