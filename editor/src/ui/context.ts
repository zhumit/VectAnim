import type { EditorStore } from '../editor/store';
import type { CanvasView, ToolId } from '../editor/canvasView';
import type { VectAnimRuntime } from '../engine/runtime';

/** Contract between panels and the app shell, so panels do not depend on EditorApp (circular imports) */
export interface AppContext {
  readonly store: EditorStore;
  readonly view: CanvasView;
  readonly runtime: VectAnimRuntime;
  refresh(): void;
  /** Repaint the canvas only (used when variable values change, to avoid rebuilding the whole tree) */
  refreshCanvas(): void;
  setTool(tool: ToolId): void;
  notify(message: string, type?: 'info' | 'success' | 'warning' | 'error'): void;
  openPreview(): void;
  requestExport(): void;
  requestImport(): void;
  requestSvgImport(): void;
  focusShape(id: string): void;
  selectGroup(groupId: string): void;
}
