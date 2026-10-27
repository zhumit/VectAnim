/**
 * Layers / groups panel.
 *
 * Structure: groups first (collapsible), then ungrouped shapes ordered by ZIndex descending
 * (topmost first).
 * Interaction: single click selects (selecting a group selects all members), double click
 * renames, the eye icon toggles visibility.
 */

import type { GroupDef, Shape } from '../schema/types';
import type { AppContext } from './context';
import { el, clear, openMenu, confirmDialog } from './dom';
import { icon } from './icons';
import {
  deleteShapes,
  groupShapes,
  ungroupShapes,
  ungroupGroup,
  reorderShapes,
  setGroupVisible,
  setShapeVisible,
  renameGroup,
  renameShape,
} from '../editor/commands';
import { listBindings } from '../editor/props';
import { t } from '../i18n';

const TYPE_BADGE: Record<Shape['Type'], string> = {
  Line: 'layers.badgeLine',
  Rectangle: 'layers.badgeRect',
  Ellipse: 'layers.badgeEllipse',
  Polygon: 'layers.badgePolygon',
  Path: 'layers.badgePath',
};

export class LayersPanel {
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly headerCount: HTMLElement;
  private collapsed = new Set<string>();

  constructor(private readonly ctx: AppContext, host: HTMLElement) {
    this.headerCount = el('span', { class: 'va-count' });

    const header = el('div', { class: 'va-panel-header' }, [
      el('span', { html: icon('layers', 14) }),
      el('span', { text: t('layers.title') }),
      this.headerCount,
      el('span', { style: { flex: '1' } }),
      this.actionButton('group', t('layers.group'), () => this.groupSelection()),
      this.actionButton('ungroup', t('layers.ungroup'), () => this.ungroupSelection()),
      this.actionButton('trash', t('layers.delete'), () => this.deleteSelection()),
    ]);

    this.list = el('div', { class: 'va-panel-body' });
    this.root = el('div', { class: 'va-panel va-panel-left' }, [header, this.list]);
    host.append(this.root);
  }

  private actionButton(iconName: string, title: string, handler: () => void): HTMLElement {
    return el('button', {
      class: 'va-icon-btn',
      title,
      html: icon(iconName, 14),
      style: { width: '22px', height: '22px' },
      on: { click: handler },
    });
  }

  private groupSelection(): void {
    const ids = [...this.ctx.store.getSelection()];
    if (ids.length < 2) {
      this.ctx.notify(t('layers.needTwo'), 'warning');
      return;
    }
    groupShapes(this.ctx.store, ids);
    this.ctx.notify(t('layers.grouped', { count: ids.length }), 'success');
  }

  private ungroupSelection(): void {
    const ids = [...this.ctx.store.getSelection()];
    ungroupShapes(this.ctx.store, ids);
  }

  private deleteSelection(): void {
    const ids = [...this.ctx.store.getSelection()];
    if (!ids.length) return;
    deleteShapes(this.ctx.store, ids);
  }

  render(): void {
    const doc = this.ctx.store.getDocument();
    const selection = new Set(this.ctx.store.getSelection());
    clear(this.list);
    this.headerCount.textContent = t('layers.count', { shapes: doc.Shapes.length, groups: doc.Groups.length });

    if (!doc.Shapes.length) {
      this.list.append(
        el('div', { class: 'va-empty' }, [
          el('div', { text: t('layers.empty') }),
          el('div', { text: t('layers.emptyHint'), style: { fontSize: '11px' } }),
        ]),
      );
      return;
    }

    const sorted = [...doc.Shapes].sort((a, b) => (a.ZIndex === b.ZIndex ? 0 : b.ZIndex - a.ZIndex));
    const grouped = new Map<string, Shape[]>();
    const groupOfShape = new Map<string, GroupDef>();
    for (const group of doc.Groups) {
      for (const id of group.ShapeIds) groupOfShape.set(id, group);
    }
    for (const shape of sorted) {
      const group = groupOfShape.get(shape.Id);
      const key = group ? group.GroupId : '__ungrouped__';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(shape);
    }

    for (const group of doc.Groups) {
      const members = grouped.get(group.GroupId) ?? [];
      if (!members.length) continue;
      this.list.append(this.renderGroup(group, members, selection));
    }

    const ungrouped = grouped.get('__ungrouped__') ?? [];
    for (const shape of ungrouped) {
      this.list.append(this.renderShapeRow(shape, selection, false));
    }
  }

  private renderGroup(group: GroupDef, members: Shape[], selection: Set<string>): HTMLElement {
    const isCollapsed = this.collapsed.has(group.GroupId);
    const allSelected = members.every((shape) => selection.has(shape.Id));

    const visibilityBtn = el('button', {
      class: 'va-icon-btn',
      title: group.Visible ? t('layers.hideGroup') : t('layers.showGroup'),
      html: icon(group.Visible ? 'eye' : 'eyeOff', 13),
      style: { width: '20px', height: '20px', opacity: group.Visible ? '1' : '0.5' },
      on: {
        click: (event) => {
          event.stopPropagation();
          setGroupVisible(this.ctx.store, group.GroupId, !group.Visible);
        },
      },
    });

    const chevron = el('button', {
      class: 'va-icon-btn',
      html: icon(isCollapsed ? 'chevronRight' : 'chevronDown', 13),
      style: { width: '18px', height: '20px' },
      on: {
        click: (event) => {
          event.stopPropagation();
          if (isCollapsed) this.collapsed.delete(group.GroupId);
          else this.collapsed.add(group.GroupId);
          this.render();
        },
      },
    });

    const title = el('span', {
      class: 'va-layer-name',
      text: group.Name,
      title: t('layers.renameHint'),
      on: {
        // A double click cannot be detected with `dblclick` here: the first click selects the
        // group, which rebuilds this list and swaps the node out before the second click lands.
        // `click` with detail === 2 survives that, because the freshly rendered span gets the
        // same handler.
        click: (event) => {
          const mouse = event as MouseEvent;
          if (mouse.detail !== 2) return;
          mouse.stopPropagation();
          mouse.preventDefault();
          this.inlineRename(title, group.Name, (value) => renameGroup(this.ctx.store, group.GroupId, value));
        },
      },
    });

    const header = el('div', {
      class: `va-layer-group-header${allSelected ? ' is-selected' : ''}`,
      on: {
        click: () => this.ctx.selectGroup(group.GroupId),
        contextmenu: (event) => {
          event.preventDefault();
          openMenu(header, [
            { label: t('layers.selectGroup'), onSelect: () => this.ctx.selectGroup(group.GroupId) },
            { label: t('layers.ungroupMenu'), onSelect: () => ungroupGroup(this.ctx.store, group.GroupId) },
            { label: group.Visible ? t('layers.hideGroup') : t('layers.showGroup'), onSelect: () => setGroupVisible(this.ctx.store, group.GroupId, !group.Visible) },
            { separator: true, label: '' },
            {
              label: t('layers.dissolve'),
              danger: true,
              onSelect: async () => {
                const ok = await confirmDialog({
                  title: t('layers.deleteGroupTitle'),
                  message: t('layers.deleteGroupMessage', { name: group.Name, count: members.length }),
                  confirmText: t('common.delete'),
                  danger: true,
                });
                if (ok) deleteShapes(this.ctx.store, members.map((shape) => shape.Id));
              },
            },
          ]);
        },
      },
    }, [
      chevron,
      visibilityBtn,
      el('span', { html: icon('folder', 13), style: { color: 'var(--text-2)' } }),
      title,
      el('span', { class: 'va-layer-badge', text: String(members.length) }),
    ]);

    const container = el('div', { class: 'va-layer-group' }, [header]);
    if (!isCollapsed) {
      const children = el('div', { class: 'va-layer-children' });
      for (const shape of members) children.append(this.renderShapeRow(shape, selection, true));
      container.append(children);
    }
    return container;
  }

  private renderShapeRow(shape: Shape, selection: Set<string>, insideGroup: boolean): HTMLElement {
    const isSelected = selection.has(shape.Id);
    const bindings = listBindings(shape);

    const visibilityBtn = el('button', {
      class: 'va-icon-btn',
      title: shape.IsVisible ? t('layers.hide') : t('layers.show'),
      html: icon(shape.IsVisible ? 'eye' : 'eyeOff', 13),
      style: { width: '20px', height: '20px', opacity: shape.IsVisible ? '1' : '0.5' },
      on: {
        click: (event) => {
          event.stopPropagation();
          setShapeVisible(this.ctx.store, shape.Id, !shape.IsVisible);
        },
      },
    });

    const nameNode = el('span', {
      class: 'va-layer-name',
      text: shape.Name,
      title: `${shape.Name}  ·  ${shape.Type}  ·  Z=${shape.ZIndex}`,
      on: {
        // See the group header: `dblclick` never fires because the row is re-rendered after
        // the first click, so the second click is counted here instead.
        click: (event) => {
          const mouse = event as MouseEvent;
          if (mouse.detail !== 2) return;
          mouse.stopPropagation();
          mouse.preventDefault();
          this.inlineRename(nameNode, shape.Name, (value) => renameShape(this.ctx.store, shape.Id, value));
        },
      },
    });

    const row = el('div', {
      class: `va-layer${isSelected ? ' is-selected' : ''}${shape.IsVisible ? '' : ' is-hidden'}`,
      dataset: { shapeId: shape.Id },
      on: {
        click: (event) => {
          const mouse = event as MouseEvent;
          if (mouse.shiftKey || mouse.ctrlKey || mouse.metaKey) {
            const next = new Set(selection);
            if (next.has(shape.Id)) next.delete(shape.Id);
            else next.add(shape.Id);
            this.ctx.store.setSelection([...next]);
          } else {
            this.ctx.store.setSelection([shape.Id]);
          }
        },
        contextmenu: (event) => {
          event.preventDefault();
          this.ctx.store.setSelection([shape.Id]);
          openMenu(row, [
            { label: t('common.rename'), onSelect: () => this.inlineRename(nameNode, shape.Name, (value) => renameShape(this.ctx.store, shape.Id, value)) },
            { label: t('layers.front'), onSelect: () => reorderShapes(this.ctx.store, [shape.Id], 'front') },
            { label: t('layers.back'), onSelect: () => reorderShapes(this.ctx.store, [shape.Id], 'back') },
            { label: t('layers.forward'), onSelect: () => reorderShapes(this.ctx.store, [shape.Id], 'forward') },
            { label: t('layers.backward'), onSelect: () => reorderShapes(this.ctx.store, [shape.Id], 'backward') },
            { separator: true, label: '' },
            {
              label: shape.IsVisible ? t('layers.hideShape') : t('layers.showShape'),
              onSelect: () => setShapeVisible(this.ctx.store, shape.Id, !shape.IsVisible),
            },
            { label: t('common.delete'), danger: true, onSelect: () => deleteShapes(this.ctx.store, [shape.Id]) },
          ]);
        },
      },
    }, [
      visibilityBtn,
      el('span', {
        class: 'va-layer-badge',
        text: t(TYPE_BADGE[shape.Type] ?? 'layers.badgeLine'),
        title: shape.Type,
        style: insideGroup ? { opacity: '0.7' } : undefined,
      }),
      nameNode,
      bindings.length
        ? el('span', {
            class: 'va-chip is-bind',
            text: String(bindings.length),
            title: bindings.map((item) => `${item.label} → ${item.variable}`).join('\n'),
            style: { height: '16px', padding: '0 5px' },
          })
        : null,
    ]);

    return row;
  }

  private inlineRename(target: HTMLElement, current: string, commit: (value: string) => void): void {
    const input = el('input', {
      type: 'text',
      value: current,
      style: { width: '100%', height: '20px', fontSize: '11.5px' },
    });
    const parent = target.parentElement;
    if (!parent) return;
    target.replaceWith(input);
    input.focus();
    input.select();

    // The row underneath selects on click; without this the editor would be torn down by the
    // re-render that the selection change triggers.
    for (const type of ['click', 'dblclick', 'mousedown'] as const) {
      input.addEventListener(type, (event) => event.stopPropagation());
    }

    let done = false;
    const finish = (save: boolean): void => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      // The list may already have been rebuilt (the commit re-renders the panel), in which case
      // the input is detached and putting the label back would throw.
      if (input.parentElement) input.replaceWith(target);
      if (save && value && value !== current) commit(value);
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') finish(true);
      if (event.key === 'Escape') finish(false);
      event.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
  }
}
