/**
 * Editor entry point: assembles the layout, canvas, panels, shortcuts and file operations.
 *
 * Data flow: EditorStore (single source of truth) → CanvasView (projection) / panels (views).
 * Runtime: VectAnimRuntime holds current variable values for canvas bindings and the preview.
 */

import './../styles/app.css';

import type { VectAnimDocument } from '../schema/types';
import { createEmptyDocument } from '../schema/types';
import { newId } from '../schema/factory';
import { parseDocumentText, serializeDocument, validateDocument, type Issue } from '../schema/validate';
import { EditorStore } from '../editor/store';
import { CanvasView, type ToolId } from '../editor/canvasView';
import { VectAnimRuntime } from '../engine/runtime';
import { documentToPngBlob, documentToSvg } from '../editor/exporters';
import { applyShapeEdits, deleteShapes, duplicateShapes, groupShapes, nudgeShapes, reorderShapes, ungroupShapes, addShapes, insertShapeCopies, setCanvasSize } from '../editor/commands';
import { translateShape } from '../editor/geometry';
import { importSvg } from '../editor/svgImport';
import { LayersPanel } from './layersPanel';
import { PropertiesPanel } from './propertiesPanel';
import { VariablesPanel } from './variablesPanel';
import { AnimationsPanel } from './animationsPanel';
import { openPreview } from './previewPanel';
import type { AppContext } from './context';
import { el, toast, pickFile, downloadFile, openModal, openMenu, formatNumber, confirmDialog } from './dom';
import { icon } from './icons';
import { t, getLocale, setLocale, LOCALES } from '../i18n';
import gearDemoDocument from '../../../samples/gear-demo.vectanim.json';
import industrialDemoDocument from '../../../samples/industrial-panel.vectanim.json';

const AUTOSAVE_KEY = 'vectanim.editor.autosave.v1';
/** Offset used when pasting, so consecutive pastes do not stack on top of each other. */
const PASTE_OFFSET = 16;

interface ToolDefinition {
  id: ToolId;
  iconName: string;
  labelKey: string;
  key: string;
  hintKey?: string;
}

const TOOLS: ToolDefinition[] = [
  { id: 'select', iconName: 'select', labelKey: 'tool.select', key: 'V', hintKey: 'tool.selectHint' },
  { id: 'line', iconName: 'line', labelKey: 'tool.line', key: 'L' },
  { id: 'rect', iconName: 'rect', labelKey: 'tool.rect', key: 'R', hintKey: 'tool.rectHint' },
  { id: 'ellipse', iconName: 'ellipse', labelKey: 'tool.ellipse', key: 'E', hintKey: 'tool.ellipseHint' },
  { id: 'arc', iconName: 'arc', labelKey: 'tool.arc', key: 'A', hintKey: 'tool.arcHint' },
  { id: 'polygon', iconName: 'polygon', labelKey: 'tool.polygon', key: 'P' },
  { id: 'pen', iconName: 'pen', labelKey: 'tool.pen', key: 'N' },
  { id: 'freehand', iconName: 'pencil', labelKey: 'tool.freehand', key: 'F' },
  { id: 'pan', iconName: 'hand', labelKey: 'tool.pan', key: 'H' },
];

export class EditorApp implements AppContext {
  readonly store: EditorStore;
  readonly view: CanvasView;
  readonly runtime: VectAnimRuntime;

  private readonly layersPanel: LayersPanel;
  private readonly propertiesPanel: PropertiesPanel;
  private readonly variablesPanel: VariablesPanel;
  private readonly animationsPanel: AnimationsPanel;

  private readonly toolButtons = new Map<ToolId, HTMLElement>();
  private readonly tabButtons = new Map<string, HTMLElement>();
  private readonly panelHosts = new Map<string, HTMLElement>();
  private activeTab = 'properties';

  private readonly zoomLabel = el('span', { class: 'va-mono', style: { minWidth: '44px', textAlign: 'center' }, text: '100%' });
  private readonly pointerLabel = el('span', { class: 'va-status-item', text: 'x 0  y 0', dataset: { testid: 'pointer' } });
  private readonly selectionLabel = el('span', { class: 'va-status-item', text: t('app.selectionNone'), dataset: { testid: 'selection' } });
  private readonly shapeCountLabel = el('span', { class: 'va-status-item', text: '', dataset: { testid: 'shape-count' } });
  private readonly statusMessage = el('span', { class: 'va-status-msg', text: t('app.ready'), dataset: { testid: 'status' } });
  private readonly dirtyDot = el('span', { class: 'va-dot' });
  private readonly historyLabel = el('span', { class: 'va-status-item', text: '', dataset: { testid: 'history' } });
  private readonly undoButton = el('button', { class: 'va-icon-btn', title: t('app.undo'), html: icon('undo', 16), disabled: true });
  private readonly redoButton = el('button', { class: 'va-icon-btn', title: t('app.redo'), html: icon('redo', 16), disabled: true });
  private readonly gridButton = el('button', { class: 'va-icon-btn is-active', title: t('app.grid'), html: icon('grid', 16) });
  private readonly snapButton = el('button', { class: 'va-icon-btn is-active', title: t('app.snap'), html: icon('magnet', 16) });
  private readonly titleInput = el('input', { class: 'va-doc-title', type: 'text', value: t('app.untitled'), title: t('app.docTitle') });

  private pasteRun = 0;
  private autosaveTimer: number | undefined;
  private suppressAutosave = false;

  constructor(private readonly root: HTMLElement) {
    const initial = this.loadInitialDocument();
    this.store = new EditorStore(initial.document);
    this.runtime = new VectAnimRuntime(initial.document);

    this.syncDocumentLanguage();

    const canvasHost = el('div', { class: 'va-canvas-host', id: 'va-canvas-host' });
    this.buildLayout(canvasHost);

    this.view = new CanvasView(canvasHost, {
      getDocument: () => this.store.getDocument(),
      getVariable: (name) => this.runtime.getVariable(name),
      onSelectionChange: (ids) => this.store.setSelection(ids),
      onShapeEdits: (edits) => applyShapeEdits(this.store, edits),
      onCreateShape: (shape, label) => {
        this.store.update((draft) => {
          draft.Shapes.push(shape);
        }, { label });
        this.store.setSelection([shape.Id]);
        this.setTool('select');
      },
      onDuplicateShapes: (snapshot) => {
        // The originals stay in place, the new copies land at the drop position and get selected
        const created = insertShapeCopies(this.store, snapshot);
        this.store.setSelection(created);
        this.notify(t('notify.copied', { count: snapshot.shapes.length }), 'success');
      },
      onZoomChange: (zoom) => {
        this.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
      },
      onPointerMove: (point) => {
        this.pointerLabel.textContent = point
          ? `x ${formatNumber(point.x, 1)}  y ${formatNumber(point.y, 1)}`
          : t('app.pointerEmpty');
      },
      onStatus: (message) => this.store.setStatus(message),
    });

    this.layersPanel = new LayersPanel(this, this.panelHosts.get('layers')!);
    this.propertiesPanel = new PropertiesPanel(this, this.panelHosts.get('properties')!);
    this.variablesPanel = new VariablesPanel(this, this.panelHosts.get('variables')!);
    this.animationsPanel = new AnimationsPanel(this, this.panelHosts.get('animations')!);

    this.store.subscribe((event) => {
      if (event.type === 'document') {
        this.syncRuntime();
        this.view.render(this.store.getDocument());
        this.scheduleAutosave();
      }
      if (event.type === 'document' || event.type === 'selection') {
        this.refresh();
      }
      if (event.type === 'selection') {
        this.view.setSelection(this.store.getSelection());
      }
      if (event.type === 'tool') {
        this.syncToolButtons();
      }
      if (event.type === 'history' || event.type === 'status') {
        this.updateStatusBar();
      }
    });

    this.bindShortcuts();
    this.installResizeObserver(canvasHost);
    this.installDragDrop();

    this.refresh();
    this.view.render(this.store.getDocument());
    // The canvas size may be inaccurate before the layout settles, so fit again on the next frame
    requestAnimationFrame(() => this.view.fitToView());
    this.updateStatusBar();
    this.syncToolButtons();

    if (initial.restored) {
      toast(t('notify.restored'), { type: 'info' });
    }
    this.store.setStatus(t('app.readyHint'));
  }

  /* ------------------------------------------------------------------ *
   * Layout
   * ------------------------------------------------------------------ */

  private buildLayout(canvasHost: HTMLElement): void {
    const topbar = this.buildTopbar();
    const toolbar = this.buildToolbar();

    const layersHost = el('div', { id: 'panel-layers', style: { display: 'flex' } });
    const rightPanel = this.buildRightPanel();

    const body = el('div', { class: 'va-body' }, [toolbar, layersHost, el('div', { class: 'va-center' }, [canvasHost]), rightPanel]);
    const statusbar = el('footer', { class: 'va-statusbar' }, [
      this.dirtyDot,
      this.statusMessage,
      el('span', { class: 'va-status-spacer' }),
      this.pointerLabel,
      this.selectionLabel,
      this.shapeCountLabel,
      this.historyLabel,
      this.zoomLabel,
    ]);

    this.root.append(el('div', { class: 'va-app' }, [topbar, body, statusbar]));
    this.panelHosts.set('layers', layersHost);
  }

  private buildTopbar(): HTMLElement {
    const fileGroup = el('div', { class: 'va-topbar-group' }, [
      this.topButton('file', t('app.new'), () => this.newDocument()),
      this.topButton('folder', t('app.open'), () => this.requestImport()),
      this.topButton('save', t('app.save'), () => this.requestExport()),
      this.topButton('upload', t('app.importSvg'), () => this.requestSvgImport()),
      el('button', {
        class: 'va-icon-btn',
        title: t('app.samples'),
        html: icon('layers', 16),
        on: {
          click: (event) => openMenu(event.currentTarget as HTMLElement, [
            { label: t('app.sampleGear'), hint: t('app.sampleGearHint'), onSelect: () => this.loadSample('gear') },
            { label: t('app.sampleIndustrial'), hint: t('app.sampleIndustrialHint'), onSelect: () => this.loadSample('industrial') },
          ], { width: 210 }),
        },
      }),
    ]);

    const editGroup = el('div', { class: 'va-topbar-group' }, [
      this.undoButton,
      this.redoButton,
    ]);
    this.undoButton.addEventListener('click', () => this.store.undo());
    this.redoButton.addEventListener('click', () => this.store.redo());

    const viewGroup = el('div', { class: 'va-topbar-group' }, [
      this.topButton('zoomOut', t('app.zoomOut'), () => this.view.zoomBy(1 / 1.25)),
      this.zoomLabel,
      this.topButton('zoomIn', t('app.zoomIn'), () => this.view.zoomBy(1.25)),
      this.topButton('fit', t('app.fit'), () => this.view.fitToView()),
      this.gridButton,
      this.snapButton,
    ]);
    this.gridButton.addEventListener('click', () => {
      const next = !this.view.isGridVisible();
      this.view.setGrid({ visible: next });
      this.gridButton.classList.toggle('is-active', next);
    });
    this.snapButton.addEventListener('click', () => {
      const next = !this.view.isSnapEnabled();
      this.view.setSnapEnabled(next);
      this.snapButton.classList.toggle('is-active', next);
    });

    this.titleInput.addEventListener('change', () => {
      const title = this.titleInput.value.trim() || t('app.untitled');
      this.store.update((draft) => {
        draft.Meta = draft.Meta ?? {};
        draft.Meta.Title = title;
        draft.Meta.UpdatedAt = new Date().toISOString();
      }, { label: t('cmd.renameDocument') });
    });

    const rightGroup = el('div', { class: 'va-topbar-group', style: { borderLeft: 'none' } }, [
      el('button', {
        class: 'va-icon-btn',
        title: t('app.languageTitle'),
        html: icon('globe', 16),
        on: {
          click: (event) => {
            const anchor = event.currentTarget as HTMLElement;
            openMenu(anchor, LOCALES.map((locale) => ({
              label: locale.label,
              hint: locale.id === getLocale() ? '✓' : '',
              onSelect: () => this.switchLocale(locale.id),
            })), { align: 'right', width: 180 });
          },
        },
      }),
      el('button', {
        class: 'va-btn',
        html: `${icon('image', 14)}<span>${t('app.exportImage')}</span>`,
        title: t('app.exportImageTitle'),
        on: {
          click: (event) => {
            const anchor = event.currentTarget as HTMLElement;
            openMenu(anchor, [
              { label: t('app.exportPng'), onSelect: () => this.exportPng() },
              { label: t('app.exportSvg'), onSelect: () => this.exportSvg() },
            ], { align: 'right', width: 170 });
          },
        },
      }),
      el('button', {
        class: 'va-btn is-primary',
        html: `${icon('play', 14)}<span>${t('app.preview')}</span>`,
        title: t('app.previewTitle'),
        on: { click: () => this.openPreview() },
      }),
      el('button', {
        class: 'va-icon-btn',
        title: t('app.help'),
        html: icon('settings', 16),
        on: { click: () => this.showHelp() },
      }),
    ]);

    return el('header', { class: 'va-topbar' }, [
      el('div', { class: 'va-brand' }, [
        el('span', { class: 'va-brand-mark', text: 'V' }),
        el('span', { text: 'VectAnim' }),
        el('span', { class: 'va-brand-sub', text: t('app.brandSub') }),
      ]),
      this.titleInput,
      fileGroup,
      editGroup,
      viewGroup,
      el('div', { class: 'va-topbar-spacer' }),
      rightGroup,
    ]);
  }

  private topButton(iconName: string, title: string, handler: () => void): HTMLElement {
    return el('button', { class: 'va-icon-btn', title, html: icon(iconName, 16), on: { click: handler } });
  }

  private buildToolbar(): HTMLElement {
    const toolbar = el('aside', { class: 'va-toolbar' });
    TOOLS.forEach((tool) => {
      // Separators are anchored on tool ids, so adding tools does not need index bookkeeping
      if (tool.id === 'line' || tool.id === 'pan') toolbar.append(el('div', { class: 'va-tool-sep' }));
      const label = t(tool.labelKey);
      const hint = tool.hintKey ? t(tool.hintKey) : '';
      const button = el('button', {
        class: `va-tool${tool.id === 'select' ? ' is-active' : ''}`,
        title: hint
          ? t('tool.hintLine', { label, key: tool.key, hint })
          : t('tool.labelLine', { label, key: tool.key }),
        html: `${icon(tool.iconName, 18)}<span class="va-tool-key">${tool.key}</span>`,
        on: { click: () => this.setTool(tool.id) },
      });
      this.toolButtons.set(tool.id, button);
      toolbar.append(button);
    });
    return toolbar;
  }

  private buildRightPanel(): HTMLElement {
    const tabs = el('div', { class: 'va-tabs' });
    const definitions: Array<{ id: string; labelKey: string; iconName: string }> = [
      { id: 'properties', labelKey: 'app.tabProperties', iconName: 'settings' },
      { id: 'variables', labelKey: 'app.tabVariables', iconName: 'variable' },
      { id: 'animations', labelKey: 'app.tabAnimations', iconName: 'clock' },
    ];

    const content = el('div', { style: { flex: '1', minHeight: '0', display: 'flex' } });
    for (const definition of definitions) {
      const host = el('div', { style: { flex: '1', minHeight: '0', display: 'none' } });
      this.panelHosts.set(definition.id, host);
      content.append(host);

      const tab = el('button', {
        class: `va-tab${definition.id === this.activeTab ? ' is-active' : ''}`,
        html: `${icon(definition.iconName, 14)}<span>${t(definition.labelKey)}</span>`,
        on: {
          click: () => {
            this.activeTab = definition.id;
            for (const [id, button] of this.tabButtons) button.classList.toggle('is-active', id === definition.id);
            for (const [id, panelHost] of this.panelHosts) {
              if (id === 'layers') continue;
              panelHost.style.display = id === definition.id ? 'flex' : 'none';
            }
            this.refresh();
          },
        },
      });
      this.tabButtons.set(definition.id, tab);
      tabs.append(tab);
    }

    for (const [id, host] of this.panelHosts) {
      if (id === 'layers') continue;
      host.style.display = id === this.activeTab ? 'flex' : 'none';
    }

    return el('aside', { class: 'va-panel va-panel-right' }, [tabs, content]);
  }

  /* ------------------------------------------------------------------ *
   * AppContext implementation
   * ------------------------------------------------------------------ */

  refresh(): void {
    this.layersPanel.render();
    if (this.activeTab === 'properties') this.propertiesPanel.render();
    if (this.activeTab === 'variables') this.variablesPanel.render();
    if (this.activeTab === 'animations') this.animationsPanel.render();
    this.titleInput.value = this.store.getDocument().Meta?.Title ?? t('app.untitled');
    this.updateStatusBar();
  }

  refreshCanvas(): void {
    this.view.render(this.store.getDocument());
  }

  setTool(tool: ToolId): void {
    this.store.setTool(tool);
    this.view.setTool(tool);
    const definition = TOOLS.find((item) => item.id === tool);
    if (definition?.hintKey) {
      this.store.setStatus(t('tool.statusHint', { label: t(definition.labelKey), hint: t(definition.hintKey) }));
    }
  }

  notify(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    toast(message, { type });
    this.store.setStatus(message);
  }

  openPreview(): void {
    openPreview(this);
  }

  focusShape(id: string): void {
    this.store.setSelection([id]);
  }

  selectGroup(groupId: string): void {
    const group = this.store.getDocument().Groups.find((item) => item.GroupId === groupId);
    if (!group) return;
    this.store.setSelection(group.ShapeIds);
  }

  requestImport(): void {
    void this.openDocument();
  }

  requestSvgImport(): void {
    void this.importSvgFile();
  }

  requestExport(): void {
    this.exportJson();
  }

  /* ------------------------------------------------------------------ *
   * Status
   * ------------------------------------------------------------------ */

  private updateStatusBar(): void {
    const doc = this.store.getDocument();
    const selection = this.store.getSelection();
    const history = this.store.getHistoryDepth();

    this.shapeCountLabel.textContent = t('app.shapeCount', { shapes: doc.Shapes.length, variables: doc.Variables.length });
    this.selectionLabel.textContent = selection.length ? t('app.selectionCount', { count: selection.length }) : t('app.selectionNone');
    this.historyLabel.textContent = t('app.history', { undo: history.undo, redo: history.redo });
    this.statusMessage.textContent = this.store.getStatus();
    this.dirtyDot.classList.toggle('is-dirty', this.store.isDirty());
    this.undoButton.toggleAttribute('disabled', !this.store.canUndo());
    this.redoButton.toggleAttribute('disabled', !this.store.canRedo());
  }

  private syncToolButtons(): void {
    const active = this.store.getTool();
    for (const [id, button] of this.toolButtons) button.classList.toggle('is-active', id === active);
  }

  private syncRuntime(): void {
    const doc = this.store.getDocument();
    const previous = new Map<string, { value: number; external: boolean }>();
    for (const variable of this.runtime.getVariableDefs()) {
      previous.set(variable.Name, {
        value: this.runtime.getVariable(variable.Name),
        external: this.runtime.isExternallyDriven(variable.Name),
      });
    }
    const wasPlaying = this.runtime.playing;
    const time = this.runtime.time;

    this.runtime.loadDocument(doc);

    for (const [name, item] of previous) {
      if (this.runtime.hasVariable(name)) this.runtime.setVariable(name, item.value, item.external);
    }
    if (time > 0) this.runtime.seek(time);
    if (wasPlaying) this.runtime.play();
    this.runtime.recompute();
  }

  /* ------------------------------------------------------------------ *
   * Document operations
   * ------------------------------------------------------------------ */

  private loadInitialDocument(): { document: VectAnimDocument; restored: boolean } {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { document?: unknown };
        if (parsed.document) {
          const result = validateDocument(parsed.document);
          if (!result.hasErrors && result.document.Shapes.length) {
            return { document: result.document, restored: true };
          }
        }
      }
    } catch {
      /* Ignore corrupted autosave data */
    }
    return { document: gearDemoDocument as unknown as VectAnimDocument, restored: false };
  }

  private scheduleAutosave(): void {
    if (this.suppressAutosave) return;
    if (this.autosaveTimer !== undefined) window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({
          savedAt: new Date().toISOString(),
          document: this.store.getDocument(),
        }));
      } catch {
        /* Fail silently when the quota is exceeded */
      }
    }, 900);
  }

  private async newDocument(): Promise<void> {
    if (this.store.isDirty()) {
      const ok = await confirmDialog({
        title: t('dialog.newDocTitle'),
        message: t('dialog.newDocMessage'),
        confirmText: t('dialog.newDocConfirm'),
        danger: true,
      });
      if (!ok) return;
    }
    const doc = createEmptyDocument();
    this.suppressAutosave = true;
    this.store.replaceDocument(doc, { label: t('cmd.newDocument') });
    this.runtime.loadDocument(doc);
    this.view.render(doc);
    this.view.fitToView();
    this.suppressAutosave = false;
    this.notify(t('notify.created'), 'success');
  }

  private async openDocument(): Promise<void> {
    const files = await pickFile('.json,.vectanim.json,application/json');
    if (!files.length) return;
    const text = await files[0].text();
    this.applyDocumentText(text, files[0].name);
  }

  applyDocumentText(text: string, filename: string): void {
    const result = parseDocumentText(text);
    if (result.hasErrors) {
      this.showIssues(t('dialog.importFailed'), result.issues);
      return;
    }
    this.store.replaceDocument(result.document, { label: t('cmd.openDocument', { name: filename }) });
    this.runtime.loadDocument(result.document);
    this.view.render(result.document);
    this.view.fitToView();
    this.notify(t('notify.opened', { name: filename }), 'success');
    if (result.issues.length) this.showIssues(t('dialog.importNotices'), result.issues);
  }

  private exportJson(): void {
    const doc = this.store.getDocument();
    const result = validateDocument(doc);
    const errors = result.issues.filter((issue) => issue.severity === 'error');
    if (errors.length) {
      this.showIssues(t('dialog.exportBlocked'), result.issues);
      return;
    }
    const title = (doc.Meta?.Title ?? 'vectanim').replace(/[\\/:*?"<>|]/g, '_');
    downloadFile(`${title}.vectanim.json`, serializeDocument(result.document), 'application/json');
    this.store.markClean();
    this.notify(t('notify.exportedJson', { name: `${title}.vectanim.json` }), 'success');
    if (result.issues.length) this.showIssues(t('dialog.exportNotices'), result.issues);
  }

  private exportSvg(): void {
    const doc = this.store.getDocument();
    const svg = documentToSvg(doc, (name) => this.runtime.getVariable(name));
    const title = (doc.Meta?.Title ?? 'vectanim').replace(/[\\/:*?"<>|]/g, '_');
    downloadFile(`${title}.svg`, svg, 'image/svg+xml');
    this.notify(t('notify.exportedSvg'), 'success');
  }

  private async exportPng(): Promise<void> {
    try {
      const doc = this.store.getDocument();
      const blob = await documentToPngBlob(doc, (name) => this.runtime.getVariable(name), 2);
      const title = (doc.Meta?.Title ?? 'vectanim').replace(/[\\/:*?"<>|]/g, '_');
      downloadFile(`${title}.png`, blob, 'image/png');
      this.notify(t('notify.exportedPng'), 'success');
    } catch (error) {
      this.notify(t('notify.pngFailed', { error: error instanceof Error ? error.message : String(error) }), 'error');
    }
  }

  private async importSvgFile(): Promise<void> {
    const files = await pickFile('.svg,image/svg+xml');
    if (!files.length) return;
    await this.importSvgText(await files[0].text());
  }

  /** Import SVG text (shared by the file picker, drag & drop and automated tests). */
  async importSvgText(text: string): Promise<number> {
    try {
      const doc = this.store.getDocument();
      const result = await importSvg(text, { offsetX: 20, offsetY: 20 });
      if (!result.shapes.length) {
        this.notify(t('notify.svgNoShapes'), 'warning');
        return 0;
      }

      addShapes(this.store, result.shapes, t('cmd.importSvgShapes', { count: result.shapes.length }));

      // Grow the canvas when the imported content does not fit
      const overflowX = result.width + 40 - doc.Canvas.Width;
      const overflowY = result.height + 40 - doc.Canvas.Height;
      if (overflowX > 0 || overflowY > 0) {
        setCanvasSize(this.store, doc.Canvas.Width + Math.max(0, overflowX), doc.Canvas.Height + Math.max(0, overflowY));
      }

      this.notify(t('notify.svgImported', { count: result.shapes.length }), 'success');
      if (result.warnings.length) this.notify(result.warnings[0], 'warning');
      return result.shapes.length;
    } catch (error) {
      this.notify(t('notify.svgFailed', { error: error instanceof Error ? error.message : String(error) }), 'error');
      return 0;
    }
  }

  private showIssues(title: string, issues: Issue[]): void {
    const list = el('div', { style: { display: 'grid', gap: '4px', maxHeight: '50vh', overflow: 'auto' } });
    for (const issue of issues.slice(0, 60)) {
      list.append(
        el('div', {
          class: `va-hint ${issue.severity === 'error' ? 'is-error' : issue.severity === 'warning' ? 'is-warn' : ''}`,
          html: `<span class="va-mono">${escapeHtml(issue.path)}</span> · ${escapeHtml(issue.message)}`,
        }),
      );
    }
    if (issues.length > 60) list.append(el('div', { class: 'va-hint', text: t('dialog.issuesMore', { count: issues.length - 60 }) }));
    openModal({ title, content: list, width: 620 });
  }

  /* ------------------------------------------------------------------ *
   * Shortcuts
   * ------------------------------------------------------------------ */

  private bindShortcuts(): void {
    window.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (key === 'f1') {
        event.preventDefault();
        this.showHelp();
        return;
      }

      if (typing) return;

      if (key === 'f5') {
        event.preventDefault();
        this.openPreview();
        return;
      }

      if (mod) {
        switch (key) {
          case 'z':
            event.preventDefault();
            if (event.shiftKey) this.store.redo();
            else this.store.undo();
            return;
          case 'y':
            event.preventDefault();
            this.store.redo();
            return;
          case 'c':
            event.preventDefault();
            this.view.setClipboard(this.store.getSelectedShapes());
            this.pasteRun = 0;
            this.notify(t('notify.copied', { count: this.store.getSelection().length }));
            return;
          case 'v':
            event.preventDefault();
            this.paste();
            return;
          case 'd':
            event.preventDefault();
            duplicateShapes(this.store, this.store.getSelection());
            return;
          case 'a':
            event.preventDefault();
            this.store.setSelection(this.store.getDocument().Shapes.map((shape) => shape.Id));
            return;
          case 'g':
            event.preventDefault();
            if (event.shiftKey) ungroupShapes(this.store, this.store.getSelection());
            else groupShapes(this.store, this.store.getSelection());
            return;
          case 's':
            event.preventDefault();
            this.exportJson();
            return;
          case 'o':
            event.preventDefault();
            void this.openDocument();
            return;
          case 'n':
            event.preventDefault();
            void this.newDocument();
            return;
          case '0':
            event.preventDefault();
            this.view.fitToView();
            return;
          case '=':
          case '+':
            event.preventDefault();
            this.view.zoomBy(1.25);
            return;
          case '-':
            event.preventDefault();
            this.view.zoomBy(1 / 1.25);
            return;
          case "'":
            event.preventDefault();
            this.gridButton.click();
            return;
          case ';':
            event.preventDefault();
            this.snapButton.click();
            return;
          case ']':
            event.preventDefault();
            reorderShapes(this.store, this.store.getSelection(), event.shiftKey ? 'front' : 'forward');
            return;
          case '[':
            event.preventDefault();
            reorderShapes(this.store, this.store.getSelection(), event.shiftKey ? 'back' : 'backward');
            return;
          default:
            return;
        }
      }

      if (key === 'delete' || key === 'backspace') {
        event.preventDefault();
        const ids = this.store.getSelection();
        if (ids.length) deleteShapes(this.store, ids);
        return;
      }

      if (key === 'escape') {
        if (this.store.getTool() !== 'select') this.setTool('select');
        else this.store.setSelection([]);
        return;
      }

      if (key.startsWith('arrow')) {
        // Arrow nudge: 1px, or 10px while Shift is held
        const step = event.shiftKey ? 10 : 1;
        const nudges: Record<string, [number, number] | undefined> = {
          left: [-step, 0],
          right: [step, 0],
          up: [0, -step],
          down: [0, step],
        };
        const delta = nudges[key.slice('arrow'.length)];
        if (!delta) return;
        event.preventDefault();
        nudgeShapes(this.store, this.store.getSelection(), delta[0], delta[1]);
        return;
      }

      const tool = TOOLS.find((item) => item.key.toLowerCase() === key);
      if (tool) {
        event.preventDefault();
        this.setTool(tool.id);
      }
    });
  }

  private paste(): void {
    const clipboard = this.view.getClipboard();
    if (!clipboard.length) {
      this.notify(t('notify.clipboardEmpty'), 'warning');
      return;
    }
    const doc = this.store.getDocument();
    let maxZ = doc.Shapes.reduce((max, shape) => Math.max(max, shape.ZIndex), 0);
    // Each paste is offset one more step, so repeated pastes do not pile up
    this.pasteRun += 1;
    const offset = PASTE_OFFSET * this.pasteRun;
    const created: string[] = [];
    this.store.update((draft) => {
      for (const shape of clipboard) {
        const clone = JSON.parse(JSON.stringify(shape)) as typeof shape;
        clone.Id = newId(clone.Type.toLowerCase());
        clone.Name = t('cmd.copySuffix', { name: shape.Name });
        maxZ += 10;
        clone.ZIndex = maxZ;
        translateShape(clone, offset, offset);
        draft.Shapes.push(clone);
        created.push(clone.Id);
      }
    }, { label: t('cmd.pasteShapes') });
    this.store.setSelection(created);
    this.notify(t('notify.pasted', { count: created.length, offset }), 'success');
  }

  /* ------------------------------------------------------------------ *
   * Help
   * ------------------------------------------------------------------ */

  private showHelp(): void {
    const rows: Array<[string, string]> = [
      ['V / L / R / E', t('help.row.tools')],
      ['A / P / N / F / H', t('help.row.tools2')],
      [t('help.row.marquee'), t('help.row.marqueeDesc')],
      [t('help.row.addSelect'), t('help.row.addSelectDesc')],
      [t('help.row.shiftMarquee'), t('help.row.shiftMarqueeDesc')],
      [t('help.row.shiftDraw'), t('help.row.shiftDrawDesc')],
      [t('help.row.altArc'), t('help.row.altArcDesc')],
      [t('help.row.spacePan'), t('help.row.spacePanDesc')],
      [t('help.row.wheel'), t('help.row.wheelDesc')],
      [t('help.row.ctrlDrag'), t('help.row.ctrlDragDesc')],
      [t('help.row.undo'), t('help.row.undoDesc')],
      [t('help.row.clipboard'), t('help.row.clipboardDesc')],
      [t('help.row.selectAll'), t('help.row.selectAllDesc')],
      [t('help.row.group'), t('help.row.groupDesc')],
      [t('help.row.zorder'), t('help.row.zorderDesc')],
      [t('help.row.nudge'), t('help.row.nudgeDesc')],
      [t('help.row.files'), t('help.row.filesDesc')],
      [t('help.row.zoom'), t('help.row.zoomDesc')],
      [t('help.row.preview'), t('help.row.previewDesc')],
    ];

    const table = el('div', { style: { display: 'grid', gap: '5px' } },
      rows.map(([keys, desc]) => el('div', { class: 'va-row', style: { gridTemplateColumns: '170px 1fr' } }, [
        el('span', { class: 'va-mono', style: { color: 'var(--accent)' }, text: keys }),
        el('span', { text: desc }),
      ])),
    );

    const content = el('div', { style: { display: 'grid', gap: '12px' } }, [
      el('div', { class: 'va-hint', html: t('help.workflow') }),
      table,
      el('div', { class: 'va-hint', html: t('help.functions') }),
    ]);

    openModal({ title: t('help.title'), content, width: 620 });
  }

  /* ------------------------------------------------------------------ *
   * Misc
   * ------------------------------------------------------------------ */

  private installResizeObserver(host: HTMLElement): void {
    let fitted = false;
    const observer = new ResizeObserver(() => {
      this.view.resize();
      if (!fitted) {
        fitted = true;
        this.view.fitToView();
      }
    });
    observer.observe(host);
    window.addEventListener('resize', () => this.view.resize());
  }

  /** Allow dropping .vectanim.json / .svg files onto the window to import them. */
  private installDragDrop(): void {
    const stop = (event: DragEvent): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    this.root.addEventListener('dragover', (event) => {
      stop(event);
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });
    this.root.addEventListener('drop', (event) => {
      stop(event);
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      const name = file.name.toLowerCase();
      if (name.endsWith('.svg')) {
        void file.text().then((text) => this.importSvgText(text));
        return;
      }
      if (name.endsWith('.json')) {
        void file.text().then((text) => this.applyDocumentText(text, file.name));
        return;
      }
      this.notify(t('notify.dropUnsupported'), 'warning');
    });
  }

  loadSample(kind: 'gear' | 'industrial'): void {
    const doc = kind === 'gear'
      ? (gearDemoDocument as unknown as VectAnimDocument)
      : (industrialDemoDocument as unknown as VectAnimDocument);
    const result = validateDocument(doc);
    this.store.replaceDocument(result.document, { label: t('cmd.loadSample') });
    this.runtime.loadDocument(result.document);
    this.view.render(result.document);
    this.view.fitToView();
    this.notify(t('notify.sampleLoaded'), 'success');
  }

  /* ------------------------------------------------------------------ *
   * Localization
   * ------------------------------------------------------------------ */

  /** Switching locale reloads the page: every label is created once at boot. */
  private switchLocale(locale: 'en' | 'zh'): void {
    if (locale === getLocale()) return;
    setLocale(locale);
    window.location.reload();
  }

  private syncDocumentLanguage(): void {
    document.documentElement.lang = getLocale() === 'zh' ? 'zh-CN' : 'en';
    document.title = t('app.title');
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] ?? char));
}
