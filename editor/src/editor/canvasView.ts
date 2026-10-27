/**
 * Fabric canvas view.
 *
 * Responsibility boundaries:
 *  - The document is the single source of truth; this class projects it onto the
 *    Fabric canvas and writes direct user manipulations (drag/scale/rotate) back
 *    to the document in one shot on commit, so nothing jitters mid-drag.
 *  - Write-back bakes scale into the geometry (rect width/height, ellipse radii,
 *    polygon vertices, path data) so Width/Radius in the document are always the
 *    real size and the WPF side never has to understand scale.
 *  - Properties bound to a variable lock the matching interaction (bound position
 *    → no move, bound size → no scale, bound angle → no rotate), so manual edits
 *    and data-driven values never fight each other.
 */

import {
  ActiveSelection,
  Canvas,
  Ellipse,
  FabricObject,
  Path as FabricPath,
  Point,
  Polygon,
  Polyline,
  Rect,
} from 'fabric';
import type { Shape, ShapeType, VectAnimDocument } from '../schema/types';
import { createShape, type ShapeGeometryInput } from '../schema/factory';
import { isBindRef, resolveNumber } from '../schema/valueRef';
import { normalizeColor } from '../engine/color';
import { parsePathData, pathBounds, stringifyPathData, type PathCommand } from '../engine/pathData';
import { resolveShape, type ResolvedShape } from '../engine/resolve';
import {
  composeGroupTransform,
  invertComposedTransform,
  isIdentityGroupTransform,
  resolveGroupTransform,
  type ResolvedGroupTransform,
} from '../engine/groupTransform';
import { t } from '../i18n';
import { containsAll, expandSelectionToGroups } from './groupSelection';
import type { ShapeCopiesSnapshot } from './commands';
import { translateShape } from './geometry';
import {
  constrainDragPoint,
  ellipseFromDrag,
  isDragDrawKind,
  rectFromDrag,
  semicircleArcData,
} from './drawGeometry';

export type ToolId = 'select' | 'line' | 'rect' | 'ellipse' | 'arc' | 'polygon' | 'pen' | 'freehand' | 'pan';

type FabricObjectOptions = Record<string, unknown>;

export interface ShapeEdit {
  shape: Shape;
  label: string;
}

export interface CanvasViewCallbacks {
  getDocument(): VectAnimDocument;
  getVariable(name: string): number | undefined;
  onSelectionChange(ids: string[]): void;
  onShapeEdits(edits: ShapeEdit[]): void;
  onCreateShape(shape: Shape, label: string): void;
  /** Ctrl + drag to duplicate: the snapshot is already offset to the drop point, so inserting it yields the copy under the cursor */
  onDuplicateShapes?(snapshot: ShapeCopiesSnapshot): void;
  onZoomChange(zoom: number, offsetX: number, offsetY: number): void;
  onPointerMove(point: { x: number; y: number } | null): void;
  onStatus(message: string): void;
  onRequestPathEdit?(shapeId: string): void;
}

interface DrawState {
  kind: ToolId;
  /** Drag tools hold [start, constrained end]; multi-point / freehand accumulate points */
  points: Array<{ x: number; y: number }>;
  preview: FabricObject | null;
  start: { x: number; y: number } | null;
  /** Raw cursor point for drag tools (before Shift constraint), used to recompute the preview when modifiers change */
  cursor: { x: number; y: number } | null;
  shift: boolean;
  alt: boolean;
}

/** Everything a group contributes to the rendering of one of its members */
interface GroupLayer {
  /** Absent when the group transform is the identity */
  transform?: ResolvedGroupTransform;
  visible: boolean;
  opacity: number;
}

/** Multi-select keys: Shift / Ctrl / Cmd click adds to the selection; Ctrl + drag starts duplicate-drag */
const SELECTION_KEYS: Array<'shiftKey' | 'ctrlKey' | 'metaKey'> = ['shiftKey', 'ctrlKey', 'metaKey'];

/**
 * In-progress state of a Ctrl + drag duplicate.
 *
 * The original shapes stay put while dragging (and so does the document); what
 * follows the cursor is a set of temporary "ghost copies" created here. Only on
 * mouse-up are the copies written to the document at the offset; releasing Ctrl
 * mid-drag discards the whole set, which amounts to cancelling the duplicate.
 */
interface DuplicateDragState {
  /** Document snapshot taken before the drag (original coordinates); translated by the offset and inserted on commit */
  shapes: Shape[];
  groups: Array<{ Name: string; ShapeIds: string[] }>;
  /** Temporary copies that follow the cursor: not in the objects map, excluded from hit-testing and snapping */
  ghosts: FabricObject[];
  /** Base left/top of the ghost copies (origin at center); the whole set is translated by the offset */
  bases: Array<{ left: number; top: number }>;
  /** Scene coordinates at mouse-down */
  start: { x: number; y: number };
  /** Applied offset so far (including snap correction) */
  delta: { x: number; y: number };
  /** Whether the click-jitter threshold has been passed */
  moved: boolean;
  /** Shapes hit at mouse-down: with no drag they are removed from the selection, matching Ctrl + click semantics */
  toggleIds: string[];
  /** Selection before mouse-down, restored verbatim when the duplicate is cancelled */
  baseSelection: string[];
  /** Original shapes whose interaction is temporarily disabled during the drag */
  locked: FabricObject[];
  /** Marquee-selection switch temporarily turned off during the drag (otherwise Fabric draws a marquee) */
  selectionBefore: boolean;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;
const SNAP_TOLERANCE = 6;

/**
 * Crosshair cursor for the drawing tools: the system `crosshair` is almost
 * invisible on a white artboard, so we draw one ourselves — dark line with a
 * white outline (dark line on white, white outline on the dark workspace) — and
 * use the center of the glyph as the hotspot.
 */
const DRAW_CURSOR_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">',
  '<g fill="none" stroke="#ffffff" stroke-width="3.6" stroke-linecap="round">',
  '<path d="M12 1.5v7M12 15.5v7M1.5 12h7M15.5 12h7"/></g>',
  '<g fill="none" stroke="#0b1220" stroke-width="1.6" stroke-linecap="round">',
  '<path d="M12 1.5v7M12 15.5v7M1.5 12h7M15.5 12h7"/></g>',
  '</svg>',
].join('');

const DRAW_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(DRAW_CURSOR_SVG)}") 12 12, crosshair`;

export class CanvasView {
  private canvas: Canvas | null = null;
  private host: HTMLDivElement | null = null;
  private readonly objects = new Map<string, FabricObject>();
  private readonly shapeIdOf = new WeakMap<FabricObject, string>();
  private readonly pathDataCache = new WeakMap<FabricObject, string>();
  private callbacks: CanvasViewCallbacks;
  private tool: ToolId = 'select';
  private gridVisible = true;
  private gridSize = 20;
  private snapEnabled = true;
  private syncing = false;
  private draw: DrawState | null = null;
  private spaceDown = false;
  private panState: { startX: number; startY: number; originX: number; originY: number } | null = null;
  /** Selection at mouse-down during Shift marquee: Fabric clears the selection on empty-canvas click, so keep it for merging */
  private marqueeBase: string[] | null = null;
  /** In-progress Ctrl + drag duplicate; without dragging, falls back to Ctrl + click selection toggling */
  private duplicateDrag: DuplicateDragState | null = null;
  private readonly artboard: HTMLDivElement;
  private readonly gridLayer: HTMLDivElement;
  private readonly stage: HTMLDivElement;
  private clipboard: Shape[] = [];

  constructor(host: HTMLDivElement, callbacks: CanvasViewCallbacks) {
    this.host = host;
    this.callbacks = callbacks;

    this.stage = document.createElement('div');
    this.stage.className = 'va-stage';

    this.artboard = document.createElement('div');
    this.artboard.className = 'va-artboard';

    this.gridLayer = document.createElement('div');
    this.gridLayer.className = 'va-grid';
    this.artboard.appendChild(this.gridLayer);

    const canvasHost = document.createElement('div');
    canvasHost.className = 'va-canvas-surface';
    const canvasElement = document.createElement('canvas');

    this.stage.appendChild(this.artboard);
    this.stage.appendChild(canvasHost);
    canvasHost.appendChild(canvasElement);
    host.appendChild(this.stage);

    this.canvas = new Canvas(canvasElement, {
      // Marquee selection and Shift/Ctrl click multi-select are both handled by Fabric (built in, no need to reimplement)
      selection: true,
      selectionKey: [...SELECTION_KEYS],
      selectionColor: 'rgba(56,189,248,0.12)',
      selectionBorderColor: '#38BDF8',
      selectionLineWidth: 1.5,
      selectionDashArray: [4, 3],
      preserveObjectStacking: true,
      fireRightClick: false,
      stopContextMenu: true,
      uniformScaling: false,
      targetFindTolerance: 4,
      enableRetinaScaling: true,
    });

    this.bindEvents();
    this.resize();
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */

  resize(): void {
    if (!this.canvas || !this.host) return;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (width <= 0 || height <= 0) return;
    this.canvas.setDimensions({ width, height });
    this.canvas.requestRenderAll();
    this.applyArtboardTransform();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    this.canvas?.dispose();
    this.canvas = null;
    this.stage.remove();
  }

  /* ------------------------------------------------------------------ *
   * View transform
   * ------------------------------------------------------------------ */

  getViewport(): { zoom: number; offsetX: number; offsetY: number } {
    const vpt = this.canvas?.viewportTransform ?? [1, 0, 0, 1, 0, 0];
    return { zoom: vpt[0], offsetX: vpt[4], offsetY: vpt[5] };
  }

  getZoom(): number {
    return this.canvas?.getZoom() ?? 1;
  }

  setZoom(zoom: number, anchor?: { x: number; y: number }): void {
    if (!this.canvas) return;
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    const point = anchor ? new Point(anchor.x, anchor.y) : new Point(this.canvas.getWidth() / 2, this.canvas.getHeight() / 2);
    this.canvas.zoomToPoint(point, clamped);
    this.canvas.requestRenderAll();
    this.applyArtboardTransform();
    this.emitZoom();
  }

  zoomBy(factor: number): void {
    this.setZoom(this.getZoom() * factor);
  }

  fitToView(): void {
    if (!this.canvas) return;
    const doc = this.callbacks.getDocument();
    const padding = 56;
    const zoom = Math.min(
      (this.canvas.getWidth() - padding * 2) / doc.Canvas.Width,
      (this.canvas.getHeight() - padding * 2) / doc.Canvas.Height,
    );
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    const offsetX = (this.canvas.getWidth() - doc.Canvas.Width * clamped) / 2;
    const offsetY = (this.canvas.getHeight() - doc.Canvas.Height * clamped) / 2;
    this.canvas.setViewportTransform([clamped, 0, 0, clamped, offsetX, offsetY]);
    this.canvas.requestRenderAll();
    this.applyArtboardTransform();
    this.emitZoom();
  }

  resetZoom(): void {
    this.setZoom(1);
  }

  private emitZoom(): void {
    const view = this.getViewport();
    this.callbacks.onZoomChange(view.zoom, view.offsetX, view.offsetY);
  }

  /** Keep the CSS artboard pixel-aligned with the Fabric viewport */
  private applyArtboardTransform(): void {
    const doc = this.callbacks.getDocument();
    const { zoom, offsetX, offsetY } = this.getViewport();
    this.artboard.style.width = `${doc.Canvas.Width}px`;
    this.artboard.style.height = `${doc.Canvas.Height}px`;
    this.artboard.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`;
    this.artboard.style.transformOrigin = '0 0';
    this.artboard.style.background = normalizeColor(doc.Canvas.Background) ?? '#FFFFFFFF';
    this.gridLayer.style.display = this.gridVisible ? 'block' : 'none';
    this.gridLayer.style.backgroundSize = `${this.gridSize}px ${this.gridSize}px`;
  }

  setGrid(options: { visible?: boolean; size?: number }): void {
    if (options.visible !== undefined) this.gridVisible = options.visible;
    if (options.size !== undefined) this.gridSize = Math.max(2, options.size);
    this.applyArtboardTransform();
  }

  isGridVisible(): boolean {
    return this.gridVisible;
  }

  getGridSize(): number {
    return this.gridSize;
  }

  setSnapEnabled(enabled: boolean): void {
    this.snapEnabled = enabled;
  }

  isSnapEnabled(): boolean {
    return this.snapEnabled;
  }

  /* ------------------------------------------------------------------ *
   * Document → canvas
   * ------------------------------------------------------------------ */

  render(document: VectAnimDocument): void {
    if (!this.canvas) return;
    // With a multi-selection the shapes live inside an ActiveSelection, so writing
    // left/top directly applies the group transform twice and the shapes appear to
    // "jump" on mouse-up. Discard the selection first, write the coordinates, then
    // restore it exactly as it was.
    const activeIds = this.selectedIds();
    this.syncing = true;
    try {
      if (activeIds.length) this.canvas.discardActiveObject();

      const resolver = this.callbacks.getVariable;
      const alive = new Set<string>();
      const sorted = [...document.Shapes].sort((a, b) => (a.ZIndex === b.ZIndex ? 0 : a.ZIndex - b.ZIndex));

      // Groups are an outer layer over their members: resolve each group once per pass and apply
      // its transform / visibility / opacity to every member object.
      const groupLayers = new Map<string, GroupLayer>();
      const groupOfShape = new Map<string, string>();
      for (const group of document.Groups ?? []) {
        for (const id of group.ShapeIds ?? []) groupOfShape.set(id, group.GroupId);
      }
      const layerOf = (shapeId: string): GroupLayer | undefined => {
        const groupId = groupOfShape.get(shapeId);
        if (!groupId) return undefined;
        let layer = groupLayers.get(groupId);
        if (!layer) {
          const group = (document.Groups ?? []).find((item) => item.GroupId === groupId);
          if (!group) return undefined;
          const transform = resolveGroupTransform(group, resolver);
          layer = {
            transform: isIdentityGroupTransform(transform) ? undefined : transform,
            visible: group.Visible !== false,
            opacity: Math.max(0, Math.min(1, resolveNumber(group.Opacity, resolver, 1))),
          };
          groupLayers.set(groupId, layer);
        }
        return layer;
      };

      sorted.forEach((shape, index) => {
        alive.add(shape.Id);
        const resolved = resolveShape(shape, resolver);
        let object = this.objects.get(shape.Id);
        if (!object) {
          object = this.createObject(shape, resolved);
          this.objects.set(shape.Id, object);
          this.shapeIdOf.set(object, shape.Id);
          this.canvas!.add(object);
        } else {
          this.updateObject(object, shape, resolved);
        }
        this.applyGroupLayer(object, resolved, layerOf(shape.Id));
        if (this.canvas!.getObjects().indexOf(object) !== index) {
          this.canvas!.moveObjectTo(object, index);
        }
      });

      for (const [id, object] of [...this.objects]) {
        if (!alive.has(id)) {
          this.canvas!.remove(object);
          this.objects.delete(id);
        }
      }

      if (activeIds.length) this.applySelection(activeIds.filter((id) => this.objects.has(id)));

      this.applyArtboardTransform();
      this.canvas.requestRenderAll();
    } finally {
      this.syncing = false;
    }
  }

  private commonOptions(shape: Shape, resolved: ResolvedShape): FabricObjectOptions {
    return {
      originX: 'center',
      originY: 'center',
      fill: resolved.fill ?? null,
      stroke: resolved.stroke ?? null,
      strokeWidth: resolved.stroke ? resolved.strokeThickness : 0,
      strokeLineCap: resolved.lineCap === 'Round' ? 'round' : resolved.lineCap === 'Square' ? 'square' : 'butt',
      strokeLineJoin: resolved.lineJoin === 'Round' ? 'round' : resolved.lineJoin === 'Bevel' ? 'bevel' : 'miter',
      opacity: resolved.opacity,
      objectCaching: false,
      noScaleCache: true,
      borderColor: '#38BDF8',
      cornerColor: '#38BDF8',
      cornerStrokeColor: '#0B1220',
      cornerStyle: 'circle',
      cornerSize: 9,
      transparentCorners: false,
      padding: 2,
      lockScalingFlip: true,
      visible: shape.IsVisible !== false,
    };
  }

  private createObject(shape: Shape, resolved: ResolvedShape): FabricObject {
    const options = this.commonOptions(shape, resolved);
    let object: FabricObject;

    switch (resolved.geometry.kind) {
      case 'rect':
        object = new Rect({
          ...(options as object),
          left: resolved.geometry.x + resolved.geometry.width / 2,
          top: resolved.geometry.y + resolved.geometry.height / 2,
          width: Math.max(0.01, resolved.geometry.width),
          height: Math.max(0.01, resolved.geometry.height),
          rx: resolved.geometry.rx,
          ry: resolved.geometry.ry,
        });
        break;
      case 'ellipse':
        object = new Ellipse({
          ...(options as object),
          left: resolved.geometry.cx,
          top: resolved.geometry.cy,
          rx: Math.max(0.01, resolved.geometry.rx),
          ry: Math.max(0.01, resolved.geometry.ry),
        });
        break;
      case 'line': {
        const points = [
          { x: resolved.geometry.x1, y: resolved.geometry.y1 },
          { x: resolved.geometry.x2, y: resolved.geometry.y2 },
        ];
        object = new Polyline(points, {
          ...(options as object),
          fill: null,
          left: (resolved.geometry.x1 + resolved.geometry.x2) / 2,
          top: (resolved.geometry.y1 + resolved.geometry.y2) / 2,
        });
        break;
      }
      case 'polygon': {
        const points = resolved.geometry.points.map((point) => ({ x: point.x, y: point.y }));
        if (points.length < 2) points.push({ x: (points[0]?.x ?? 0) + 1, y: points[0]?.y ?? 0 });
        const center = boundsCenter(points);
        const Ctor = resolved.geometry.closed ? Polygon : Polyline;
        object = new Ctor(points, {
          ...(options as object),
          left: center.x,
          top: center.y,
          fill: resolved.geometry.closed ? (options as { fill?: string | null }).fill : null,
        });
        break;
      }
      case 'path': {
        const bounds = pathBounds(safeParse(resolved.geometry.data));
        object = new FabricPath(resolved.geometry.data || 'M 0,0 L 1,1', {
          ...(options as object),
          left: bounds.x + bounds.width / 2 + resolved.geometry.offsetX,
          top: bounds.y + bounds.height / 2 + resolved.geometry.offsetY,
        });
        this.pathDataCache.set(object, resolved.geometry.data);
        break;
      }
      default:
        object = new Rect({ ...(options as object), width: 10, height: 10 });
        break;
    }

    object.set({ angle: resolved.transform.angle, scaleX: resolved.transform.sx, scaleY: resolved.transform.sy });
    this.applyInteractionLocks(object, shape);
    object.setCoords();
    return object;
  }

  private updateObject(object: FabricObject, shape: Shape, resolved: ResolvedShape): void {
    const options = this.commonOptions(shape, resolved);

    switch (resolved.geometry.kind) {
      case 'rect':
        object.set({
          ...(options as object),
          left: resolved.geometry.x + resolved.geometry.width / 2,
          top: resolved.geometry.y + resolved.geometry.height / 2,
          width: Math.max(0.01, resolved.geometry.width),
          height: Math.max(0.01, resolved.geometry.height),
          rx: resolved.geometry.rx,
          ry: resolved.geometry.ry,
        });
        break;
      case 'ellipse':
        object.set({
          ...(options as object),
          left: resolved.geometry.cx,
          top: resolved.geometry.cy,
          rx: Math.max(0.01, resolved.geometry.rx),
          ry: Math.max(0.01, resolved.geometry.ry),
        });
        break;
      case 'line': {
        const polyline = object as Polyline;
        polyline.set({
          ...(options as object),
          fill: null,
          points: [
            { x: resolved.geometry.x1, y: resolved.geometry.y1 },
            { x: resolved.geometry.x2, y: resolved.geometry.y2 },
          ],
        });
        polyline.setDimensions();
        polyline.set({
          left: (resolved.geometry.x1 + resolved.geometry.x2) / 2,
          top: (resolved.geometry.y1 + resolved.geometry.y2) / 2,
        });
        break;
      }
      case 'polygon': {
        const polyline = object as Polyline;
        const points = resolved.geometry.points.map((point) => ({ x: point.x, y: point.y }));
        polyline.set({ ...(options as object), points });
        polyline.setDimensions();
        polyline.set({
          left: boundsCenter(points).x,
          top: boundsCenter(points).y,
          fill: resolved.geometry.closed ? (options as { fill?: string | null }).fill : null,
        });
        break;
      }
      case 'path': {
        const path = object as FabricPath;
        const data = resolved.geometry.data;
        if (this.pathDataCache.get(object) !== data) {
          // Fabric exposes no public path update entry point; _setPath is the widely used internal path
          (path as unknown as { _setPath(data: string): void })._setPath(data || 'M 0,0 L 1,1');
          this.pathDataCache.set(object, data);
        }
        const bounds = pathBounds(safeParse(data));
        path.set({
          ...(options as object),
          left: bounds.x + bounds.width / 2 + resolved.geometry.offsetX,
          top: bounds.y + bounds.height / 2 + resolved.geometry.offsetY,
        });
        break;
      }
      default:
        break;
    }

    object.set({
      angle: resolved.transform.angle,
      scaleX: resolved.transform.sx,
      scaleY: resolved.transform.sy,
      visible: shape.IsVisible !== false,
      opacity: resolved.opacity,
    });
    this.applyInteractionLocks(object, shape);
    object.setCoords();
  }

  /**
   * Project a group's layer (transform / visibility / opacity) onto one member object.
   *
   * Members are drawn as separate Fabric objects — there is no Fabric Group — so the group layer
   * has to be applied per object. The transform is composed on top of the object's own transform.
   */
  private applyGroupLayer(object: FabricObject, resolved: ResolvedShape, layer: GroupLayer | undefined): void {
    if (!layer) return;

    if (layer.transform) {
      const composed = composeGroupTransform(layer.transform, {
        angle: object.angle,
        sx: object.scaleX,
        sy: object.scaleY,
        centerX: object.left,
        centerY: object.top,
      });
      object.set({
        angle: composed.angle,
        scaleX: composed.sx,
        scaleY: composed.sy,
        left: composed.centerX,
        top: composed.centerY,
      });
    }

    object.set({
      visible: resolved.visible !== false && layer.visible,
      opacity: Math.max(0, Math.min(1, resolved.opacity * layer.opacity)),
    });
    object.setCoords();
  }

  /** Bound properties → lock the matching interaction, so manual edits are not overwritten by data-driven values */
  private applyInteractionLocks(object: FabricObject, shape: Shape): void {
    const positionBound = isPositionBound(shape);
    const sizeBound = isSizeBound(shape);
    const rotationBound = isBindRef(shape.RenderTransform?.Rotate?.Value);

    object.set({
      lockMovementX: positionBound,
      lockMovementY: positionBound,
      lockScalingX: sizeBound,
      lockScalingY: sizeBound,
      lockRotation: rotationBound,
    });
  }

  /* ------------------------------------------------------------------ *
   * Selection sync
   * ------------------------------------------------------------------ */

  setSelection(ids: readonly string[]): void {
    if (!this.canvas) return;
    // Skip rebuilding the ActiveSelection when it is already this selection: rebuilding interrupts an in-flight drag transform
    const current = this.selectedIds();
    if (current.length === ids.length && current.every((id) => ids.includes(id))) return;
    this.syncing = true;
    try {
      this.applySelection(ids);
    } finally {
      this.syncing = false;
    }
  }

  selectedIds(): string[] {
    if (!this.canvas) return [];
    return this.canvas.getActiveObjects()
      .map((object) => this.shapeIdOf.get(object))
      .filter((id): id is string => !!id);
  }

  /* ------------------------------------------------------------------ *
   * Tools
   * ------------------------------------------------------------------ */

  setTool(tool: ToolId): void {
    this.tool = tool;
    this.cancelDraw();
    if (!this.canvas) return;
    const isSelect = tool === 'select';
    this.canvas.selection = isSelect;
    this.applyCursor(this.cursorForTool());
    this.canvas.hoverCursor = isSelect ? 'move' : DRAW_CURSOR;
    for (const object of this.objects.values()) {
      object.selectable = isSelect;
      object.evented = isSelect;
    }
    if (!isSelect) this.canvas.discardActiveObject();
    this.canvas.requestRenderAll();
  }

  /** Cursor for the current tool: pan = grab, select = arrow, draw = custom crosshair (the system crosshair is invisible on a white artboard) */
  private cursorForTool(): string {
    if (this.tool === 'pan') return 'grab';
    return this.tool === 'select' ? 'default' : DRAW_CURSOR;
  }

  /** Change the cursor immediately: setting defaultCursor alone only refreshes on the next mousemove */
  private applyCursor(cursor: string): void {
    const canvas = this.canvas;
    if (!canvas) return;
    canvas.defaultCursor = cursor;
    canvas.upperCanvasEl.style.cursor = cursor;
  }

  getTool(): ToolId {
    return this.tool;
  }

  private beginDraw(point: { x: number; y: number }, kind: ToolId): void {
    this.draw = { kind, points: [point], preview: null, start: point, cursor: point, shift: false, alt: false };
  }

  private removePreview(): void {
    if (this.draw?.preview && this.canvas) {
      this.canvas.remove(this.draw.preview);
      this.draw.preview = null;
    }
  }

  private cancelDraw(): void {
    this.removePreview();
    this.draw = null;
    this.canvas?.requestRenderAll();
  }

  /** Write the selection straight into Fabric (bypassing the store's syncing short-circuit, which would echo selection events back) */
  private applySelection(ids: readonly string[]): void {
    if (!this.canvas) return;
    const objects = ids.map((id) => this.objects.get(id)).filter((object): object is FabricObject => !!object);
    if (!objects.length) {
      this.canvas.discardActiveObject();
    } else if (objects.length === 1) {
      this.canvas.setActiveObject(objects[0]);
    } else {
      this.canvas.setActiveObject(new ActiveSelection(objects, { canvas: this.canvas }));
    }
    this.canvas.requestRenderAll();
  }

  private updateDrawPreview(point: { x: number; y: number }, shift: boolean, alt = false): void {
    if (!this.canvas || !this.draw?.start) return;
    const { kind, start } = this.draw;
    if (!isDragDrawKind(kind)) return;

    this.draw.cursor = { x: point.x, y: point.y };
    this.draw.shift = shift;
    this.draw.alt = alt;

    const zoom = this.getZoom();
    const options = {
      fill: 'rgba(56,189,248,0.10)',
      stroke: '#38BDF8',
      strokeWidth: 1.5 / zoom,
      strokeDashArray: [4 / zoom, 3 / zoom],
      selectable: false,
      evented: false,
      objectCaching: false,
      originX: 'center' as const,
      originY: 'center' as const,
    };

    this.removePreview();

    // Write the constrained end point into points too: preview and commit share the same geometry, so the shape does not jump on mouse-up
    const end = constrainDragPoint(kind, start, point, shift);
    this.draw.points = [start, end];

    let preview: FabricObject;
    if (kind === 'line') {
      preview = new Polyline([{ x: start.x, y: start.y }, { x: end.x, y: end.y }], { ...options, fill: null });
    } else if (kind === 'arc') {
      const data = semicircleArcData(start, end, !alt);
      if (!data) return;
      const bounds = pathBounds(safeParse(data));
      preview = new FabricPath(data, {
        ...options,
        fill: null,
        left: bounds.x + bounds.width / 2,
        top: bounds.y + bounds.height / 2,
      });
    } else {
      const box = rectFromDrag(start, end);
      if (box.width < 0.5 || box.height < 0.5) return;
      preview = kind === 'rect'
        ? new Rect({ ...options, left: box.x + box.width / 2, top: box.y + box.height / 2, width: box.width, height: box.height })
        : new Ellipse({ ...options, left: box.x + box.width / 2, top: box.y + box.height / 2, rx: box.width / 2, ry: box.height / 2 });
    }

    this.draw.preview = preview;
    this.canvas.add(preview);
    this.canvas.requestRenderAll();
  }

  /** Recompute the preview immediately when Shift / Alt is pressed or released mid-drag (it must follow even without mouse movement) */
  private refreshDragPreviewOnModifier(shift: boolean, alt: boolean): void {
    if (!this.draw?.start || !this.draw.cursor) return;
    if (!isDragDrawKind(this.draw.kind)) return;
    this.updateDrawPreview(this.draw.cursor, shift, alt);
  }

  private finishDragDraw(): void {
    if (!this.draw?.start) return;
    const { kind, start, points, alt } = this.draw;
    // Use the constrained end point so a Shift-drag still commits a square / circle / semicircle on release
    const end = points[1] ?? points[points.length - 1] ?? start;
    this.cancelDraw();

    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);

    if (kind === 'line') {
      if (Math.hypot(end.x - start.x, end.y - start.y) < 2) return;
      this.emitCreate('Line', { x1: start.x, y1: start.y, x2: end.x, y2: end.y });
      return;
    }
    if (kind === 'rect') {
      if (width < 2 || height < 2) return;
      this.emitCreate('Rectangle', rectFromDrag(start, end));
      return;
    }
    if (kind === 'ellipse') {
      if (width < 2 || height < 2) return;
      this.emitCreate('Ellipse', ellipseFromDrag(start, end));
      return;
    }
    if (kind === 'arc') {
      if (Math.hypot(end.x - start.x, end.y - start.y) < 4) return;
      this.emitArc(start, end, !alt);
    }
  }

  /** Semicircle arc: an open path whose diameter is the dragged chord (Path with an A command) */
  private emitArc(start: { x: number; y: number }, end: { x: number; y: number }, sweep: boolean): void {
    const data = semicircleArcData(start, end, sweep);
    if (!data) return;
    const doc = this.callbacks.getDocument();
    const zIndex = doc.Shapes.reduce((max, shape) => Math.max(max, shape.ZIndex), 0) + 10;
    const shape = createShape('Path', { x: 0, y: 0 }, { zIndex, name: t('canvas.arcName'), fill: null });
    if (shape.Type === 'Path') {
      shape.Data = data;
      shape.OffsetX = 0;
      shape.OffsetY = 0;
    }
    this.callbacks.onCreateShape(shape, t('canvas.createArc'));
    const radius = Math.round((Math.hypot(end.x - start.x, end.y - start.y) / 2) * 100) / 100;
    this.callbacks.onStatus(t('canvas.arcCreated', { name: shape.Name, radius }));
  }

  private emitCreate(type: ShapeType, geometry: ShapeGeometryInput): void {
    const doc = this.callbacks.getDocument();
    const zIndex = doc.Shapes.reduce((max, shape) => Math.max(max, shape.ZIndex), 0) + 10;
    const labels: Record<ShapeType, string> = {
      Line: t('canvas.createLine'),
      Rectangle: t('canvas.createRect'),
      Ellipse: t('canvas.createEllipse'),
      Polygon: t('canvas.createPolygon'),
      Path: t('canvas.createPath'),
    };
    const shape = createShape(type, geometry, { zIndex });
    this.callbacks.onCreateShape(shape, labels[type]);
    this.callbacks.onStatus(t('canvas.shapeCreated', { action: labels[type], name: shape.Name }));
  }

  /* ------------------------------------------------------------------ *
   * Snapping
   * ------------------------------------------------------------------ */

  private snapPoint(point: { x: number; y: number }, exclude: Set<string> = new Set()): { x: number; y: number; hitX: boolean; hitY: boolean } {
    let x = point.x;
    let y = point.y;
    let hitX = false;
    let hitY = false;
    if (!this.snapEnabled) return { x, y, hitX, hitY };

    const tolerance = SNAP_TOLERANCE / this.getZoom();

    if (this.gridVisible) {
      const step = this.gridSize;
      const gx = Math.round(x / step) * step;
      const gy = Math.round(y / step) * step;
      if (Math.abs(gx - x) <= tolerance) {
        x = gx;
        hitX = true;
      }
      if (Math.abs(gy - y) <= tolerance) {
        y = gy;
        hitY = true;
      }
    }

    for (const [id, object] of this.objects) {
      if (exclude.has(id) || !object.visible) continue;
      const bounds = object.getBoundingRect();
      for (const candidate of [bounds.left, bounds.left + bounds.width / 2, bounds.left + bounds.width]) {
        if (Math.abs(candidate - x) <= tolerance) {
          x = candidate;
          hitX = true;
          break;
        }
      }
      for (const candidate of [bounds.top, bounds.top + bounds.height / 2, bounds.top + bounds.height]) {
        if (Math.abs(candidate - y) <= tolerance) {
          y = candidate;
          hitY = true;
          break;
        }
      }
    }

    return { x, y, hitX, hitY };
  }

  /* ------------------------------------------------------------------ *
   * Events
   * ------------------------------------------------------------------ */

  private bindEvents(): void {
    const canvas = this.canvas;
    if (!canvas) return;

    canvas.on('selection:created', () => this.handleSelectionEvent('created'));
    canvas.on('selection:updated', () => this.handleSelectionEvent('updated'));
    canvas.on('selection:cleared', () => this.handleSelectionEvent('cleared'));

    // Resolve groups before Fabric computes the transform: otherwise clicking a group member drags only that member
    canvas.on('mouse:down:before', (event) => this.handleMouseDownBefore(event as { e?: MouseEvent }));

    canvas.on('object:moving', (event) => {
      if (!this.snapEnabled || !event.target) return;
      const target = event.target;
      const exclude = new Set(this.selectedIds());
      const center = target.getCenterPoint();
      const snapped = this.snapPoint({ x: center.x, y: center.y }, exclude);
      if (snapped.hitX) target.set({ left: target.left + (snapped.x - center.x) });
      if (snapped.hitY) target.set({ top: target.top + (snapped.y - center.y) });
      target.setCoords();
    });

    canvas.on('object:modified', (event) => {
      // Rendering temporarily discards the selection (discardActiveObject also ends the
      // current transform and fires this event); writing back to the document here would
      // create a render → commit → render loop.
      if (this.syncing) return;
      const targets = event.target ? this.expandTargets(event.target) : [];
      if (targets.length) this.commitObjects(targets);
    });

    canvas.on('mouse:down', (event) => this.handleMouseDown(event as { e: MouseEvent; target?: FabricObject }));
    canvas.on('mouse:move', (event) => this.handleMouseMove(event as { e: MouseEvent }));
    canvas.on('mouse:up', (event) => this.handleMouseUp(event as { e: MouseEvent }));
    canvas.on('mouse:dblclick', () => this.finishMultiPointOnDoubleClick());

    canvas.on('mouse:wheel', (event) => {
      const wheel = event.e;
      wheel.preventDefault();
      if (!wheel.ctrlKey && !wheel.metaKey && !wheel.altKey) {
        const vpt = [...(canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0])] as [number, number, number, number, number, number];
        vpt[5] -= wheel.deltaY;
        vpt[4] -= wheel.deltaX;
        canvas.setViewportTransform(vpt);
        this.applyArtboardTransform();
        this.emitZoom();
        return;
      }
      this.setZoom(canvas.getZoom() * 0.999 ** wheel.deltaY, { x: wheel.offsetX, y: wheel.offsetY });
    });

    canvas.on('mouse:out', () => this.callbacks.onPointerMove(null));

    window.addEventListener('keydown', this.handleKeyDown, { passive: false });
    window.addEventListener('keyup', this.handleKeyUp);
  }

  private handleSelectionEvent(kind: 'created' | 'updated' | 'cleared'): void {
    if (this.syncing) return;
    const ids = this.selectedIds();
    // During an additive marquee Fabric clears the selection first; that is not the final result, so wait for selection:created on mouse-up
    if (kind === 'cleared' && this.marqueeBase?.length) return;
    const merged = this.marqueeBase?.length ? Array.from(new Set([...this.marqueeBase, ...ids])) : ids;
    // Selecting any member of a group on the canvas selects the whole group (a single row in the layers panel can still be selected alone to edit its properties)
    this.callbacks.onSelectionChange(expandSelectionToGroups(merged, this.callbacks.getDocument().Groups));
  }

  /**
   * mouse:down:before — step in before Fabric computes the current transform.
   * 1. When a group member is clicked, select the whole group first so the
   *    following drag/scale applies to the group rather than the single member;
   * 2. On empty canvas with Shift/Ctrl held, record the current selection so the
   *    additive marquee can merge into it.
   */
  private handleMouseDownBefore(event: { e?: MouseEvent }): void {
    const native = event.e;
    if (!native || this.tool !== 'select' || !this.canvas) return;

    const target = this.canvas.findTarget(native)?.target;
    if (target) {
      this.marqueeBase = null;
      const hitIds = (target instanceof ActiveSelection
        ? target.getObjects().map((object) => this.shapeIdOf.get(object))
        : [this.shapeIdOf.get(target)]
      ).filter((id): id is string => !!id);

      // Ctrl / Cmd + press on an already selected shape → duplicate drag (originals stay, copies follow the cursor)
      const ctrl = native.ctrlKey || native.metaKey;
      const selected = this.selectedIds();
      const hitSelected = hitIds.length > 0 && hitIds.every((id) => selected.includes(id));
      if (ctrl && hitSelected) {
        this.beginDuplicateDrag(hitIds, this.canvas.getScenePoint(native));
        return;
      }

      const ids = expandSelectionToGroups(hitIds, this.callbacks.getDocument().Groups);
      if (ids.length > 1 && !containsAll(this.selectedIds(), ids)) {
        this.applySelection(ids);
        // Fabric cached the hit target before this event, so after changing the
        // selection it must recompute; otherwise it still builds a "single member"
        // drag transform and the grouped shapes get dragged individually.
        // This method only clears Fabric's internal cache; if it is missing we fall
        // back to single-member dragging, which breaks nothing else.
        const reset = (this.canvas as unknown as { _resetTransformEventData?: () => void })._resetTransformEventData;
        reset?.call(this.canvas);
      }
      return;
    }

    const additive = native.shiftKey || native.ctrlKey || native.metaKey;
    this.marqueeBase = additive ? this.selectedIds() : null;
  }

  /**
   * Ctrl + drag duplicate: the originals stay in place and a set of "ghost copies"
   * follows the cursor.
   *
   * After mouse:down:before Fabric still builds a drag transform for the hit
   * object, so here we also discard the selection, turn off marquee selection and
   * temporarily make the originals non-interactive — this gesture belongs entirely
   * to the ghost copies. If duplicate-drag does not apply (e.g. the position is
   * bound to a variable), return early and let Fabric treat it as a normal click.
   */
  private beginDuplicateDrag(hitIds: string[], point: { x: number; y: number }): void {
    const canvas = this.canvas;
    if (!canvas) return;

    const doc = this.callbacks.getDocument();
    const baseSelection = this.selectedIds();
    const selected = new Set(baseSelection);
    const shapes = doc.Shapes
      .filter((shape) => selected.has(shape.Id))
      .map((shape) => JSON.parse(JSON.stringify(shape)) as Shape);
    if (!shapes.length) return;
    // Shapes whose position is bound to a variable cannot be dragged, so a copy would just land on top: no duplicate drag
    if (shapes.some(isPositionBound)) return;

    const ghosts: FabricObject[] = [];
    const bases: Array<{ left: number; top: number }> = [];
    for (const shape of shapes) {
      const ghost = this.createObject(shape, resolveShape(shape, this.callbacks.getVariable));
      ghost.set({ selectable: false, evented: false, hasBorders: false, hasControls: false, hoverCursor: 'default' });
      ghost.setCoords();
      canvas.add(ghost);
      ghosts.push(ghost);
      bases.push({ left: ghost.left, top: ghost.top });
    }

    const locked = baseSelection
      .map((id) => this.objects.get(id))
      .filter((object): object is FabricObject => !!object);
    for (const object of locked) object.set({ selectable: false, evented: false });

    this.duplicateDrag = {
      shapes,
      groups: doc.Groups
        .filter((group) => group.ShapeIds.length > 0 && group.ShapeIds.every((id) => selected.has(id)))
        .map((group) => ({ Name: group.Name, ShapeIds: [...group.ShapeIds] })),
      ghosts,
      bases,
      start: { x: point.x, y: point.y },
      delta: { x: 0, y: 0 },
      moved: false,
      toggleIds: hitIds,
      baseSelection,
      locked,
      selectionBefore: canvas.selection,
    };

    // Discard the selection and disable marquee selection: otherwise Fabric still builds a drag transform / draws a marquee for the "selected object"
    this.syncing = true;
    try {
      canvas.discardActiveObject();
    } finally {
      this.syncing = false;
    }
    canvas.selection = false;
    canvas.requestRenderAll();
  }

  /** While dragging: translate the whole ghost set with the cursor (originals stay put) */
  private updateDuplicateDrag(point: { x: number; y: number }): void {
    const state = this.duplicateDrag;
    if (!state || !this.canvas) return;

    let dx = point.x - state.start.x;
    let dy = point.y - state.start.y;
    if (!state.moved && Math.hypot(dx, dy) < 2) return;
    state.moved = true;

    // Snapping: align the center of the first copy to the grid / other shapes; apply the correction to the whole set so relative positions are preserved
    if (this.snapEnabled && state.ghosts.length) {
      const base = state.bases[0];
      const center = { x: base.left + dx, y: base.top + dy };
      const snapped = this.snapPoint(center, new Set(state.baseSelection));
      if (snapped.hitX) dx += snapped.x - center.x;
      if (snapped.hitY) dy += snapped.y - center.y;
    }

    state.delta = { x: dx, y: dy };
    state.ghosts.forEach((ghost, index) => {
      ghost.set({ left: state.bases[index].left + dx, top: state.bases[index].top + dy });
      ghost.setCoords();
    });
    this.canvas.requestRenderAll();
  }

  /** Teardown: remove the ghost copies, restore interaction and marquee selection on the originals */
  private releaseDuplicateGhosts(state: DuplicateDragState): void {
    const canvas = this.canvas;
    if (canvas) {
      for (const ghost of state.ghosts) canvas.remove(ghost);
      canvas.selection = state.selectionBefore;
    }
    const interactive = this.tool === 'select';
    for (const object of state.locked) object.set({ selectable: interactive, evented: interactive });
    canvas?.requestRenderAll();
  }

  /** End the duplicate-drag gesture: if it moved, create the copies at the drop point; if not, remove the hit shapes from the selection as a Ctrl click would */
  private finishDuplicateDrag(): void {
    const state = this.duplicateDrag;
    if (!state) return;
    this.duplicateDrag = null;
    this.releaseDuplicateGhosts(state);

    if (state.moved) {
      // The snapshot holds the original coordinates; translate the whole set to the drop point and insert it, leaving the originals where they were
      const shapes = state.shapes.map((shape) => {
        const copy = JSON.parse(JSON.stringify(shape)) as Shape;
        translateShape(copy, state.delta.x, state.delta.y);
        return copy;
      });
      this.callbacks.onDuplicateShapes?.({ shapes, groups: state.groups });
      return;
    }

    if (!state.toggleIds.length) {
      this.applySelection(state.baseSelection);
      return;
    }
    const keep = state.baseSelection.filter((id) => !state.toggleIds.includes(id));
    this.applySelection(keep);
    // When the selection shrinks to nothing Fabric has no active object and fires no selection event, so sync the store by hand
    if (!keep.length) this.callbacks.onSelectionChange([]);
  }

  /** Ctrl released mid-drag / Esc: drop the ghost copies and leave the originals and selection untouched */
  private cancelDuplicateDrag(): void {
    const state = this.duplicateDrag;
    if (!state) return;
    this.duplicateDrag = null;
    this.releaseDuplicateGhosts(state);
    this.applySelection(state.baseSelection);
    this.callbacks.onStatus(t('canvas.duplicateCancelled'));
  }

  private expandTargets(target: FabricObject): FabricObject[] {
    if (target instanceof ActiveSelection) return target.getObjects();
    return [target];
  }

  private handleMouseDown(event: { e: MouseEvent; target?: FabricObject }): void {
    if (!this.canvas) return;
    const native = event.e;
    const point = this.canvas.getScenePoint(native);

    if (this.tool === 'pan' || this.spaceDown || native.button === 1) {
      const view = this.getViewport();
      this.panState = { startX: native.clientX, startY: native.clientY, originX: view.offsetX, originY: view.offsetY };
      this.applyCursor('grabbing');
      native.preventDefault();
      return;
    }

    if (this.tool === 'select') {
      // Marquee selection is left to Fabric's native implementation (it also handles Shift/Ctrl click multi-select); here we only maintain the base for additive marquee
      return;
    }

    if (this.tool === 'line' || this.tool === 'rect' || this.tool === 'ellipse' || this.tool === 'arc') {
      const snapped = this.snapPoint({ x: point.x, y: point.y });
      this.beginDraw({ x: snapped.x, y: snapped.y }, this.tool);
      return;
    }

    if (this.tool === 'polygon' || this.tool === 'pen') {
      const snapped = this.snapPoint({ x: point.x, y: point.y });
      if (!this.draw) {
        this.beginDraw({ x: snapped.x, y: snapped.y }, this.tool);
      } else {
        const last = this.draw.points[this.draw.points.length - 1];
        if (last && Math.hypot(last.x - snapped.x, last.y - snapped.y) < 1.5) return;
        this.draw.points.push({ x: snapped.x, y: snapped.y });
      }
      this.refreshMultiPointPreview();
      return;
    }

    if (this.tool === 'freehand') {
      this.beginDraw({ x: point.x, y: point.y }, this.tool);
    }
  }

  private handleMouseMove(event: { e: MouseEvent }): void {
    if (!this.canvas) return;
    const native = event.e;
    const point = this.canvas.getScenePoint(native);
    this.callbacks.onPointerMove({ x: point.x, y: point.y });

    if (this.duplicateDrag) {
      this.updateDuplicateDrag({ x: point.x, y: point.y });
      return;
    }

    if (this.panState) {
      const dx = native.clientX - this.panState.startX;
      const dy = native.clientY - this.panState.startY;
      const zoom = this.getZoom();
      this.canvas.setViewportTransform([zoom, 0, 0, zoom, this.panState.originX + dx, this.panState.originY + dy]);
      this.applyArtboardTransform();
      this.emitZoom();
      return;
    }

    if (!this.draw) return;

    if (isDragDrawKind(this.draw.kind)) {
      const snapped = this.snapPoint({ x: point.x, y: point.y });
      this.updateDrawPreview({ x: snapped.x, y: snapped.y }, native.shiftKey, native.altKey);
      return;
    }

    if (this.draw.kind === 'freehand') {
      const last = this.draw.points[this.draw.points.length - 1];
      if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 1.5) {
        this.draw.points.push({ x: point.x, y: point.y });
        this.refreshMultiPointPreview();
      }
      return;
    }

    if (this.draw.kind === 'polygon' || this.draw.kind === 'pen') {
      this.refreshMultiPointPreview({ x: point.x, y: point.y });
    }
  }

  private handleMouseUp(event?: { e: MouseEvent }): void {
    this.marqueeBase = null;
    if (this.duplicateDrag) this.finishDuplicateDrag();
    if (this.panState) {
      this.panState = null;
      this.applyCursor(this.cursorForTool());
      return;
    }

    if (!this.draw) return;

    if (this.draw.kind === 'freehand') {
      const points = simplifyPolyline(this.draw.points, 1.2);
      this.cancelDraw();
      if (points.length >= 2) this.emitSmoothPath(points, false, 'freehand');
      return;
    }

    if (isDragDrawKind(this.draw.kind)) {
      // Recompute the end point with the current modifiers on release: preview and commit must agree
      const start = this.draw.start;
      const cursor = this.draw.cursor;
      if (start && cursor) {
        const shift = event?.e?.shiftKey ?? this.draw.shift;
        const alt = event?.e?.altKey ?? this.draw.alt;
        this.draw.points = [start, constrainDragPoint(this.draw.kind, start, cursor, shift)];
        this.draw.alt = alt;
      }
      this.finishDragDraw();
    }
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

    // Shift / Alt pressed mid-drag: update the preview immediately even without mouse movement
    if (event.key === 'Shift' || event.key === 'Alt') {
      this.refreshDragPreviewOnModifier(event.shiftKey, event.altKey);
      return;
    }

    if (event.code === 'Space' && !this.spaceDown) {
      this.spaceDown = true;
      this.applyCursor('grab');
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      if (this.duplicateDrag) {
        this.cancelDuplicateDrag();
        event.preventDefault();
        return;
      }
      this.cancelDraw();
        return;
    }
    if (event.key === 'Enter' && this.draw && (this.draw.kind === 'polygon' || this.draw.kind === 'pen')) {
      this.finishMultiPointOnDoubleClick();
      event.preventDefault();
    }
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    // Ctrl / Cmd released mid duplicate-drag: cancel this duplicate, discard the copies and leave the originals in place
    if ((event.key === 'Control' || event.key === 'Meta') && this.duplicateDrag) {
      this.cancelDuplicateDrag();
      return;
    }
    if (event.key === 'Shift' || event.key === 'Alt') {
      this.refreshDragPreviewOnModifier(event.shiftKey, event.altKey);
      return;
    }
    if (event.code === 'Space') {
      this.spaceDown = false;
      if (!this.panState) this.applyCursor(this.cursorForTool());
    }
  };

  finishMultiPointOnDoubleClick(): void {
    if (!this.draw) return;
    const { kind, points } = this.draw;
    this.cancelDraw();

    if (kind === 'polygon') {
      const cleaned = dedupe(points);
      if (cleaned.length < 3) {
        this.callbacks.onStatus(t('canvas.polygonTooFewPoints'));
        return;
      }
      this.emitCreate('Polygon', { points: cleaned });
      return;
    }
    if (kind === 'pen') {
      if (points.length < 2) return;
      this.emitSmoothPath(points, false, 'pen');
    }
  }

  private refreshMultiPointPreview(cursor?: { x: number; y: number }): void {
    if (!this.canvas || !this.draw) return;
    this.removePreview();
    const points = [...this.draw.points];
    if (cursor) points.push(cursor);
    if (points.length < 2) return;

    const zoom = this.getZoom();
    const preview = new Polyline(points, {
      fill: this.draw.kind === 'polygon' ? 'rgba(56,189,248,0.10)' : null,
      stroke: '#38BDF8',
      strokeWidth: 1.5 / zoom,
      strokeDashArray: [4 / zoom, 3 / zoom],
      selectable: false,
      evented: false,
      objectCaching: false,
    });
    this.draw.preview = preview;
    this.canvas.add(preview);
    this.canvas.requestRenderAll();
  }

  /** Smooth path: Catmull-Rom → cubic Bezier, emitted in WPF mini syntax */
  private emitSmoothPath(points: Array<{ x: number; y: number }>, closed: boolean, kind: 'freehand' | 'pen'): void {
    const doc = this.callbacks.getDocument();
    const zIndex = doc.Shapes.reduce((max, shape) => Math.max(max, shape.ZIndex), 0) + 10;
    const data = stringifyPathData(smoothPathCommands(points, closed));
    const name = t(kind === 'freehand' ? 'canvas.freehandName' : 'canvas.penName');
    const shape = createShape('Path', { x: 0, y: 0 }, { zIndex, name, fill: closed ? undefined : null });
    if (shape.Type === 'Path') {
      shape.Data = data;
      shape.OffsetX = 0;
      shape.OffsetY = 0;
    }
    this.callbacks.onCreateShape(shape, t(kind === 'freehand' ? 'canvas.createFreehand' : 'canvas.createPenPath'));
    this.callbacks.onStatus(t('canvas.pathCreated', { name, count: points.length }));
  }

  /* ------------------------------------------------------------------ *
   * Write-back: canvas → document
   * ------------------------------------------------------------------ */

  private commitObjects(objects: FabricObject[]): void {
    const doc = this.callbacks.getDocument();
    const edits: ShapeEdit[] = [];
    for (const object of objects) {
      const id = this.shapeIdOf.get(object);
      if (!id) continue;
      const shape = doc.Shapes.find((item) => item.Id === id);
      if (!shape) continue;
      // The object shows the group transform composed on top of the shape's own transform, so it
      // has to be divided out before the display transform is baked into the geometry.
      const updated = bakeObjectTransform(shape, object, this.groupLayerOfShape(id)?.transform);
      if (!updated) continue;
      // Do not record history for a click / no-op move, so the undo stack is not filled with empty operations
      if (JSON.stringify(updated) === JSON.stringify(shape)) continue;
      edits.push({ shape: updated, label: t('canvas.editShape') });
    }
    if (edits.length) this.callbacks.onShapeEdits(edits);
  }

  /** Refresh a single object after a document change (used by live property-panel editing) */
  refreshObject(shapeId: string): void {
    const object = this.objects.get(shapeId);
    const doc = this.callbacks.getDocument();
    const shape = doc.Shapes.find((item) => item.Id === shapeId);
    if (!object || !shape) return;
    this.syncing = true;
    try {
      const resolved = resolveShape(shape, this.callbacks.getVariable);
      this.updateObject(object, shape, resolved);
      this.applyGroupLayer(object, resolved, this.groupLayerOfShape(shapeId));
    } finally {
      this.syncing = false;
    }
    this.canvas?.requestRenderAll();
  }

  /** Resolve the group layer (transform / visibility / opacity) of a shape from the current document. */
  private groupLayerOfShape(shapeId: string): GroupLayer | undefined {
    const doc = this.callbacks.getDocument();
    const group = (doc.Groups ?? []).find((item) => item.ShapeIds.includes(shapeId));
    if (!group) return undefined;
    const transform = resolveGroupTransform(group, this.callbacks.getVariable);
    return {
      transform: isIdentityGroupTransform(transform) ? undefined : transform,
      visible: group.Visible !== false,
      opacity: Math.max(0, Math.min(1, resolveNumber(group.Opacity, this.callbacks.getVariable, 1))),
    };
  }

  /* ------------------------------------------------------------------ *
   * Clipboard
   * ------------------------------------------------------------------ */

  setClipboard(shapes: Shape[]): void {
    this.clipboard = shapes.map((shape) => JSON.parse(JSON.stringify(shape)) as Shape);
  }

  getClipboard(): Shape[] {
    return this.clipboard.map((shape) => JSON.parse(JSON.stringify(shape)) as Shape);
  }

  hasClipboard(): boolean {
    return this.clipboard.length > 0;
  }

  /** Hit test: return the Id of the topmost shape at the point */
  hitTest(x: number, y: number): string | undefined {
    if (!this.canvas) return undefined;
    const doc = this.callbacks.getDocument();
    const zIndexOf = (id: string): number => doc.Shapes.find((shape) => shape.Id === id)?.ZIndex ?? 0;
    const entries = [...this.objects.entries()]
      .filter(([, object]) => object.visible)
      .sort((a, b) => zIndexOf(b[0]) - zIndexOf(a[0]));
    for (const [id, object] of entries) {
      if (object.containsPoint(new Point(x, y))) return id;
    }
    return undefined;
  }

  getObject(shapeId: string): FabricObject | undefined {
    return this.objects.get(shapeId);
  }
}

/* ---------------------------------------------------------------------- *
 * Pure helpers
 * ---------------------------------------------------------------------- */

/** #AARRGGBB → CSS rgba() */
export function wpfHexToCss(value: string): string {
  const match = /^#([0-9a-fA-F]{8})$/.exec(value);
  if (!match) return value;
  const hex = match[1];
  const a = parseInt(hex.slice(0, 2), 16) / 255;
  const r = parseInt(hex.slice(2, 4), 16);
  const g = parseInt(hex.slice(4, 6), 16);
  const b = parseInt(hex.slice(6, 8), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}

export function isPositionBound(shape: Shape): boolean {
  switch (shape.Type) {
    case 'Line':
      return [shape.X1, shape.Y1, shape.X2, shape.Y2].some(isBindRef);
    case 'Rectangle':
      return [shape.X, shape.Y].some(isBindRef);
    case 'Ellipse':
      return [shape.CenterX, shape.CenterY].some(isBindRef);
    case 'Polygon':
      return shape.Points.some((point) => isBindRef(point.X) || isBindRef(point.Y));
    case 'Path':
      return !!(shape.RenderTransform?.Translate && (isBindRef(shape.RenderTransform.Translate.X) || isBindRef(shape.RenderTransform.Translate.Y)));
    default:
      return false;
  }
}

export function isSizeBound(shape: Shape): boolean {
  if (shape.RenderTransform?.Scale) {
    const scale = shape.RenderTransform.Scale;
    if (isBindRef(scale.ValueX) || isBindRef(scale.ValueY)) return true;
  }
  switch (shape.Type) {
    case 'Rectangle':
      return [shape.Width, shape.Height].some(isBindRef);
    case 'Ellipse':
      return [shape.RadiusX, shape.RadiusY].some(isBindRef);
    case 'Polygon':
      return shape.Points.some((point) => isBindRef(point.X) || isBindRef(point.Y));
    default:
      return false;
  }
}

export function boundsCenter(points: Array<{ x: number; y: number }>): { x: number; y: number } {
  if (!points.length) return { x: 0, y: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

function safeParse(data: string): PathCommand[] {
  try {
    return parsePathData(data).commands;
  } catch {
    return [];
  }
}

function getConst(ref: { Const: unknown } | { Bind: string } | undefined, fallback: number): number {
  if (!ref) return fallback;
  if ('Const' in ref) {
    const value = ref.Const;
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }
  return fallback;
}

function normalizeAngle(angle: number): number {
  const wrapped = angle % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped <= -180 ? wrapped + 360 : wrapped;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Bake a Fabric object's transform into the document geometry.
 * Rotation stays in RenderTransform.Rotate (so it remains editable), all scaling is baked.
 * Bound properties are never rewritten.
 *
 * When dragging/scaling a multi-selection, scale and rotation live on the
 * ActiveSelection (parent group) rather than the child object, so the parent's
 * scale / angle must be included here — otherwise the child snaps back to its
 * original size on mouse-up.
 */
export function bakeObjectTransform(
  shape: Shape,
  object: FabricObject,
  groupTransform?: ResolvedGroupTransform,
): Shape | null {
  const parent = object.group;
  const displayed = {
    angle: normalizeAngle(object.angle + (parent?.angle ?? 0)),
    sx: Math.abs(object.scaleX * (parent?.scaleX ?? 1)) || 1,
    sy: Math.abs(object.scaleY * (parent?.scaleY ?? 1)) || 1,
    centerX: object.getCenterPoint().x,
    centerY: object.getCenterPoint().y,
  };
  // Display transform → member transform: divide the group layer back out
  const local =
    groupTransform && !isIdentityGroupTransform(groupTransform)
      ? invertComposedTransform(groupTransform, displayed)
      : displayed;

  const center = { x: local.centerX, y: local.centerY };
  const angle = normalizeAngle(local.angle);
  const sx = Math.abs(local.sx) || 1;
  const sy = Math.abs(local.sy) || 1;
  const scaleAvg = (sx + sy) / 2;
  const updated: Shape = JSON.parse(JSON.stringify(shape)) as Shape;

  switch (updated.Type) {
    case 'Rectangle': {
      const width = Math.max(0.01, getConst(updated.Width, 1) * sx);
      const height = Math.max(0.01, getConst(updated.Height, 1) * sy);
      if (!isBindRef(updated.Width)) updated.Width = { Const: round3(width) };
      if (!isBindRef(updated.Height)) updated.Height = { Const: round3(height) };
      if (!isBindRef(updated.X)) updated.X = { Const: round3(center.x - width / 2) };
      if (!isBindRef(updated.Y)) updated.Y = { Const: round3(center.y - height / 2) };
      break;
    }
    case 'Ellipse': {
      const rx = Math.max(0.01, getConst(updated.RadiusX, 1) * sx);
      const ry = Math.max(0.01, getConst(updated.RadiusY, 1) * sy);
      if (!isBindRef(updated.RadiusX)) updated.RadiusX = { Const: round3(rx) };
      if (!isBindRef(updated.RadiusY)) updated.RadiusY = { Const: round3(ry) };
      if (!isBindRef(updated.CenterX)) updated.CenterX = { Const: round3(center.x) };
      if (!isBindRef(updated.CenterY)) updated.CenterY = { Const: round3(center.y) };
      break;
    }
    case 'Line': {
      const x1 = getConst(updated.X1, 0);
      const y1 = getConst(updated.Y1, 0);
      const x2 = getConst(updated.X2, 0);
      const y2 = getConst(updated.Y2, 0);
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;
      const map = (px: number, py: number): { x: number; y: number } => ({
        x: center.x + (px - midX) * sx,
        y: center.y + (py - midY) * sy,
      });
      const p1 = map(x1, y1);
      const p2 = map(x2, y2);
      if (!isBindRef(updated.X1)) updated.X1 = { Const: round3(p1.x) };
      if (!isBindRef(updated.Y1)) updated.Y1 = { Const: round3(p1.y) };
      if (!isBindRef(updated.X2)) updated.X2 = { Const: round3(p2.x) };
      if (!isBindRef(updated.Y2)) updated.Y2 = { Const: round3(p2.y) };
      // A line bakes rotation into its end points, avoiding rotation-center ambiguity
      updated.RenderTransform = {};
      break;
    }
    case 'Polygon': {
      const source = shape.Type === 'Polygon' ? shape.Points : updated.Points;
      const prev = source.map((point) => ({ x: getConst(point.X, 0), y: getConst(point.Y, 0) }));
      const prevCenter = boundsCenter(prev);
      updated.Points = source.map((point, index) => ({
        X: isBindRef(point.X) ? point.X : { Const: round3(center.x + (prev[index].x - prevCenter.x) * sx) },
        Y: isBindRef(point.Y) ? point.Y : { Const: round3(center.y + (prev[index].y - prevCenter.y) * sy) },
      }));
      break;
    }
    case 'Path': {
      const commands = safeParse(updated.Data);
      if (!commands.length) return null;
      const bounds = pathBounds(commands);
      const localCenter = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      const scaled = scalePathCommands(commands, sx, sy, localCenter);
      const newBounds = pathBounds(scaled);
      updated.Data = stringifyPathData(scaled);
      updated.OffsetX = round3(center.x - (newBounds.x + newBounds.width / 2));
      updated.OffsetY = round3(center.y - (newBounds.y + newBounds.height / 2));
      break;
    }
    default:
      return null;
  }

  // Stroke width scales proportionally with the geometry: consistent with vector-editor convention and with WPF's geometry transform semantics
  if (!isBindRef(updated.StrokeThickness) && Math.abs(scaleAvg - 1) > 1e-6) {
    updated.StrokeThickness = { Const: round3(Math.max(0.1, getConst(updated.StrokeThickness, 1) * scaleAvg)) };
  }

  if (updated.Type !== 'Line') {
    const previousRotate = shape.RenderTransform?.Rotate;
    updated.RenderTransform = updated.RenderTransform ?? {};
    updated.RenderTransform.Rotate = {
      CenterX: previousRotate && isBindRef(previousRotate.CenterX) ? previousRotate.CenterX : { Const: round3(center.x) },
      CenterY: previousRotate && isBindRef(previousRotate.CenterY) ? previousRotate.CenterY : { Const: round3(center.y) },
      Value: previousRotate && isBindRef(previousRotate.Value) ? previousRotate.Value : { Const: round3(angle) },
    };
    if (updated.RenderTransform.Scale) {
      // Scaling has been baked, clear the scale transform
      delete updated.RenderTransform.Scale;
    }
  }

  return updated;
}

/** Scale path commands (around center); arc radii scale per axis */
export function scalePathCommands(
  commands: readonly PathCommand[],
  sx: number,
  sy: number,
  center: { x: number; y: number },
): PathCommand[] {
  const mapX = (x: number): number => center.x + (x - center.x) * sx;
  const mapY = (y: number): number => center.y + (y - center.y) * sy;
  return commands.map((command) => {
    switch (command.type) {
      case 'M':
      case 'L':
        return { ...command, x: mapX(command.x), y: mapY(command.y) };
      case 'C':
        return {
          ...command,
          x1: mapX(command.x1),
          y1: mapY(command.y1),
          x2: mapX(command.x2),
          y2: mapY(command.y2),
          x: mapX(command.x),
          y: mapY(command.y),
        };
      case 'Q':
        return { ...command, x1: mapX(command.x1), y1: mapY(command.y1), x: mapX(command.x), y: mapY(command.y) };
      case 'A':
        return {
          ...command,
          rx: Math.abs(command.rx * sx),
          ry: Math.abs(command.ry * sy),
          x: mapX(command.x),
          y: mapY(command.y),
        };
      case 'Z':
        return command;
      default:
        return command;
    }
  });
}

/** Catmull-Rom → cubic Bezier, producing smooth path commands */
export function smoothPathCommands(points: Array<{ x: number; y: number }>, closed: boolean): PathCommand[] {
  const pts = dedupe(points);
  if (pts.length < 2) return [];
  const commands: PathCommand[] = [{ type: 'M', x: round3(pts[0].x), y: round3(pts[0].y) }];

  const get = (index: number): { x: number; y: number } => {
    if (closed) return pts[((index % pts.length) + pts.length) % pts.length];
    return pts[Math.max(0, Math.min(pts.length - 1, index))];
  };

  const last = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < last; i += 1) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    commands.push({
      type: 'C',
      x1: round3(p1.x + (p2.x - p0.x) / 6),
      y1: round3(p1.y + (p2.y - p0.y) / 6),
      x2: round3(p2.x - (p3.x - p1.x) / 6),
      y2: round3(p2.y - (p3.y - p1.y) / 6),
      x: round3(p2.x),
      y: round3(p2.y),
    });
  }
  if (closed) commands.push({ type: 'Z' });
  return commands;
}

export function dedupe(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last.x - point.x, last.y - point.y) > 0.01) out.push(point);
  }
  return out;
}

/** Ramer–Douglas–Peucker polyline simplification */
export function simplifyPolyline(points: Array<{ x: number; y: number }>, tolerance: number): Array<{ x: number; y: number }> {
  if (points.length <= 2) return [...points];
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxDistance = 0;
    let index = -1;
    for (let i = first + 1; i < last; i += 1) {
      const distance = perpendicularDistance(points[i], points[first], points[last]);
      if (distance > maxDistance) {
        maxDistance = distance;
        index = i;
      }
    }
    if (maxDistance > tolerance && index > 0) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

function perpendicularDistance(point: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
  const clamped = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (a.x + clamped * dx), point.y - (a.y + clamped * dy));
}
