/**
 * Animations panel: expression animations plus a keyframe timeline.
 *
 * Expression animations: target variable + expression (supports t, variables and whitelisted
 * functions), validated live while typing.
 * Keyframe animations: a visual timeline; drag diamonds to retime, click empty space to add a
 * keyframe, easing is selectable.
 */

import type { EasingKind, ExpressionAnimationDef, KeyframeAnimationDef } from '../schema/types';
import { EASING_KINDS } from '../schema/types';
import type { AppContext } from './context';
import { el, clear, formatNumber, dragify, openMenu, openModal } from './dom';
import { icon } from './icons';
import {
  addExpressionAnimation,
  addKeyframeAnimation,
  addKeyframe,
  removeExpressionAnimation,
  removeKeyframe,
  removeKeyframeAnimation,
  updateExpressionAnimation,
  updateKeyframe,
  updateKeyframeAnimation,
} from '../editor/commands';
import { createExpressionAnimation, createKeyframeAnimation, createVariable } from '../schema/factory';
import { addVariable } from '../editor/commands';
import { checkExpression, functionNames } from '../engine/expression';
import { buildTimeTicks, sampleKeyframes, trackDuration } from '../engine/keyframes';
import { listBindings, listGroupBindings } from '../editor/props';
import { t } from '../i18n';

export class AnimationsPanel {
  private readonly body: HTMLElement;

  constructor(private readonly ctx: AppContext, host: HTMLElement) {
    const header = el('div', { class: 'va-panel-header' }, [
      el('span', { html: icon('clock', 14) }),
      el('span', { text: t('animations.title') }),
      el('span', { style: { flex: '1' } }),
      el('button', {
        class: 'va-icon-btn',
        title: t('animations.addExpression'),
        html: icon('expression', 15),
        style: { width: '22px', height: '22px' },
        on: { click: () => this.createExpression() },
      }),
      el('button', {
        class: 'va-icon-btn',
        title: t('animations.addKeyframes'),
        html: icon('keyframe', 15),
        style: { width: '22px', height: '22px' },
        on: { click: () => this.createKeyframes() },
      }),
    ]);
    this.body = el('div', { class: 'va-panel-body' });
    host.append(el('div', { class: 'va-panel', style: { flex: '1', minHeight: '0' } }, [header, this.body]));
  }

  render(): void {
    const doc = this.ctx.store.getDocument();
    clear(this.body);

    const related = this.relatedAnimations();

    if (related.variables.size) {
      this.body.append(
        el('div', { class: 'va-section-head', style: { background: 'transparent', padding: '0 2px 4px' } }, [
          el('span', { text: t('animations.related') }),
          el('span', { class: 'va-count', text: String(related.items.length) }),
        ]),
      );
      if (!related.items.length) {
        this.body.append(el('div', { class: 'va-hint', text: t('animations.relatedEmpty') }));
      }
      for (const item of related.items) this.body.append(this.renderRelatedRow(item));
    }

    this.body.append(
      el('div', { class: 'va-section-head', style: { background: 'transparent', padding: '0 2px 4px' } }, [
        el('span', { text: t('animations.expressions') }),
        el('span', { class: 'va-count', text: String(doc.ExpressionAnimations.length) }),
      ]),
    );
    if (!doc.ExpressionAnimations.length) {
      this.body.append(el('div', { class: 'va-hint', text: t('animations.emptyExpression') }));
    }
    for (const animation of doc.ExpressionAnimations) this.body.append(this.renderExpression(animation));

    this.body.append(
      el('div', { class: 'va-section-head', style: { background: 'transparent', padding: '10px 2px 4px' } }, [
        el('span', { text: t('animations.keyframes') }),
        el('span', { class: 'va-count', text: String(doc.KeyframeAnimations.length) }),
      ]),
    );
    if (!doc.KeyframeAnimations.length) {
      this.body.append(el('div', { class: 'va-hint', text: t('animations.emptyKeyframes') }));
    }
    for (const animation of doc.KeyframeAnimations) this.body.append(this.renderKeyframes(animation));

    this.body.append(
      el('div', {
        class: 'va-hint',
        style: { marginTop: '10px' },
        html: t('animations.functionsHint', { list: functionNames().join(', ') }),
      }),
    );
  }

  /* ------------------------------------------------------------------ *
   * Animations related to the current selection
   * ------------------------------------------------------------------ */

  /**
   * Variables driven by the current selection (shape bindings, plus the group bindings when the
   * selection is exactly one group) and every animation that targets one of them.
   */
  private relatedAnimations(): {
    variables: Set<string>;
    items: Array<{ id: string; kind: 'expression' | 'keyframes'; variable: string; detail: string }>;
  } {
    const doc = this.ctx.store.getDocument();
    const shapes = this.ctx.store.getSelectedShapes();
    const variables = new Set<string>();
    for (const shape of shapes) {
      for (const binding of listBindings(shape)) variables.add(binding.variable);
    }

    const selected = new Set(shapes.map((shape) => shape.Id));
    for (const group of doc.Groups ?? []) {
      const isWholeGroup =
        group.ShapeIds.length > 1 &&
        group.ShapeIds.length === selected.size &&
        group.ShapeIds.every((id) => selected.has(id));
      if (isWholeGroup) {
        for (const binding of listGroupBindings(group)) variables.add(binding.variable);
      }
    }

    const items: Array<{ id: string; kind: 'expression' | 'keyframes'; variable: string; detail: string }> = [];
    for (const animation of doc.ExpressionAnimations) {
      if (!variables.has(animation.TargetVariable)) continue;
      items.push({
        id: animation.Id,
        kind: 'expression',
        variable: animation.TargetVariable,
        detail: animation.Expression,
      });
    }
    for (const animation of doc.KeyframeAnimations) {
      if (!variables.has(animation.TargetVariable)) continue;
      items.push({
        id: animation.Id,
        kind: 'keyframes',
        variable: animation.TargetVariable,
        detail: t('animations.keyframeCount', { count: animation.Keyframes.length }),
      });
    }

    return { variables, items };
  }

  private renderRelatedRow(item: { id: string; kind: 'expression' | 'keyframes'; variable: string; detail: string }): HTMLElement {
    return el('div', {
      class: 'va-list-row',
      style: { cursor: 'pointer' },
      title: t('animations.jumpTo'),
      on: {
        click: () => {
          const card = this.body.querySelector<HTMLElement>(`[data-animation-id="${item.id}"]`);
          if (!card) return;
          card.scrollIntoView({ block: 'center', behavior: 'smooth' });
          card.classList.add('is-flash');
          window.setTimeout(() => card.classList.remove('is-flash'), 900);
        },
      },
    }, [
      el('span', { class: 'va-chip', text: item.kind === 'expression' ? t('animations.kindExpression') : t('animations.kindKeyframes') }),
      el('span', { class: 'va-row-label', text: item.variable, style: { flex: '1' } }),
      el('span', { class: 'va-hint', text: item.detail, style: { maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }),
    ]);
  }

  /* ------------------------------------------------------------------ *
   * Expression animations
   * ------------------------------------------------------------------ */

  private renderExpression(animation: ExpressionAnimationDef): HTMLElement {
    const doc = this.ctx.store.getDocument();
    const check = checkExpression(animation.Expression);

    const targetSelect = this.variableSelect(animation.TargetVariable, (value) =>
      updateExpressionAnimation(this.ctx.store, animation.Id, { TargetVariable: value }));

    const input = el('input', {
      class: 'va-expr-input',
      type: 'text',
      value: animation.Expression,
      placeholder: t('animations.expressionPlaceholder'),
      on: {
        change: () => updateExpressionAnimation(this.ctx.store, animation.Id, { Expression: input.value }),
      },
    });

    const hint = el('div', {
      class: `va-hint ${check.ok ? 'is-ok' : 'is-error'}`,
      text: check.ok
        ? `${t('animations.valid')}${check.usesTime ? t('animations.usesTime') : ''}${check.variables.length ? t('animations.depends', { vars: check.variables.join(', ') }) : ''}`
        : `✗ ${check.message}`,
    });

    if (check.ok) {
      const missing = check.variables.filter((name) => !doc.Variables.some((variable) => variable.Name === name));
      if (missing.length) {
        hint.className = 'va-hint is-warn';
        hint.textContent = t('animations.missingVariables', { vars: missing.join(', ') });
      }
    }

    const enabled = el('input', {
      type: 'checkbox',
      checked: animation.Enabled,
      title: t('animations.enabled'),
      on: { change: () => updateExpressionAnimation(this.ctx.store, animation.Id, { Enabled: enabled.checked }) },
    });

    const wrap = el('input', {
      type: 'number',
      value: animation.Wrap ?? '',
      placeholder: '—',
      title: t('animations.wrapTip'),
      style: { width: '64px' },
      on: {
        change: () => {
          const value = Number(wrap.value);
          updateExpressionAnimation(this.ctx.store, animation.Id, { Wrap: Number.isFinite(value) && value > 0 ? value : undefined });
        },
      },
    });

    return el('div', { class: 'va-anim', dataset: { animationId: animation.Id } }, [
      el('div', { class: 'va-anim-head' }, [
        el('span', { html: icon('expression', 13), style: { color: 'var(--accent)' } }),
        el('span', { class: 'va-anim-title', text: t('animations.expressionTitle') }),
        enabled,
        el('button', {
          class: 'va-icon-btn',
          title: t('common.delete'),
          html: icon('trash', 13),
          style: { width: '20px', height: '20px' },
          on: { click: () => removeExpressionAnimation(this.ctx.store, animation.Id) },
        }),
      ]),
      el('div', { class: 'va-anim-body' }, [
        el('div', { class: 'va-row', style: { gridTemplateColumns: '48px 1fr auto' } }, [
          el('span', { class: 'va-row-label', text: t('animations.target') }),
          targetSelect,
          el('span'),
        ]),
        input,
        hint,
        el('div', { class: 'va-row', style: { gridTemplateColumns: '48px 1fr auto' } }, [
          el('span', { class: 'va-row-label', text: t('animations.wrap') }),
          wrap,
          el('span', { class: 'va-hint', text: t('animations.wrapEmpty') }),
        ]),
      ]),
    ]);
  }

  /* ------------------------------------------------------------------ *
   * Keyframe animations
   * ------------------------------------------------------------------ */

  private renderKeyframes(animation: KeyframeAnimationDef): HTMLElement {
    const duration = Math.max(0.5, trackDuration(animation.Keyframes));
    const targetSelect = this.variableSelect(animation.TargetVariable, (value) =>
      updateKeyframeAnimation(this.ctx.store, animation.Id, { TargetVariable: value }));

    const loop = el('input', {
      type: 'checkbox',
      checked: animation.Loop,
      title: t('animations.loopTip'),
      on: { change: () => updateKeyframeAnimation(this.ctx.store, animation.Id, { Loop: loop.checked }) },
    });

    const nameInput = el('input', {
      type: 'text',
      value: animation.Name,
      style: { flex: '1', height: '20px', fontSize: '11.5px' },
      on: { change: () => updateKeyframeAnimation(this.ctx.store, animation.Id, { Name: nameInput.value }) },
    });

    const timeline = this.buildTimeline(animation, duration);

    const addBtn = el('button', {
      class: 'va-btn is-small',
      text: t('animations.addFrame'),
      on: {
        click: () => {
          const last = animation.Keyframes[animation.Keyframes.length - 1];
          const time = last ? Math.round((last.Time + 0.5) * 100) / 100 : 0;
          const value = last ? last.Value : this.ctx.runtime.getVariable(animation.TargetVariable);
          addKeyframe(this.ctx.store, animation.Id, { Time: time, Value: value, Easing: 'EaseInOut' });
        },
      },
    });

    const loopDelay = el('input', {
      type: 'number',
      value: animation.LoopDelay ?? 0,
      step: 0.1,
      min: 0,
      style: { width: '58px' },
      title: t('animations.loopDelay'),
      on: { change: () => updateKeyframeAnimation(this.ctx.store, animation.Id, { LoopDelay: Math.max(0, Number(loopDelay.value) || 0) }) },
    });

    return el('div', { class: 'va-anim', dataset: { animationId: animation.Id } }, [
      el('div', { class: 'va-anim-head' }, [
        el('span', { html: icon('keyframe', 13), style: { color: 'var(--accent)' } }),
        nameInput,
        loop,
        el('span', { class: 'va-hint', text: t('animations.loopLabel') }),
        loopDelay,
        el('button', {
          class: 'va-icon-btn',
          title: t('animations.deleteAnimation'),
          html: icon('trash', 13),
          style: { width: '20px', height: '20px' },
          on: { click: () => removeKeyframeAnimation(this.ctx.store, animation.Id) },
        }),
      ]),
      el('div', { class: 'va-anim-body' }, [
        el('div', { class: 'va-row', style: { gridTemplateColumns: '48px 1fr auto' } }, [
          el('span', { class: 'va-row-label', text: t('animations.target') }),
          targetSelect,
          el('span', { class: 'va-chip', text: `${formatNumber(duration, 2)}s` }),
        ]),
        timeline,
        el('div', { class: 'va-toolbar-row' }, [addBtn]),
      ]),
    ]);
  }

  private buildTimeline(animation: KeyframeAnimationDef, duration: number): HTMLElement {
    const container = el('div', { class: 'va-timeline' });
    const ticks = el('div', { class: 'va-timeline-ticks' });
    container.append(ticks);

    const paint = (): void => {
      clear(ticks);
      for (const tick of buildTimeTicks(duration, 6)) {
        const left = `${(tick / duration) * 100}%`;
        ticks.append(el('div', { class: 'va-timeline-tick', style: { left } }));
        ticks.append(el('div', { class: 'va-timeline-tick-label', text: `${tick}s`, style: { left } }));
      }
    };
    paint();

    const lane = el('div', { class: 'va-timeline-lane' });
    container.append(lane);

    const frames = animation.Keyframes;
    frames.forEach((frame, index) => {
      const key = el('div', {
        class: 'va-timeline-key',
        style: { left: `${(frame.Time / duration) * 100}%` },
        title: `t=${formatNumber(frame.Time, 2)}s  v=${formatNumber(frame.Value, 2)}`,
        dataset: { index: String(index) },
        on: {
          dblclick: (event) => {
            event.stopPropagation();
            openMenu(key, [
              {
                label: t('animations.editValue'),
                onSelect: () => this.promptKeyframeValue(animation, index),
              },
              { label: t('animations.deleteKeyframe'), danger: true, onSelect: () => removeKeyframe(this.ctx.store, animation.Id, index) },
            ]);
          },
          contextmenu: (event) => {
            event.preventDefault();
            openMenu(key, [
              { label: t('animations.editValue'), onSelect: () => this.promptKeyframeValue(animation, index) },
              { label: t('animations.deleteKeyframe'), danger: true, onSelect: () => removeKeyframe(this.ctx.store, animation.Id, index) },
            ]);
          },
        },
      }, [
        el('span', { class: 'va-timeline-key-value', text: formatNumber(frame.Value, 1) }),
      ]);
      lane.append(key);

      let startTime = frame.Time;
      dragify(key, {
        onStart: (event) => {
          event.stopPropagation();
          startTime = frame.Time;
          container.dataset.dragging = '1';
        },
        onMove: (event) => {
          const rect = lane.getBoundingClientRect();
          if (rect.width <= 0) return;
          const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
          const next = Math.round(ratio * duration * 100) / 100;
          key.style.left = `${(next / duration) * 100}%`;
          key.dataset.time = String(next);
        },
        onEnd: () => {
          delete container.dataset.dragging;
          const time = Number(key.dataset.time ?? startTime);
          if (Number.isFinite(time) && time !== frame.Time) {
            updateKeyframe(this.ctx.store, animation.Id, index, { Time: time });
          }
        },
      });
    });

    // Clicking empty space adds a keyframe
    container.addEventListener('click', (event) => {
      if (container.dataset.dragging) return;
      const target = event.target as HTMLElement;
      if (target.classList.contains('va-timeline-key') || target.closest('.va-timeline-key')) return;
      const rect = lane.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const time = Math.round(ratio * duration * 100) / 100;
      const sampled = sampleKeyframes(animation.Keyframes, time, false, 0) ?? this.ctx.runtime.getVariable(animation.TargetVariable);
      addKeyframe(this.ctx.store, animation.Id, { Time: time, Value: Math.round(sampled * 100) / 100, Easing: 'EaseInOut' });
    });

    // Playhead
    const phase = duration > 0 ? (this.ctx.runtime.time % duration) / duration : 0;
    container.append(el('div', { class: 'va-timeline-playhead', style: { left: `${phase * 100}%` } }));

    return container;
  }

  private promptKeyframeValue(animation: KeyframeAnimationDef, index: number): void {
    const frame = animation.Keyframes[index];
    if (!frame) return;
    const content = el('div', { style: { display: 'grid', gap: '6px' } }, [
      el('div', { class: 'va-row' }, [
        el('span', { class: 'va-row-label', text: t('animations.time') }),
        el('input', {
          type: 'number', step: 0.05, min: 0, value: formatNumber(frame.Time, 2),
          on: { change: (event) => updateKeyframe(this.ctx.store, animation.Id, index, { Time: Math.max(0, Number((event.target as HTMLInputElement).value)) }) },
        }),
        el('span'),
      ]),
      el('div', { class: 'va-row' }, [
        el('span', { class: 'va-row-label', text: t('animations.value') }),
        el('input', {
          type: 'number', step: 1, value: formatNumber(frame.Value, 3),
          on: { change: (event) => updateKeyframe(this.ctx.store, animation.Id, index, { Value: Number((event.target as HTMLInputElement).value) }) },
        }),
        el('span'),
      ]),
      el('div', { class: 'va-row' }, [
        el('span', { class: 'va-row-label', text: t('animations.easing') }),
        el('select', {
          on: { change: (event) => updateKeyframe(this.ctx.store, animation.Id, index, { Easing: (event.target as HTMLSelectElement).value as EasingKind }) },
        }, EASING_KINDS.map((kind) => el('option', { value: kind, text: easingLabel(kind), selected: (frame.Easing ?? 'Linear') === kind }))),
        el('span'),
      ]),
    ]);

    const handle = openModal({ title: t('animations.keyframeTitle'), content, width: 380 });
    void handle;
  }

  /* ------------------------------------------------------------------ *
   * Creation
   * ------------------------------------------------------------------ */

  private variableSelect(value: string, onChange: (value: string) => void): HTMLSelectElement {
    const doc = this.ctx.store.getDocument();
    const select = el('select', {
      style: { width: '100%' },
      on: { change: () => onChange(select.value) },
    }, doc.Variables.map((variable) =>
      el('option', { value: variable.Name, text: variable.Name, selected: variable.Name === value }),
    ));

    if (!doc.Variables.some((variable) => variable.Name === value)) {
      select.prepend(el('option', { value, text: t('animations.undefinedVariable', { name: value }), selected: true }));
    }
    return select;
  }

  private ensureVariable(): string | null {
    const doc = this.ctx.store.getDocument();
    if (!doc.Variables.length) {
      const name = 'AnimatedValue';
      addVariable(this.ctx.store, createVariable(name, 0, { Description: t('animations.autoCreated') }));
      return name;
    }
    return doc.Variables[0].Name;
  }

  private createExpression(): void {
    const target = this.ensureVariable();
    if (!target) return;
    addExpressionAnimation(this.ctx.store, createExpressionAnimation(target, '0'));
    this.ctx.notify(t('animations.createdExpression'), 'success');
  }

  private createKeyframes(): void {
    const target = this.ensureVariable();
    if (!target) return;
    addKeyframeAnimation(this.ctx.store, createKeyframeAnimation(target));
    this.ctx.notify(t('animations.createdKeyframes'), 'success');
  }
}

function easingLabel(kind: EasingKind): string {
  switch (kind) {
    case 'Linear':
      return t('animations.easingLinear');
    case 'Step':
      return t('animations.easingStep');
    case 'EaseIn':
      return t('animations.easingIn');
    case 'EaseOut':
      return t('animations.easingOut');
    case 'EaseInOut':
      return t('animations.easingInOut');
    default:
      return kind;
  }
}
