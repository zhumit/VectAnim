/**
 * Variables panel: CRUD over the variable table plus live-value sliders.
 *
 * Slider input writes the runtime "external value", which is equivalent to a PLC / business
 * layer write and lets you verify the data-driven behaviour.
 */

import type { VariableDef } from '../schema/types';
import type { AppContext } from './context';
import { el, clear, promptDialog, confirmDialog, formatNumber, openMenu } from './dom';
import { icon } from './icons';
import {
  addVariable,
  updateVariable,
  removeVariable,
  renameVariable,
  collectVariableUsages,
} from '../editor/commands';
import { createVariable } from '../schema/factory';
import { t } from '../i18n';

export class VariablesPanel {
  private readonly body: HTMLElement;

  constructor(private readonly ctx: AppContext, host: HTMLElement) {
    const header = el('div', { class: 'va-panel-header' }, [
      el('span', { html: icon('variable', 14) }),
      el('span', { text: t('variables.title') }),
      el('span', { style: { flex: '1' } }),
      el('button', {
        class: 'va-icon-btn',
        title: t('variables.add'),
        html: icon('plus', 15),
        style: { width: '22px', height: '22px' },
        on: { click: () => this.createVariable() },
      }),
    ]);
    this.body = el('div', { class: 'va-panel-body' });
    host.append(el('div', { class: 'va-panel', style: { flex: '1', minHeight: '0' } }, [header, this.body]));
  }

  render(): void {
    const doc = this.ctx.store.getDocument();
    clear(this.body);

    if (!doc.Variables.length) {
      this.body.append(
        el('div', { class: 'va-empty' }, [
          el('div', { text: t('variables.empty') }),
          el('div', { text: t('variables.emptyHint'), style: { fontSize: '11px', marginTop: '6px' } }),
          el('button', {
            class: 'va-btn is-primary',
            text: t('variables.createFirst'),
            style: { marginTop: '12px' },
            on: { click: () => this.createVariable() },
          }),
        ]),
      );
      return;
    }

    for (const variable of doc.Variables) this.body.append(this.renderVariable(variable));

    this.body.append(
      el('div', { class: 'va-hint', style: { marginTop: '8px' }, text: t('variables.colorHint') }),
    );
  }

  private renderVariable(variable: VariableDef): HTMLElement {
    const usages = collectVariableUsages(this.ctx.store.getDocument(), variable.Name);

    const nameInput = el('input', {
      class: 'va-var-name',
      type: 'text',
      value: variable.Name,
      title: t('variables.renameTip'),
      on: {
        change: () => {
          const result = renameVariable(this.ctx.store, variable.Name, nameInput.value);
          if (!result.ok) {
            this.ctx.notify(result.message ?? t('variables.renameFailed'), 'error');
            nameInput.value = variable.Name;
          } else {
            this.ctx.notify(t('variables.renamed'), 'success');
          }
        },
      },
    });

    const defaultInput = numberField(variable.DefaultValue, (value) => updateVariable(this.ctx.store, variable.Name, { DefaultValue: value }));
    const minInput = numberField(variable.Min, (value) => updateVariable(this.ctx.store, variable.Name, { Min: value }), true);
    const maxInput = numberField(variable.Max, (value) => updateVariable(this.ctx.store, variable.Name, { Max: value }), true);
    const unitInput = el('input', {
      type: 'text',
      value: variable.Unit ?? '',
      placeholder: t('variables.unitPlaceholder'),
      on: { change: () => updateVariable(this.ctx.store, variable.Name, { Unit: unitInput.value.trim() || undefined }) },
    });
    const descInput = el('input', {
      type: 'text',
      value: variable.Description ?? '',
      placeholder: t('variables.notePlaceholder'),
      on: { change: () => updateVariable(this.ctx.store, variable.Name, { Description: descInput.value }) },
    });

    const range = rangeOf(variable);
    const currentValue = this.ctx.runtime.getVariable(variable.Name);

    const valueText = el('span', { class: 'va-var-value-num', text: formatNumber(currentValue, variable.Decimals ?? 2) });
    const slider = el('input', {
      type: 'range',
      min: range.min,
      max: range.max,
      step: range.step,
      value: currentValue,
      on: {
        input: () => {
          const value = Number(slider.value);
          this.ctx.runtime.setVariable(variable.Name, value, true);
          valueText.textContent = formatNumber(value, variable.Decimals ?? 2);
          this.ctx.refreshCanvas();
        },
      },
    });

    const externalBadge = this.ctx.runtime.isExternallyDriven(variable.Name)
      ? el('span', { class: 'va-chip is-accent', text: t('variables.external'), title: t('variables.externalTip') })
      : null;

    const head = el('div', { class: 'va-var-head' }, [
      nameInput,
      externalBadge,
      el('button', {
        class: 'va-icon-btn',
        title: t('variables.more'),
        html: icon('settings', 14),
        style: { width: '20px', height: '20px' },
        on: {
          click: () => openMenu(head, [
            {
              label: t('variables.resetDefault'),
              onSelect: () => {
                this.ctx.runtime.setVariable(variable.Name, variable.DefaultValue, false);
                this.ctx.runtime.clearExternal(variable.Name);
                this.ctx.refresh();
              },
            },
            {
              label: t('variables.clearExternal'),
              hint: this.ctx.runtime.isExternallyDriven(variable.Name) ? t('variables.active') : '',
              onSelect: () => {
                this.ctx.runtime.clearExternal(variable.Name);
                this.ctx.refresh();
              },
            },
            { separator: true, label: '' },
            {
              label: t('common.delete'),
              danger: true,
              onSelect: async () => {
                const ok = await confirmDialog({
                  title: t('variables.deleteTitle', { name: variable.Name }),
                  message: usages.length
                    ? t('variables.deleteUsed', { count: usages.length, list: usages.slice(0, 8).join('\n') })
                    : t('variables.deleteUnused'),
                  confirmText: t('common.delete'),
                  danger: true,
                });
                if (!ok) return;
                removeVariable(this.ctx.store, variable.Name);
                this.ctx.notify(t('variables.deleted', { name: variable.Name }), 'success');
              },
            },
          ], { align: 'right', width: 200 }),
        },
      }),
    ]);

    const grid = el('div', { class: 'va-var-grid' }, [
      el('div', { class: 'va-var-field' }, [el('label', { text: t('variables.default') }), defaultInput]),
      el('div', { class: 'va-var-field' }, [el('label', { text: t('variables.unit') }), unitInput]),
      el('div', { class: 'va-var-field' }, [el('label', { text: t('variables.min') }), minInput]),
      el('div', { class: 'va-var-field' }, [el('label', { text: t('variables.max') }), maxInput]),
    ]);

    const container = el('div', { class: 'va-var' }, [
      head,
      grid,
      el('div', { class: 'va-var-field', style: { marginTop: '4px' } }, [el('label', { text: t('variables.note') }), descInput]),
      el('div', { class: 'va-var-value' }, [slider, valueText]),
    ]);

    if (usages.length) {
      container.append(
        el('div', {
          class: 'va-var-usage',
          text: t('variables.usage', {
            count: usages.length,
            list: usages.slice(0, 3).join(', '),
            more: usages.length > 3 ? ' …' : '',
          }),
        }),
      );
    }

    return container;
  }

  private async createVariable(): Promise<void> {
    const doc = this.ctx.store.getDocument();
    const name = await promptDialog({
      title: t('variables.newTitle'),
      label: t('variables.newLabel'),
      defaultValue: `Var${doc.Variables.length + 1}`,
      validate: (value) => {
        if (!value) return t('props.errorNameEmpty');
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return t('props.errorNamePattern');
        if (doc.Variables.some((item) => item.Name === value)) return t('props.errorNameExists');
        return undefined;
      },
    });
    if (!name) return;
    const created = addVariable(this.ctx.store, createVariable(name, 0, { Description: '', Min: 0, Max: 100 }));
    if (created) this.ctx.notify(t('variables.created', { name }), 'success');
  }
}

function numberField(value: number | undefined, onChange: (value: number | undefined) => void, allowEmpty = false): HTMLInputElement {
  const input = el('input', {
    type: 'number',
    value: value === undefined ? '' : formatNumber(value, 3),
    placeholder: allowEmpty ? '—' : '',
    step: 1,
    on: {
      change: () => {
        const raw = input.value.trim();
        if (raw === '') {
          if (allowEmpty) onChange(undefined);
          return;
        }
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) onChange(parsed);
      },
    },
  });
  return input;
}

function rangeOf(variable: VariableDef): { min: number; max: number; step: number } {
  const min = variable.Min ?? 0;
  const max = variable.Max ?? (variable.DefaultValue > 0 ? variable.DefaultValue * 2 : 100);
  const span = Math.abs(max - min);
  const step = span <= 1 ? 0.01 : span <= 20 ? 0.1 : span <= 400 ? 1 : 10;
  return { min: Math.min(min, max), max: Math.max(min, max), step };
}
