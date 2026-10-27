/**
 * Live preview panel: drives the preview canvas with a runtime that matches the WPF semantics.
 *
 * - play / pause / stop, scrub the timeline
 * - variable sliders write "external values", equivalent to a PLC / business layer write
 * - shows runtime warnings (undefined variables, expression errors, cyclic dependencies, ...)
 */

import type { AppContext } from './context';
import { el, clear, formatNumber, openModal } from './dom';
import { icon } from './icons';
import { Canvas2DRenderer } from '../engine/canvasRenderer';
import { resolveDocument } from '../engine/resolve';
import { t } from '../i18n';

export function openPreview(ctx: AppContext): void {
  const doc = ctx.store.getDocument();
  const runtime = ctx.runtime;

  const maxWidth = Math.min(760, window.innerWidth * 0.62);
  const maxHeight = Math.min(520, window.innerHeight * 0.6);
  const scale = Math.min(maxWidth / doc.Canvas.Width, maxHeight / doc.Canvas.Height, 2);
  const displayWidth = Math.max(80, doc.Canvas.Width * scale);
  const displayHeight = Math.max(60, doc.Canvas.Height * scale);

  const canvas = el('canvas');
  const canvasWrap = el('div', { class: 'va-preview-canvas-wrap' }, [canvas]);
  const renderer = new Canvas2DRenderer(canvas);
  renderer.resize(displayWidth, displayHeight, window.devicePixelRatio || 1);

  const timeLabel = el('span', { class: 'va-mono', text: '0.00 s' });
  const duration = runtime.getTimelineDuration();
  const scrub = el('input', {
    type: 'range',
    min: 0,
    max: Math.max(0.1, duration),
    step: 0.01,
    value: 0,
    on: {
      input: () => {
        runtime.seek(Number(scrub.value));
        timeLabel.textContent = `${formatNumber(runtime.time, 2)} s`;
        draw();
      },
    },
  });

  const playBtn = el('button', { class: 'va-btn is-primary', html: `${icon('play', 13)}<span>${t('preview.play')}</span>` });
  const stopBtn = el('button', { class: 'va-btn', html: `${icon('stop', 13)}<span>${t('preview.stop')}</span>` });

  const transport = el('div', { class: 'va-transport' }, [playBtn, stopBtn, timeLabel, scrub]);

  const side = el('div', { class: 'va-preview-side' });
  const renderSliders = (): void => {
    clear(side);
    const variables = doc.Variables;
    if (!variables.length) {
      side.append(el('div', { class: 'va-hint', text: t('preview.noVariables') }));
      return;
    }
    side.append(el('div', { class: 'va-panel-header', style: { border: 'none', padding: '0 0 6px' } }, [
      el('span', { html: icon('variable', 13) }),
      el('span', { text: t('preview.inject') }),
    ]));

    for (const variable of variables) {
      const min = variable.Min ?? 0;
      const max = variable.Max ?? Math.max(1, variable.DefaultValue * 2, 100);
      const step = Math.abs(max - min) <= 1 ? 0.01 : Math.abs(max - min) <= 20 ? 0.1 : 1;
      const valueNode = el('span', { class: 'va-slider-value', text: formatNumber(runtime.getVariable(variable.Name), 2) });
      const slider = el('input', {
        type: 'range',
        min: Math.min(min, max),
        max: Math.max(min, max),
        step,
        value: runtime.getVariable(variable.Name),
        on: {
          input: () => {
            const value = Number(slider.value);
            runtime.setVariable(variable.Name, value, true);
            valueNode.textContent = formatNumber(value, 2);
            draw();
          },
        },
      });
      side.append(
        el('div', { class: 'va-slider-row' }, [
          el('div', { class: 'va-slider-row-head' }, [
            el('span', { class: 'va-slider-name', text: variable.Name, title: variable.Description ?? '' }),
            valueNode,
          ]),
          slider,
        ]),
      );
    }

    side.append(
      el('button', {
        class: 'va-btn is-small',
        text: t('preview.clearAll'),
        style: { width: '100%', marginTop: '6px' },
        on: {
          click: () => {
            runtime.clearExternal();
            renderSliders();
            draw();
          },
        },
      }),
    );
  };

  const warnings = el('div', { class: 'va-hint', style: { marginTop: '6px' } });

  const draw = (): void => {
    const shapes = resolveDocument(ctx.store.getDocument(), (name) => runtime.getVariable(name));
    renderer.resize(displayWidth, displayHeight, window.devicePixelRatio || 1);
    renderer.render(shapes, doc.Canvas, { zoom: scale, offsetX: 0, offsetY: 0 }, { border: true });
  };

  const updateWarnings = (): void => {
    const items = runtime.getWarnings();
    if (!items.length) {
      warnings.className = 'va-hint is-ok';
      warnings.textContent = t('preview.noWarnings');
      return;
    }
    warnings.className = 'va-hint is-warn';
    warnings.innerHTML = items.slice(0, 6).map((item) => `⚠ ${escapeHtml(item.message)}`).join('<br/>');
  };

  let raf = 0;
  let last = performance.now();
  const loop = (now: number): void => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    runtime.tick(dt);
    draw();
    timeLabel.textContent = `${formatNumber(runtime.time, 2)} s`;
    if (duration > 0) {
      scrub.value = String(runtime.time % Math.max(0.1, duration));
    }
    raf = requestAnimationFrame(loop);
  };

  const setPlaying = (playing: boolean): void => {
    if (playing) {
      runtime.play();
      last = performance.now();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
      playBtn.innerHTML = `${icon('pause', 13)}<span>${t('preview.pause')}</span>`;
      playBtn.classList.remove('is-primary');
    } else {
      runtime.pause();
      cancelAnimationFrame(raf);
      playBtn.innerHTML = `${icon('play', 13)}<span>${t('preview.play')}</span>`;
      playBtn.classList.add('is-primary');
    }
  };

  playBtn.addEventListener('click', () => setPlaying(!runtime.playing));
  stopBtn.addEventListener('click', () => {
    setPlaying(false);
    runtime.stop();
    draw();
    timeLabel.textContent = '0.00 s';
    scrub.value = '0';
  });

  const stage = el('div', { class: 'va-preview-stage' }, [canvasWrap, transport, warnings]);
  const content = el('div', { class: 'va-preview' }, [stage, side]);

  const handle = openModal({
    title: t('preview.title', { title: doc.Meta?.Title ?? t('app.untitled') }),
    content,
    width: Math.round(displayWidth + 300),
    onClose: () => {
      cancelAnimationFrame(raf);
      runtime.pause();
      ctx.refreshCanvas();
    },
  });

  renderSliders();
  updateWarnings();
  draw();
  // Auto-play once so the effect is visible immediately
  if (doc.ExpressionAnimations.some((item) => item.Enabled) || doc.KeyframeAnimations.some((item) => item.Enabled !== false)) {
    setPlaying(true);
  }

  window.setTimeout(() => handle.root.classList.add('is-ready'), 0);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] ?? char));
}
