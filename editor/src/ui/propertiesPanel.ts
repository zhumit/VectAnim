/**
 * Properties panel: geometry / appearance / transform / bindings.
 *
 * Core interaction: every animatable property has a "bind" button on its right which toggles
 * a variable binding. A bound input is locked and shows the live variable value, so users do
 * not mistake it for an editable field.
 */

import type { GroupDef, Shape, ValueRef } from '../schema/types';
import { isBindRef } from '../schema/valueRef';
import type { AppContext } from './context';
import { el, clear, openMenu, promptDialog, confirmDialog, formatNumber, openModal, type MenuItem } from './dom';
import { icon } from './icons';
import {
  shapePropDescriptors,
  groupPropDescriptors,
  getPropRef,
  setPropRef,
  clearPropRef,
  getGroupPropRef,
  setGroupPropRef,
  setGroupPivot,
  listBindings,
  listGroupBindings,
  type PropDescriptor,
} from '../editor/props';
import {
  deleteShapes,
  duplicateShapes,
  reorderShapes,
  alignShapes,
  distributeShapes,
  flipShapes,
  groupShapes,
  ungroupShapes,
  ungroupGroup,
  renameShape,
  renameGroup,
  addVariable,
} from '../editor/commands';
import { createVariable, sanitizeVariableName } from '../schema/factory';
import { shapeBounds } from '../editor/geometry';
import { toHex6, alphaOf, normalizeColor, withAlpha } from '../engine/color';
import { parsePathData, pathBounds } from '../engine/pathData';
import { t } from '../i18n';

export class PropertiesPanel {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;

  constructor(private readonly ctx: AppContext, host: HTMLElement) {
    this.body = el('div', { class: 'va-panel-body' });
    this.root = el('div', { class: 'va-panel', style: { flex: '1', minHeight: '0' } }, [this.body]);
    host.append(this.root);
  }

  render(): void {
    const shapes = this.ctx.store.getSelectedShapes();
    clear(this.body);

    if (!shapes.length) {
      this.body.append(this.renderCanvasSection());
      this.body.append(
        el('div', { class: 'va-empty' }, [
          el('div', { text: t('props.empty') }),
          el('div', { text: t('props.emptyHint'), style: { fontSize: '11px' } }),
        ]),
      );
      return;
    }

    // A group selection is "all members of exactly one group": it gets its own panel where the
    // group behaves like a single object (transform, opacity, bindings, animations).
    const group = this.groupForSelection(shapes);
    if (group) {
      this.body.append(this.renderGroupHeader(group, shapes));
      this.body.append(this.renderGroupTransformSection(group, shapes));
      this.body.append(this.renderGroupAppearanceSection(group));
      this.body.append(this.renderGroupMembersSection(group, shapes));
      this.body.append(this.renderGroupBindingsSection(group));
      this.body.append(this.renderGroupOrganizeSection(group, shapes));
      return;
    }

    if (shapes.length > 1) {
      this.body.append(this.renderMultiSection(shapes));
      return;
    }

    const shape = shapes[0];
    this.body.append(this.renderHeader(shape));
    this.body.append(this.renderGeometrySection(shape));
    this.body.append(this.renderAppearanceSection(shape));
    this.body.append(this.renderTransformSection(shape));
    this.body.append(this.renderBindingsSection(shape));
  }

  /** The group whose member list matches the selection exactly, if any. */
  private groupForSelection(shapes: Shape[]): GroupDef | undefined {
    if (shapes.length < 2) return undefined;
    const selected = new Set(shapes.map((shape) => shape.Id));
    return this.ctx.store
      .getDocument()
      .Groups.find(
        (group) => group.ShapeIds.length === selected.size && group.ShapeIds.every((id) => selected.has(id)),
      );
  }

  /* ------------------------------------------------------------------ *
   * Sections
   * ------------------------------------------------------------------ */

  private section(title: string, children: HTMLElement[], options: { collapsed?: boolean; actions?: HTMLElement[] } = {}): HTMLElement {
    const body = el('div', { class: 'va-section-body' }, children);
    const head = el('div', { class: 'va-section-head' }, [
      el('span', { html: icon(options.collapsed ? 'chevronRight' : 'chevronDown', 12) }),
      el('span', { text: title }),
      el('span', { style: { flex: '1' } }),
      ...(options.actions ?? []),
    ]);
    const section = el('div', { class: 'va-section' }, [head, body]);
    if (options.collapsed) body.style.display = 'none';
    head.addEventListener('click', () => {
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      head.firstElementChild!.innerHTML = icon(hidden ? 'chevronDown' : 'chevronRight', 12);
    });
    return section;
  }

  private renderHeader(shape: Shape): HTMLElement {
    const nameInput = el('input', {
      type: 'text',
      value: shape.Name,
      style: { flex: '1', height: '24px', fontWeight: '600' },
      on: {
        change: (event) => renameShape(this.ctx.store, shape.Id, (event.target as HTMLInputElement).value.trim() || shape.Name),
      },
    });

    const bounds = shapeBounds(shape, (name) => this.ctx.runtime.getVariable(name));

    return el('div', { class: 'va-section', style: { background: 'var(--bg-2)' } }, [
      el('div', { class: 'va-section-body' }, [
        el('div', { class: 'va-list-row' }, [
          el('span', { class: 'va-chip is-accent', text: shape.Type }),
          nameInput,
        ]),
        el('div', { class: 'va-list-row', style: { justifyContent: 'space-between' } }, [
          el('span', {
            class: 'va-hint',
            text: `#${shape.Id.slice(0, 12)}  ·  Z ${shape.ZIndex}  ·  ${formatNumber(bounds.width, 1)}×${formatNumber(bounds.height, 1)}`,
          }),
          el('button', {
            class: 'va-icon-btn',
            title: t('props.duplicateTitle'),
            html: icon('copy', 14),
            style: { width: '22px', height: '22px' },
            on: { click: () => duplicateShapes(this.ctx.store, [shape.Id]) },
          }),
          el('button', {
            class: 'va-icon-btn',
            title: t('props.deleteTitle'),
            html: icon('trash', 14),
            style: { width: '22px', height: '22px', color: 'var(--err)' },
            on: { click: () => deleteShapes(this.ctx.store, [shape.Id]) },
          }),
        ]),
      ]),
    ]);
  }

  private renderGeometrySection(shape: Shape): HTMLElement {
    const descriptors = shapePropDescriptors(shape).filter((item) => item.group === 'geometry');
    const rows = descriptors.map((descriptor) => this.renderPropRow(shape, descriptor));

    if (shape.Type === 'Polygon') {
      rows.unshift(
        el('div', { class: 'va-row' }, [
          el('span', { class: 'va-row-label', text: t('props.vertices') }),
          el('span', { class: 'va-mono va-muted', text: String(shape.Points.length) }),
          el('span'),
        ]),
      );
    }

    if (shape.Type === 'Path') {
      rows.unshift(
        el('div', { class: 'va-row' }, [
          el('span', { class: 'va-row-label', text: t('props.pathData') }),
          el('button', {
            class: 'va-btn is-small',
            text: t('common.edit'),
            on: { click: () => this.openPathEditor(shape) },
          }),
          el('span'),
        ]),
      );
    }

    const actions: HTMLElement[] = [];
    return this.section(t('props.sectionGeometry'), rows, { actions });
  }

  private renderAppearanceSection(shape: Shape): HTMLElement {
    const descriptors = shapePropDescriptors(shape).filter((item) => item.group === 'appearance');
    const rows = descriptors.map((descriptor) => this.renderPropRow(shape, descriptor));

    const capRow = el('div', { class: 'va-row' }, [
      el('span', { class: 'va-row-label', text: t('props.capJoin') }),
      el('div', { class: 'va-row-control' }, [
        el('select', {
          style: { flex: '1' },
          on: { change: (event) => this.patchShape(shape.Id, (draft) => { draft.LineCap = (event.target as HTMLSelectElement).value as Shape['LineCap']; }) },
        }, [
          el('option', { value: 'Flat', text: t('props.capFlat'), selected: (shape.LineCap ?? 'Flat') === 'Flat' }),
          el('option', { value: 'Round', text: t('props.capRound'), selected: shape.LineCap === 'Round' }),
          el('option', { value: 'Square', text: t('props.capSquare'), selected: shape.LineCap === 'Square' }),
        ]),
        el('select', {
          style: { flex: '1' },
          on: { change: (event) => this.patchShape(shape.Id, (draft) => { draft.LineJoin = (event.target as HTMLSelectElement).value as Shape['LineJoin']; }) },
        }, [
          el('option', { value: 'Miter', text: t('props.joinMiter'), selected: (shape.LineJoin ?? 'Miter') === 'Miter' }),
          el('option', { value: 'Round', text: t('props.joinRound'), selected: shape.LineJoin === 'Round' }),
          el('option', { value: 'Bevel', text: t('props.joinBevel'), selected: shape.LineJoin === 'Bevel' }),
        ]),
      ]),
      el('span'),
    ]);

    return this.section(t('props.sectionAppearance'), [...rows, capRow]);
  }

  private renderTransformSection(shape: Shape): HTMLElement {
    const descriptors = shapePropDescriptors(shape).filter((item) => item.group === 'transform');
    const rows = descriptors.map((descriptor) => this.renderPropRow(shape, descriptor));

    const quick = el('div', { class: 'va-toolbar-row' }, [
      el('button', { class: 'va-btn is-small', text: t('props.rotateLeft'), on: { click: () => this.rotate(shape, -90) } }),
      el('button', { class: 'va-btn is-small', text: t('props.rotateRight'), on: { click: () => this.rotate(shape, 90) } }),
      el('button', { class: 'va-btn is-small', text: t('props.resetRotation'), on: { click: () => this.rotate(shape, 0, true) } }),
      el('button', { class: 'va-btn is-small', text: t('props.flipH'), on: { click: () => flipShapes(this.ctx.store, [shape.Id], 'x') } }),
      el('button', { class: 'va-btn is-small', text: t('props.flipV'), on: { click: () => flipShapes(this.ctx.store, [shape.Id], 'y') } }),
    ]);

    return this.section(t('props.sectionTransform'), [...rows, quick]);
  }

  private rotate(shape: Shape, delta: number, absolute = false): void {
    const rotate = shape.RenderTransform?.Rotate;
    if (rotate && isBindRef(rotate.Value)) {
      this.ctx.notify(t('props.rotationBound'), 'warning');
      return;
    }
    const bounds = shapeBounds(shape);
    const current = rotate ? Number((rotate.Value as { Const: number }).Const ?? 0) : 0;
    const next = absolute ? 0 : current + delta;
    this.patchShape(shape.Id, (draft) => {
      draft.RenderTransform = draft.RenderTransform ?? {};
      draft.RenderTransform.Rotate = {
        CenterX: rotate?.CenterX ?? { Const: Math.round((bounds.x + bounds.width / 2) * 1000) / 1000 },
        CenterY: rotate?.CenterY ?? { Const: Math.round((bounds.y + bounds.height / 2) * 1000) / 1000 },
        Value: { Const: ((next % 360) + 540) % 360 - 180 },
      };
    });
  }

  private renderBindingsSection(shape: Shape): HTMLElement {
    const bindings = listBindings(shape);
    if (!bindings.length) {
      return this.section(t('props.sectionBindings'), [
        el('div', { class: 'va-hint', text: t('props.noBindings') }),
      ], { collapsed: true });
    }

    const rows = bindings.map((binding) =>
      el('div', { class: 'va-row' }, [
        el('span', { class: 'va-row-label', text: binding.label }),
        el('span', { class: 'va-chip is-bind', text: binding.variable }),
        el('button', {
          class: 'va-icon-btn',
          title: t('props.unbind'),
          html: icon('unlink', 13),
          style: { width: '20px', height: '20px' },
          on: {
            click: () => {
              this.patchShape(shape.Id, (draft) => clearPropRef(draft, binding.path));
              this.ctx.notify(t('props.unbound', { label: binding.label }));
            },
          },
        }),
      ]),
    );

    return this.section(t('props.sectionBindingsCount', { count: bindings.length }), rows);
  }

  private renderCanvasSection(): HTMLElement {
    const doc = this.ctx.store.getDocument();
    const widthInput = el('input', {
      type: 'number', value: doc.Canvas.Width, min: 16, step: 10,
      on: { change: () => this.applyCanvasSize(Number(widthInput.value), Number(heightInput.value)) },
    });
    const heightInput = el('input', {
      type: 'number', value: doc.Canvas.Height, min: 16, step: 10,
      on: { change: () => this.applyCanvasSize(Number(widthInput.value), Number(heightInput.value)) },
    });
    const bgInput = el('input', {
      type: 'color', value: toHex6(doc.Canvas.Background),
      on: { change: () => this.applyCanvasBackground(bgInput.value) },
    });

    return this.section(t('props.sectionCanvas'), [
      el('div', { class: 'va-row' }, [
        el('span', { class: 'va-row-label', text: t('props.size') }),
        el('div', { class: 'va-row-control' }, [widthInput, el('span', { class: 'va-muted', text: '×' }), heightInput]),
        el('span'),
      ]),
      el('div', { class: 'va-row' }, [
        el('span', { class: 'va-row-label', text: t('props.background') }),
        el('div', { class: 'va-row-control' }, [bgInput]),
        el('span'),
      ]),
    ]);
  }

  private applyCanvasSize(width: number, height: number): void {
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    const doc = this.ctx.store.getDocument();
    this.ctx.store.update((draft) => {
      draft.Canvas.Width = Math.max(16, Math.round(width));
      draft.Canvas.Height = Math.max(16, Math.round(height));
    }, { label: t('cmd.canvasSize'), coalesceKey: 'canvas-size' });
    void doc;
  }

  private applyCanvasBackground(color: string): void {
    this.ctx.store.update((draft) => {
      draft.Canvas.Background = normalizeColor(color) ?? '#FFFFFFFF';
    }, { label: t('cmd.canvasBackground'), coalesceKey: 'canvas-bg' });
  }

  private renderMultiSection(shapes: Shape[]): HTMLElement {
    const ids = shapes.map((shape) => shape.Id);
    const bounds = shapes.map((shape) => shapeBounds(shape));
    const minX = Math.min(...bounds.map((box) => box.x));
    const minY = Math.min(...bounds.map((box) => box.y));
    const maxX = Math.max(...bounds.map((box) => box.x + box.width));
    const maxY = Math.max(...bounds.map((box) => box.y + box.height));

    const toolRow = (items: Array<{ iconName: string; title: string; onClick: () => void }>): HTMLElement =>
      el('div', { class: 'va-toolbar-row' }, items.map((item) =>
        el('button', {
          class: 'va-icon-btn',
          title: item.title,
          html: icon(item.iconName, 15),
          on: { click: item.onClick },
        }),
      ));

    return el('div', {}, [
      el('div', { class: 'va-section' }, [
        el('div', { class: 'va-section-body' }, [
          el('div', { class: 'va-list-row' }, [
            el('span', { class: 'va-chip is-accent', text: t('props.selectedCount', { count: shapes.length }) }),
            el('span', { class: 'va-hint', text: `${formatNumber(maxX - minX, 1)} × ${formatNumber(maxY - minY, 1)}` }),
          ]),
        ]),
      ]),
      this.renderCommonSection(shapes),
      this.renderSelectionBindingsSection(shapes),
      this.section(t('props.sectionAlign'), [
        toolRow([
          { iconName: 'alignLeft', title: t('props.alignLeft'), onClick: () => alignShapes(this.ctx.store, ids, 'left') },
          { iconName: 'alignCenterH', title: t('props.alignCenterH'), onClick: () => alignShapes(this.ctx.store, ids, 'hcenter') },
          { iconName: 'alignRight', title: t('props.alignRight'), onClick: () => alignShapes(this.ctx.store, ids, 'right') },
          { iconName: 'alignTop', title: t('props.alignTop'), onClick: () => alignShapes(this.ctx.store, ids, 'top') },
          { iconName: 'alignCenterV', title: t('props.alignCenterV'), onClick: () => alignShapes(this.ctx.store, ids, 'vcenter') },
          { iconName: 'alignBottom', title: t('props.alignBottom'), onClick: () => alignShapes(this.ctx.store, ids, 'bottom') },
        ]),
        toolRow([
          { iconName: 'distribute', title: t('props.distributeH'), onClick: () => distributeShapes(this.ctx.store, ids, 'x') },
          { iconName: 'distribute', title: t('props.distributeV'), onClick: () => distributeShapes(this.ctx.store, ids, 'y') },
          { iconName: 'flipH', title: t('props.flipH'), onClick: () => flipShapes(this.ctx.store, ids, 'x') },
          { iconName: 'flipV', title: t('props.flipV'), onClick: () => flipShapes(this.ctx.store, ids, 'y') },
        ]),
      ]),
      this.section(t('props.sectionOrganize'), [
        el('div', { class: 'va-toolbar-row' }, [
          el('button', { class: 'va-btn is-small', text: t('props.group'), on: { click: () => groupShapes(this.ctx.store, ids) } }),
          el('button', { class: 'va-btn is-small', text: t('props.ungroup'), on: { click: () => ungroupShapes(this.ctx.store, ids) } }),
          el('button', { class: 'va-btn is-small', text: t('props.front'), on: { click: () => reorderShapes(this.ctx.store, ids, 'front') } }),
          el('button', { class: 'va-btn is-small', text: t('props.back'), on: { click: () => reorderShapes(this.ctx.store, ids, 'back') } }),
          el('button', { class: 'va-btn is-small', text: t('props.duplicate'), on: { click: () => duplicateShapes(this.ctx.store, ids) } }),
          el('button', {
            class: 'va-btn is-small is-danger',
            text: t('common.delete'),
            on: {
              click: async () => {
                const ok = await confirmDialog({
                  title: t('props.deleteShapesTitle'),
                  message: t('props.deleteShapesMessage', { count: ids.length }),
                  confirmText: t('common.delete'),
                  danger: true,
                });
                if (ok) deleteShapes(this.ctx.store, ids);
              },
            },
          }),
        ]),
      ]),
    ]);
  }

  /* ------------------------------------------------------------------ *
   * Group sections
   *
   * A selected group is treated as a single object: it gets its own transform (offset / rotation /
   * scale), its own opacity, its own bindings and its own animations. Direct manipulation on the
   * canvas still bakes into the members, so these values are an extra layer on top of them.
   * ------------------------------------------------------------------ */

  private membersBounds(members: Shape[]): { x: number; y: number; width: number; height: number } {
    const resolver = (name: string) => this.ctx.runtime.getVariable(name);
    const boxes = members.map((shape) => shapeBounds(shape, resolver));
    const minX = Math.min(...boxes.map((box) => box.x));
    const minY = Math.min(...boxes.map((box) => box.y));
    const maxX = Math.max(...boxes.map((box) => box.x + box.width));
    const maxY = Math.max(...boxes.map((box) => box.y + box.height));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  private renderGroupHeader(group: GroupDef, members: Shape[]): HTMLElement {
    const nameInput = el('input', {
      type: 'text',
      value: group.Name,
      style: { flex: '1', height: '24px', fontWeight: '600' },
      on: {
        change: (event) => renameGroup(this.ctx.store, group.GroupId, (event.target as HTMLInputElement).value.trim() || group.Name),
      },
    });
    const bounds = this.membersBounds(members);

    return el('div', { class: 'va-section', style: { background: 'var(--bg-2)' } }, [
      el('div', { class: 'va-section-body' }, [
        el('div', { class: 'va-list-row' }, [
          el('span', { class: 'va-chip is-accent', text: t('props.group') }),
          nameInput,
        ]),
        el('div', { class: 'va-list-row', style: { justifyContent: 'space-between' } }, [
          el('span', {
            class: 'va-hint',
            text: t('props.groupSummary', {
              count: members.length,
              width: formatNumber(bounds.width, 1),
              height: formatNumber(bounds.height, 1),
            }),
          }),
          el('button', {
            class: 'va-icon-btn',
            title: t('props.duplicateTitle'),
            html: icon('copy', 14),
            style: { width: '22px', height: '22px' },
            on: { click: () => duplicateShapes(this.ctx.store, members.map((shape) => shape.Id)) },
          }),
          el('button', {
            class: 'va-icon-btn',
            title: t('props.deleteTitle'),
            html: icon('trash', 14),
            style: { width: '22px', height: '22px', color: 'var(--err)' },
            on: {
              click: async () => {
                const ok = await confirmDialog({
                  title: t('props.deleteShapesTitle'),
                  message: t('props.deleteShapesMessage', { count: members.length }),
                  confirmText: t('common.delete'),
                  danger: true,
                });
                if (ok) deleteShapes(this.ctx.store, members.map((shape) => shape.Id));
              },
            },
          }),
        ]),
      ]),
    ]);
  }

  private renderGroupTransformSection(group: GroupDef, members: Shape[]): HTMLElement {
    const descriptors = groupPropDescriptors().filter((item) => item.group === 'transform');
    const rows = descriptors.map((descriptor) => this.renderGroupPropRow(group, members, descriptor));

    const quick = el('div', { class: 'va-toolbar-row' }, [
      el('button', { class: 'va-btn is-small', text: t('props.rotateLeft'), on: { click: () => this.rotateGroup(group, members, -90) } }),
      el('button', { class: 'va-btn is-small', text: t('props.rotateRight'), on: { click: () => this.rotateGroup(group, members, 90) } }),
      el('button', { class: 'va-btn is-small', text: t('props.resetRotation'), on: { click: () => this.rotateGroup(group, members, 0, true) } }),
      el('button', { class: 'va-btn is-small', text: t('props.resetTransform'), on: { click: () => this.resetGroupTransform(group) } }),
    ]);

    return this.section(t('props.sectionGroupTransform'), [...rows, quick]);
  }

  private renderGroupAppearanceSection(group: GroupDef): HTMLElement {
    const descriptors = groupPropDescriptors().filter((item) => item.group === 'appearance');
    const rows = descriptors.map((descriptor) => this.renderGroupPropRow(group, undefined, descriptor));
    return this.section(t('props.sectionAppearance'), rows);
  }

  private renderGroupMembersSection(group: GroupDef, members: Shape[]): HTMLElement {
    void group;
    const rows = members.map((shape) =>
      el('div', {
        class: 'va-list-row',
        style: { cursor: 'pointer' },
        on: { click: () => this.ctx.store.setSelection([shape.Id]) },
      }, [
        el('span', { class: 'va-chip', text: shape.Type }),
        el('span', { class: 'va-row-label', text: shape.Name, style: { flex: '1' } }),
        el('span', { class: 'va-hint', text: `#${shape.Id.slice(0, 8)}` }),
      ]),
    );
    return this.section(t('props.sectionGroupMembers', { count: members.length }), rows, { collapsed: members.length > 6 });
  }

  private renderGroupBindingsSection(group: GroupDef): HTMLElement {
    const bindings = listGroupBindings(group);
    if (!bindings.length) {
      return this.section(t('props.sectionBindings'), [el('div', { class: 'va-hint', text: t('props.noBindings') })], {
        collapsed: true,
      });
    }

    const rows = bindings.map((binding) =>
      el('div', { class: 'va-row' }, [
        el('span', { class: 'va-row-label', text: binding.label }),
        el('span', { class: 'va-chip is-bind', text: binding.variable }),
        el('button', {
          class: 'va-icon-btn',
          title: t('props.unbind'),
          html: icon('unlink', 13),
          style: { width: '20px', height: '20px' },
          on: {
            click: () => {
              this.patchGroup(group.GroupId, (draft) => {
                const current = getGroupPropRef(draft, binding.path);
                setGroupPropRef(draft, binding.path, { Const: current && 'Const' in current ? current.Const : 0 });
              });
              this.ctx.notify(t('props.unbound', { label: binding.label }));
            },
          },
        }),
      ]),
    );

    return this.section(t('props.sectionBindingsCount', { count: bindings.length }), rows);
  }

  private renderGroupOrganizeSection(group: GroupDef, members: Shape[]): HTMLElement {
    const ids = members.map((shape) => shape.Id);
    return this.section(t('props.sectionOrganize'), [
      el('div', { class: 'va-toolbar-row' }, [
        el('button', { class: 'va-btn is-small', text: t('props.ungroup'), on: { click: () => ungroupGroup(this.ctx.store, group.GroupId) } }),
        el('button', { class: 'va-btn is-small', text: t('props.front'), on: { click: () => reorderShapes(this.ctx.store, ids, 'front') } }),
        el('button', { class: 'va-btn is-small', text: t('props.back'), on: { click: () => reorderShapes(this.ctx.store, ids, 'back') } }),
        el('button', { class: 'va-btn is-small', text: t('props.flipH'), on: { click: () => flipShapes(this.ctx.store, ids, 'x') } }),
        el('button', { class: 'va-btn is-small', text: t('props.flipV'), on: { click: () => flipShapes(this.ctx.store, ids, 'y') } }),
      ]),
    ]);
  }

  private renderGroupPropRow(group: GroupDef, members: Shape[] | undefined, descriptor: PropDescriptor): HTMLElement {
    const ref = getGroupPropRef(group, descriptor.path);
    const bound = ref ? isBindRef(ref) : false;
    const fallback = groupPropFallback(descriptor.path);
    const resolved = bound && isBindRef(ref)
      ? this.ctx.runtime.getVariable(ref.Bind)
      : Number((ref as { Const?: number } | undefined)?.Const ?? fallback);

    const row = el('div', { class: `va-row${bound ? ' is-bound' : ''}` });
    const label = el('span', { class: 'va-row-label', text: descriptor.label, title: descriptor.hint });
    const control = el('div', { class: 'va-row-control' });

    const input = el('input', {
      type: 'number',
      step: descriptor.step ?? 1,
      value: formatNumber(resolved, 3),
      disabled: bound,
      title: bound && isBindRef(ref) ? t('props.boundLiveValue', { name: ref.Bind }) : undefined,
      on: {
        change: () => {
          const value = Number(input.value);
          if (!Number.isFinite(value)) return;
          this.patchGroup(group.GroupId, (draft) => {
            this.applyGroupProp(draft, members, descriptor.path, { Const: value });
          }, `group-${group.GroupId}-${descriptor.path}`);
        },
      },
    });
    control.append(input);

    const bindBtn = el('button', {
      class: `va-bind-btn${bound ? ' is-bound' : ''}`,
      title: bound ? t('props.bindTipBound', { name: isBindRef(ref) ? ref.Bind : '' }) : t('props.bindTipFree'),
      html: icon(bound ? 'link' : 'unlink', 13),
      on: { click: () => this.openGroupBindMenu(bindBtn, group, members, descriptor, resolved) },
    });

    row.append(label, control, bindBtn);
    return row;
  }

  /** Write a group property and, on the first rotation/scale, pin the pivot to the group's center. */
  private applyGroupProp(
    group: GroupDef,
    members: Shape[] | undefined,
    path: string,
    ref: ValueRef,
  ): void {
    const hadRotate = !!group.RenderTransform?.Rotate;
    const hadScale = !!group.RenderTransform?.Scale;
    setGroupPropRef(group, path, ref);
    if (!members) return;
    const needsPivot = (path.includes('Rotate') && !hadRotate) || (path.includes('Scale') && !hadScale);
    if (!needsPivot) return;
    const bounds = this.membersBounds(members);
    setGroupPivot(group, bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  }

  private rotateGroup(group: GroupDef, members: Shape[], delta: number, absolute = false): void {
    const rotate = group.RenderTransform?.Rotate;
    if (rotate && isBindRef(rotate.Value)) {
      this.ctx.notify(t('props.rotationBound'), 'warning');
      return;
    }
    const current = rotate ? Number((rotate.Value as { Const: number }).Const ?? 0) : 0;
    const next = absolute ? 0 : current + delta;
    this.patchGroup(group.GroupId, (draft) => {
      this.applyGroupProp(draft, members, 'RenderTransform.Rotate.Value', { Const: ((next % 360) + 540) % 360 - 180 });
    });
  }

  private resetGroupTransform(group: GroupDef): void {
    this.patchGroup(group.GroupId, (draft) => {
      const rotate = draft.RenderTransform?.Rotate;
      const scale = draft.RenderTransform?.Scale;
      const translate = draft.RenderTransform?.Translate;
      if (rotate && isBindRef(rotate.Value)) {
        // keep bound values: they are data-driven
      } else if (rotate) {
        rotate.Value = { Const: 0 };
      }
      if (scale && !isBindRef(scale.ValueX) && !isBindRef(scale.ValueY)) {
        scale.ValueX = { Const: 1 };
        scale.ValueY = { Const: 1 };
      }
      if (translate) {
        if (!isBindRef(translate.X)) translate.X = { Const: 0 };
        if (!isBindRef(translate.Y)) translate.Y = { Const: 0 };
      }
    });
  }

  private openGroupBindMenu(
    anchor: HTMLElement,
    group: GroupDef,
    members: Shape[] | undefined,
    descriptor: PropDescriptor,
    resolvedValue: number,
  ): void {
    this.openBindMenuFor(anchor, descriptor, getGroupPropRef(group, descriptor.path), resolvedValue, (ref) => {
      this.patchGroup(group.GroupId, (draft) => this.applyGroupProp(draft, members, descriptor.path, ref));
    });
  }

  private patchGroup(groupId: string, mutator: (draft: GroupDef) => void, coalesceKey?: string): void {
    this.ctx.store.update((draft) => {
      const group = draft.Groups.find((item) => item.GroupId === groupId);
      if (group) mutator(group);
    }, { label: t('cmd.updateGroup'), coalesceKey });
  }

  /* ------------------------------------------------------------------ *
   * Common properties of a multi-selection
   *
   * Only the properties every selected shape has are listed, so a value can be applied to all of
   * them at once. Values that differ between shapes are shown as "Mixed" and are left untouched
   * until the user types something.
   * ------------------------------------------------------------------ */

  private commonDescriptors(shapes: Shape[]): PropDescriptor[] {
    const pathSets = shapes.map((shape) => new Set(shapePropDescriptors(shape).map((item) => item.path)));
    return shapePropDescriptors(shapes[0]).filter((descriptor) =>
      pathSets.every((paths) => paths.has(descriptor.path)),
    );
  }

  private renderCommonSection(shapes: Shape[]): HTMLElement {
    const descriptors = this.commonDescriptors(shapes);
    if (!descriptors.length) {
      return this.section(t('props.sectionCommon'), [el('div', { class: 'va-hint', text: t('props.noCommonProps') })], {
        collapsed: true,
      });
    }

    const rows = descriptors.map((descriptor) => this.renderCommonPropRow(shapes, descriptor));
    return this.section(t('props.sectionCommonCount', { count: descriptors.length }), [
      el('div', { class: 'va-hint', text: t('props.commonHint') }),
      ...rows,
    ]);
  }

  private renderCommonPropRow(shapes: Shape[], descriptor: PropDescriptor): HTMLElement {
    const refs = shapes.map((shape) => getPropRef(shape, descriptor.path));
    const first = refs[0];
    const mixed = !refs.every((ref) => refKey(ref) === refKey(first));
    const allBoundTo = refs.every((ref) => ref && isBindRef(ref) && ref.Bind === (first && isBindRef(first) ? first.Bind : null))
      ? first && isBindRef(first) ? first.Bind : undefined
      : undefined;

    const resolved = !mixed && first && isBindRef(first)
      ? this.ctx.runtime.getVariable(first.Bind)
      : !mixed && first && 'Const' in first
        ? Number(first.Const)
        : Number.NaN;

    const row = el('div', { class: `va-row${allBoundTo ? ' is-bound' : ''}` });
    const label = el('span', { class: 'va-row-label', text: descriptor.label, title: descriptor.hint });
    const control = el('div', { class: 'va-row-control' });

    if (descriptor.kind === 'color') {
      control.append(this.renderCommonColorControl(shapes, descriptor, mixed ? null : first));
    } else {
      const input = el('input', {
        type: 'number',
        step: descriptor.step ?? 1,
        value: mixed || !Number.isFinite(resolved) ? '' : formatNumber(resolved, 3),
        placeholder: mixed ? t('props.mixedValue') : '',
        disabled: !!allBoundTo,
        title: allBoundTo ? t('props.boundLiveValue', { name: allBoundTo }) : undefined,
        on: {
          change: () => {
            const value = Number(input.value);
            if (!Number.isFinite(value) || input.value === '') return;
            this.patchShapes(shapes.map((shape) => shape.Id), (draft) => {
              setPropRef(draft, descriptor.path, { Const: value });
            }, `multi-${descriptor.path}`);
          },
        },
      });
      control.append(input);
    }

    const bindBtn = el('button', {
      class: `va-bind-btn${allBoundTo ? ' is-bound' : ''}`,
      title: allBoundTo ? t('props.bindTipBound', { name: allBoundTo }) : t('props.bindTipFree'),
      html: icon(allBoundTo ? 'link' : 'unlink', 13),
      on: {
        click: () =>
          this.openBindMenuFor(bindBtn, descriptor, allBoundTo ? { Bind: allBoundTo } : undefined, Number.isFinite(resolved) ? resolved : 0, (ref) => {
            this.patchShapes(shapes.map((shape) => shape.Id), (draft) => {
              setPropRef(draft, descriptor.path, ref);
            });
          }),
      },
    });

    row.append(label, control, bindBtn);
    return row;
  }

  /** Variables that drive any of the selected shapes, with the number of shapes using each one. */
  private renderSelectionBindingsSection(shapes: Shape[]): HTMLElement {
    const usage = new Map<string, { shapes: number; paths: Set<string> }>();
    for (const shape of shapes) {
      for (const binding of listBindings(shape)) {
        const entry = usage.get(binding.variable) ?? { shapes: 0, paths: new Set<string>() };
        entry.shapes += 1;
        entry.paths.add(binding.label);
        usage.set(binding.variable, entry);
      }
    }

    if (!usage.size) {
      return this.section(t('props.sectionBindings'), [el('div', { class: 'va-hint', text: t('props.noBindings') })], {
        collapsed: true,
      });
    }

    const rows = [...usage.entries()].map(([variable, entry]) =>
      el('div', { class: 'va-row' }, [
        el('span', { class: 'va-row-label', text: variable }),
        el('span', { class: 'va-chip is-bind', text: String(entry.shapes) }),
        el('span', { class: 'va-hint', text: [...entry.paths].slice(0, 3).join(', ') }),
      ]),
    );

    return this.section(t('props.selectionBindings', { count: usage.size }), rows);
  }

  private renderCommonColorControl(shapes: Shape[], descriptor: PropDescriptor, ref: ValueRef | null | undefined): HTMLElement {    const current = ref && 'Const' in ref ? String(ref.Const) : null;
    const swatch = el('input', {
      type: 'color',
      value: toHex6(current ?? ''),
      on: {
        input: () => {
          this.patchShapes(shapes.map((shape) => shape.Id), (draft) => {
            setPropRef(draft, descriptor.path, { Const: swatch.value.toUpperCase() });
          }, `multi-${descriptor.path}`);
        },
      },
    });
    return el('div', { class: 'va-color-field' }, [swatch]);
  }

  private patchShapes(shapeIds: string[], mutator: (draft: Shape) => void, coalesceKey?: string): void {
    const ids = new Set(shapeIds);
    this.ctx.store.update((draft) => {
      for (const shape of draft.Shapes) {
        if (ids.has(shape.Id)) mutator(shape);
      }
    }, { label: t('cmd.updateShapes'), coalesceKey });
  }

  /* ------------------------------------------------------------------ *
   * Property rows
   * ------------------------------------------------------------------ */

  private renderPropRow(shape: Shape, descriptor: PropDescriptor): HTMLElement {
    const ref = getPropRef(shape, descriptor.path);
    const bound = ref ? isBindRef(ref) : false;
    const row = el('div', { class: `va-row${bound ? ' is-bound' : ''}` });
    const label = el('span', { class: 'va-row-label', text: descriptor.label, title: descriptor.hint });
    const control = el('div', { class: 'va-row-control' });

    if (descriptor.kind === 'color') {
      control.append(this.renderColorControl(shape, descriptor, ref, bound));
    } else {
      control.append(this.renderNumberControl(shape, descriptor, ref, bound));
    }

    const bindBtn = el('button', {
      class: `va-bind-btn${bound ? ' is-bound' : ''}`,
      title: bound ? t('props.bindTipBound', { name: isBindRef(ref) ? ref.Bind : '' }) : t('props.bindTipFree'),
      html: icon(bound ? 'link' : 'unlink', 13),
      on: { click: () => this.openBindMenu(bindBtn, shape, descriptor) },
    });

    row.append(label, control, bindBtn);
    return row;
  }

  private renderNumberControl(shape: Shape, descriptor: PropDescriptor, ref: ValueRef | null | undefined, bound: boolean): HTMLElement {
    const resolved = bound && isBindRef(ref)
      ? this.ctx.runtime.getVariable(ref.Bind)
      : Number((ref as { Const?: number } | undefined)?.Const ?? 0);

    const input = el('input', {
      type: 'number',
      step: descriptor.step ?? 1,
      value: formatNumber(resolved, 3),
      disabled: bound,
      title: bound && isBindRef(ref) ? t('props.boundLiveValue', { name: ref.Bind }) : undefined,
      on: {
        change: () => {
          const value = Number(input.value);
          if (!Number.isFinite(value)) return;
          this.patchShape(shape.Id, (draft) => {
            setPropRef(draft, descriptor.path, { Const: value });
          }, `prop-${shape.Id}-${descriptor.path}`);
        },
      },
    });

    return input;
  }

  private renderColorControl(shape: Shape, descriptor: PropDescriptor, ref: ValueRef | null | undefined, bound: boolean): HTMLElement {
    let colorValue = '#000000';
    let alpha = 1;

    if (bound && isBindRef(ref)) {
      const numeric = this.ctx.runtime.getVariable(ref.Bind);
      colorValue = toHex6(String(Math.round(numeric)));
      alpha = 1;
    } else if (ref && 'Const' in ref) {
      const raw = ref.Const;
      colorValue = toHex6(typeof raw === 'number' ? String(raw) : String(raw));
      alpha = alphaOf(String(raw));
    }

    const swatch = el('input', {
      type: 'color',
      value: colorValue,
      disabled: bound,
      on: {
        input: () => {
          this.patchShape(shape.Id, (draft) => {
            setPropRef(draft, descriptor.path, { Const: swatch.value.toUpperCase() });
          }, `prop-${shape.Id}-${descriptor.path}`);
        },
      },
    });

    const text = el('input', {
      type: 'text',
      value: bound ? t('props.variableToken') : colorValue.toUpperCase(),
      disabled: bound,
      title: t('props.colorFormatTip'),
      on: {
        change: () => {
          const normalized = normalizeColor(text.value);
          this.patchShape(shape.Id, (draft) => {
            if (normalized) setPropRef(draft, descriptor.path, { Const: normalized });
            else (draft as unknown as Record<string, unknown>)[descriptor.path] = null;
          }, `prop-${shape.Id}-${descriptor.path}`);
        },
      },
    });

    const alphaInput = el('input', {
      type: 'number',
      step: 0.05,
      min: 0,
      max: 1,
      value: formatNumber(alpha, 2),
      disabled: bound,
      style: { width: '48px' },
      title: t('props.alphaTip'),
      on: {
        change: () => {
          const value = Math.max(0, Math.min(1, Number(alphaInput.value)));
          if (!Number.isFinite(value)) return;
          this.patchShape(shape.Id, (draft) => {
            const base = normalizeColor(swatch.value) ?? '#FF000000';
            setPropRef(draft, descriptor.path, { Const: withAlpha(base, value) });
          }, `prop-${shape.Id}-${descriptor.path}`);
        },
      },
    });

    const clearBtn = el('button', {
      class: 'va-icon-btn',
      title: t('props.setNone'),
      html: icon('close', 12),
      style: { width: '18px', height: '18px' },
      on: {
        click: () => {
          this.patchShape(shape.Id, (draft) => {
            (draft as unknown as Record<string, unknown>)[descriptor.path] = null;
          });
        },
      },
    });

    return el('div', { class: 'va-color-field' }, [swatch, text, alphaInput, clearBtn]);
  }

  private openBindMenu(anchor: HTMLElement, shape: Shape, descriptor: PropDescriptor): void {
    const current = getPropRef(shape, descriptor.path);
    const resolvedValue = current && 'Const' in current ? Number(current.Const) : 0;
    this.openBindMenuFor(anchor, descriptor, current, Number.isFinite(resolvedValue) ? resolvedValue : 0, (ref) => {
      this.patchShape(shape.Id, (draft) => {
        setPropRef(draft, descriptor.path, ref);
      });
    });
  }

  /**
   * Shared bind menu: pick an existing variable, create one on the fly, or drop the binding.
   * `apply` receives the reference that should be written to the (single or multiple) targets.
   */
  private openBindMenuFor(
    anchor: HTMLElement,
    descriptor: PropDescriptor,
    current: ValueRef | null | undefined,
    resolvedValue: number,
    apply: (ref: ValueRef) => void,
  ): void {
    const doc = this.ctx.store.getDocument();
    const currentVar = current && isBindRef(current) ? current.Bind : undefined;

    const items: MenuItem[] = doc.Variables.map((variable) => ({
      label: variable.Name,
      hint: currentVar === variable.Name ? t('props.menuBound') : (variable.Description || ''),
      onSelect: () => {
        apply({ Bind: variable.Name });
        this.ctx.notify(t('props.boundToVariable', { label: descriptor.label, name: variable.Name }), 'success');
      },
    }));

    if (!items.length) {
      items.push({ label: t('props.menuNoVariables'), disabled: true, onSelect: () => undefined });
    }

    items.push(
      { separator: true, label: '', onSelect: () => undefined },
      {
        label: t('props.menuNewVariable'),
        onSelect: async () => {
          const name = await promptDialog({
            title: t('props.newVariableTitle'),
            label: t('props.newVariableLabel', { label: descriptor.label }),
            defaultValue: suggestVariableName(descriptor.path, doc.Variables.map((item) => item.Name)),
            validate: (value) => {
              if (!value) return t('props.errorNameEmpty');
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return t('props.errorNamePattern');
              if (doc.Variables.some((item) => item.Name === value)) return t('props.errorNameExists');
              return undefined;
            },
          });
          if (!name) return;
          const numericDefault = typeof resolvedValue === 'number' ? resolvedValue : 0;
          addVariable(this.ctx.store, createVariable(name, numericDefault, { Description: descriptor.label }));
          apply({ Bind: sanitizeVariableName(name) });
          this.ctx.notify(t('props.createdAndBound', { name }), 'success');
        },
      },
      {
        label: t('props.unbind'),
        danger: true,
        disabled: !currentVar,
        onSelect: () => {
          apply({ Const: typeof resolvedValue === 'number' ? resolvedValue : 0 });
          this.ctx.notify(t('props.unbound', { label: descriptor.label }));
        },
      },
    );

    openMenu(anchor, items, { align: 'right', width: 220 });
  }

  /* ------------------------------------------------------------------ *
   * Path editing
   * ------------------------------------------------------------------ */

  private openPathEditor(shape: Shape): void {
    if (shape.Type !== 'Path') return;
    const textarea = el('textarea', {
      value: shape.Data,
      style: { width: '100%', height: '160px', fontFamily: 'var(--mono)', fontSize: '11.5px', lineHeight: '1.6' },
    });
    const info = el('div', { class: 'va-hint', text: t('props.pathHint') });

    const apply = (): void => {
      const value = textarea.value.trim();
      try {
        const parsed = parsePathData(value);
        const bounds = pathBounds(parsed.commands);
        this.patchShape(shape.Id, (draft) => {
          if (draft.Type !== 'Path') return;
          draft.Data = value;
          if (draft.OffsetX === undefined) draft.OffsetX = Math.round(bounds.x * 1000) / 1000;
          if (draft.OffsetY === undefined) draft.OffsetY = Math.round(bounds.y * 1000) / 1000;
        });
        handle.close();
        this.ctx.notify(t('props.pathUpdated'), 'success');
      } catch (error) {
        info.textContent = t('props.pathParseFailed', { error: error instanceof Error ? error.message : String(error) });
        info.className = 'va-hint is-error';
      }
    };

    const footer = el('div', { class: 'va-list-row' }, [
      el('button', { class: 'va-btn', text: t('common.cancel'), on: { click: () => handle.close() } }),
      el('button', { class: 'va-btn is-primary', text: t('common.apply'), on: { click: apply } }),
    ]);

    const handle = openModal({
      title: t('props.pathEditorTitle'),
      content: el('div', { style: { display: 'grid', gap: '6px' } }, [textarea, info]),
      width: 560,
      footer,
    });
  }

  /* ------------------------------------------------------------------ *
   * Mutation helpers
   * ------------------------------------------------------------------ */

  private patchShape(shapeId: string, mutator: (draft: Shape) => void, coalesceKey?: string): void {
    this.ctx.store.update((draft) => {
      const shape = draft.Shapes.find((item) => item.Id === shapeId);
      if (shape) mutator(shape);
    }, { label: t('cmd.updateShape'), coalesceKey });
  }
}

function suggestVariableName(path: string, existing: readonly string[]): string {
  const base = path.replace(/^RenderTransform\.Rotate\./, 'Rotate').replace(/\./g, '_');
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}

/** Default value shown when a group property is absent from the document. */
function groupPropFallback(path: string): number {
  if (path.includes('Scale')) return 1;
  if (path === 'Opacity') return 1;
  return 0;
}

/** Stable key for comparing two property references (used to detect "Mixed" values). */
function refKey(ref: ValueRef | null | undefined): string {
  if (!ref) return 'none';
  return isBindRef(ref) ? `bind:${ref.Bind}` : `const:${String(ref.Const)}`;
}
