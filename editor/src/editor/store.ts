/**
 * Editor document store: single source of truth + undo/redo + subscription.
 *
 * Design:
 *  - The document is immutable: every change produces a new snapshot (structured clone)
 *    and the undo stack keeps JSON snapshots.
 *  - High-frequency operations such as dragging only push one history entry when committed,
 *    so the history does not explode.
 *  - Consecutive tweaks of the same operation (e.g. dragging a slider) are merged into one
 *    entry via `coalesceKey`.
 */

import { cloneDocumentDeep } from '../schema/clone';
import type { GroupDef, Shape, VectAnimDocument } from '../schema/types';
import { t } from '../i18n';

export type StoreEventType = 'document' | 'selection' | 'history' | 'tool' | 'status';

export interface StoreEvent {
  type: StoreEventType;
  /** Label of the operation that caused the change, shown in the status bar. */
  label?: string;
}

export type StoreListener = (event: StoreEvent) => void;

export interface MutateOptions {
  label?: string;
  /** Consecutive changes with the same key are merged into one history entry. */
  coalesceKey?: string;
  /** Do not write history (used for derived syncs, e.g. Fabric write-back). */
  silent?: boolean;
}

interface HistoryEntry {
  snapshot: string;
  label: string;
  coalesceKey?: string;
  time: number;
}

const MAX_HISTORY = 120;
const COALESCE_WINDOW_MS = 700;

export class EditorStore {
  private document: VectAnimDocument;
  private selection: string[] = [];
  private tool = 'select';
  private status = '';
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<StoreListener>();
  private dirty = false;
  private filePathHint = '';

  constructor(document: VectAnimDocument) {
    this.document = cloneDocumentDeep(document);
  }

  /* ------------------------------ subscribe ------------------------------ */

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: StoreEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(t('store.listenerError'), error);
      }
    }
  }

  /* ------------------------------ read ------------------------------ */

  getDocument(): VectAnimDocument {
    return this.document;
  }

  getSelection(): readonly string[] {
    return this.selection;
  }

  getTool(): string {
    return this.tool;
  }

  getStatus(): string {
    return this.status;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  markClean(): void {
    this.dirty = false;
    this.emit({ type: 'status' });
  }

  setFilePathHint(path: string): void {
    this.filePathHint = path;
  }

  getFilePathHint(): string {
    return this.filePathHint;
  }

  getShape(id: string): Shape | undefined {
    return this.document.Shapes.find((shape) => shape.Id === id);
  }

  getSelectedShapes(): Shape[] {
    const ids = new Set(this.selection);
    return this.document.Shapes.filter((shape) => ids.has(shape.Id));
  }

  getGroupOfShape(shapeId: string): GroupDef | undefined {
    return this.document.Groups.find((group) => group.ShapeIds.includes(shapeId));
  }

  /* ------------------------------ write ------------------------------ */

  /** Replace the whole document (open file / new document). */
  replaceDocument(document: VectAnimDocument, options: { label?: string; resetHistory?: boolean; keepSelection?: boolean } = {}): void {
    this.document = cloneDocumentDeep(document);
    if (options.resetHistory !== false) {
      this.undoStack = [];
      this.redoStack = [];
    }
    if (!options.keepSelection) this.selection = [];
    else this.selection = this.selection.filter((id) => this.getShape(id) !== undefined);
    this.dirty = false;
    this.emit({ type: 'document', label: options.label });
    this.emit({ type: 'selection' });
    this.emit({ type: 'history' });
  }

  /**
   * Mutate the document. The mutator works on a clone; afterwards the clone replaces
   * the current immutable document. If the mutator throws, the change is discarded.
   */
  update(mutator: (draft: VectAnimDocument) => void, options: MutateOptions = {}): boolean {
    const previousSnapshot = options.silent ? null : this.captureSnapshot();
    const draft = cloneDocumentDeep(this.document);
    try {
      mutator(draft);
    } catch (error) {
      console.error('[store] document update failed', error);
      this.status = t('store.operationFailed', { error: error instanceof Error ? error.message : String(error) });
      this.emit({ type: 'status' });
      return false;
    }

    this.document = draft;
    this.selection = this.selection.filter((id) => this.getShape(id) !== undefined);

    if (!options.silent && previousSnapshot) {
      this.pushHistory(previousSnapshot, options.label ?? t('store.defaultLabel'), options.coalesceKey);
      this.dirty = true;
      this.emit({ type: 'history' });
    }

    this.emit({ type: 'document', label: options.label });
    return true;
  }

  setSelection(ids: readonly string[], options: { silent?: boolean } = {}): void {
    const next = [...new Set(ids)].filter((id) => this.getShape(id) !== undefined);
    const same = next.length === this.selection.length && next.every((id, index) => this.selection[index] === id);
    this.selection = next;
    if (!same || !options.silent) this.emit({ type: 'selection' });
  }

  setTool(tool: string): void {
    if (this.tool === tool) return;
    this.tool = tool;
    this.emit({ type: 'tool' });
  }

  setStatus(status: string): void {
    this.status = status;
    this.emit({ type: 'status' });
  }

  /* ------------------------------ history ------------------------------ */

  private captureSnapshot(): string {
    return JSON.stringify(this.document);
  }

  private pushHistory(snapshot: string, label: string, coalesceKey?: string): void {
    const now = Date.now();
    const top = this.undoStack[this.undoStack.length - 1];
    if (
      coalesceKey &&
      top &&
      top.coalesceKey === coalesceKey &&
      now - top.time < COALESCE_WINDOW_MS
    ) {
      // Merge: keep the old snapshot (state before the operation), only refresh label and time
      top.time = now;
      top.label = label;
      this.redoStack = [];
      return;
    }

    this.undoStack.push({ snapshot, label, coalesceKey, time: now });
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  peekUndoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label;
  }

  peekRedoLabel(): string | undefined {
    return this.redoStack[this.redoStack.length - 1]?.label;
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.redoStack.push({ snapshot: this.captureSnapshot(), label: entry.label, time: Date.now() });
    this.document = JSON.parse(entry.snapshot) as VectAnimDocument;
    this.selection = this.selection.filter((id) => this.getShape(id) !== undefined);
    this.dirty = true;
    this.emit({ type: 'document', label: t('store.undoLabel', { label: entry.label }) });
    this.emit({ type: 'selection' });
    this.emit({ type: 'history' });
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.undoStack.push({ snapshot: this.captureSnapshot(), label: entry.label, time: Date.now() });
    this.document = JSON.parse(entry.snapshot) as VectAnimDocument;
    this.selection = this.selection.filter((id) => this.getShape(id) !== undefined);
    this.dirty = true;
    this.emit({ type: 'document', label: t('store.redoLabel', { label: entry.label }) });
    this.emit({ type: 'selection' });
    this.emit({ type: 'history' });
    return true;
  }

  getHistoryDepth(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }
}
