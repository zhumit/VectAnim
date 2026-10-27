/**
 * Canvas2D renderer: draws ResolvedShape[] onto a 2D canvas.
 * The transform order matches the WPF side: Translate → Rotate(center) → Scale(center).
 */

import type { CanvasDef } from '../schema/types';
import { t } from '../i18n';
import { toCssColor } from './color';
import { parsePathData, tracePath, type PathCommand } from './pathData';
import { resolveDocument, type ResolvedShape } from './resolve';
import type { VariableResolver } from '../schema/valueRef';

export interface ViewTransform {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

export interface RenderOptions {
  /** Whether to draw the grid (off by default in the preview) */
  grid?: boolean;
  gridSize?: number;
  backgroundOverride?: string | null;
  /** Whether to draw the canvas border */
  border?: boolean;
}

const pathCache = new Map<string, PathCommand[]>();

export function getCachedPath(data: string): PathCommand[] {
  const cached = pathCache.get(data);
  if (cached) return cached;
  let commands: PathCommand[] = [];
  try {
    commands = parsePathData(data).commands;
  } catch {
    commands = [];
  }
  if (pathCache.size > 256) pathCache.clear();
  pathCache.set(data, commands);
  return commands;
}

export class Canvas2DRenderer {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error(t('engine.canvas.contextFailed'));
    this.ctx = context;
  }

  /** Resize the backing buffer from the CSS size and the DPR */
  resize(cssWidth: number, cssHeight: number, dpr = window.devicePixelRatio || 1): void {
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
  }

  render(
    shapes: readonly ResolvedShape[],
    canvasDef: CanvasDef,
    view: ViewTransform = { zoom: 1, offsetX: 0, offsetY: 0 },
    options: RenderOptions = {},
  ): void {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(view.offsetX, view.offsetY);
    ctx.scale(view.zoom, view.zoom);

    // Canvas background
    const background = options.backgroundOverride ?? canvasDef.Background;
    ctx.fillStyle = toCssColor(background, 'transparent');
    ctx.fillRect(0, 0, canvasDef.Width, canvasDef.Height);

    if (options.grid) {
      this.drawGrid(canvasDef, options.gridSize ?? 20);
    }

    for (const shape of shapes) {
      if (!shape.visible) continue;
      this.drawShape(shape);
    }

    if (options.border) {
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1 / view.zoom;
      ctx.strokeRect(0, 0, canvasDef.Width, canvasDef.Height);
    }

    ctx.restore();
  }

  private drawGrid(canvasDef: CanvasDef, size: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(120, 140, 170, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= canvasDef.Width; x += size) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvasDef.Height);
    }
    for (let y = 0; y <= canvasDef.Height; y += size) {
      ctx.moveTo(0, y);
      ctx.lineTo(canvasDef.Width, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawShape(shape: ResolvedShape): void {
    const ctx = this.ctx;
    const { transform } = shape;

    ctx.save();
    ctx.globalAlpha = shape.opacity;

    // The group transform is an outer layer: applied before (i.e. around) the shape's own transform
    const group = shape.groupTransform;
    if (group) {
      if (group.tx !== 0 || group.ty !== 0) ctx.translate(group.tx, group.ty);
      if (group.angle !== 0 || group.sx !== 1 || group.sy !== 1) {
        ctx.translate(group.cx, group.cy);
        ctx.rotate((group.angle * Math.PI) / 180);
        ctx.scale(group.sx, group.sy);
        ctx.translate(-group.cx, -group.cy);
      }
    }

    if (transform.tx !== 0 || transform.ty !== 0) ctx.translate(transform.tx, transform.ty);
    if (transform.angle !== 0 || transform.sx !== 1 || transform.sy !== 1) {
      ctx.translate(transform.cx, transform.cy);
      ctx.rotate((transform.angle * Math.PI) / 180);
      ctx.scale(transform.sx, transform.sy);
      ctx.translate(-transform.cx, -transform.cy);
    }

    ctx.beginPath();
    const geometry = shape.geometry;
    let closed = false;

    switch (geometry.kind) {
      case 'line':
        ctx.moveTo(geometry.x1, geometry.y1);
        ctx.lineTo(geometry.x2, geometry.y2);
        break;
      case 'rect': {
        const rx = Math.min(geometry.rx, geometry.width / 2);
        const ry = Math.min(geometry.ry, geometry.height / 2);
        if (rx > 0 && ry > 0) {
          this.roundRect(geometry.x, geometry.y, geometry.width, geometry.height, rx, ry);
        } else {
          ctx.rect(geometry.x, geometry.y, geometry.width, geometry.height);
        }
        closed = true;
        break;
      }
      case 'ellipse':
        ctx.ellipse(geometry.cx, geometry.cy, Math.max(0, geometry.rx), Math.max(0, geometry.ry), 0, 0, Math.PI * 2);
        closed = true;
        break;
      case 'polygon': {
        const points = geometry.points;
        if (points.length) {
          ctx.moveTo(points[0].x, points[0].y);
          for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
          if (geometry.closed) {
            ctx.closePath();
            closed = true;
          }
        }
        break;
      }
      case 'path': {
        ctx.translate(geometry.offsetX, geometry.offsetY);
        tracePath(ctx, getCachedPath(geometry.data));
        closed = true;
        break;
      }
    }

    if (shape.fill && (closed || geometry.kind === 'polygon')) {
      ctx.fillStyle = shape.fill;
      ctx.fill(geometry.kind === 'path' ? 'nonzero' : 'nonzero');
    }

    if (shape.stroke && shape.strokeThickness > 0) {
      ctx.strokeStyle = shape.stroke;
      ctx.lineWidth = shape.strokeThickness;
      ctx.lineCap = shape.lineCap === 'Round' ? 'round' : shape.lineCap === 'Square' ? 'square' : 'butt';
      ctx.lineJoin = shape.lineJoin === 'Round' ? 'round' : shape.lineJoin === 'Bevel' ? 'bevel' : 'miter';
      ctx.stroke();
    }

    ctx.restore();
  }

  private roundRect(x: number, y: number, width: number, height: number, rx: number, ry: number): void {
    const ctx = this.ctx;
    ctx.moveTo(x + rx, y);
    ctx.lineTo(x + width - rx, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + ry);
    ctx.lineTo(x + width, y + height - ry);
    ctx.quadraticCurveTo(x + width, y + height, x + width - rx, y + height);
    ctx.lineTo(x + rx, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - ry);
    ctx.lineTo(x, y + ry);
    ctx.quadraticCurveTo(x, y, x + rx, y);
    ctx.closePath();
  }
}

/** Convenience helper: render a document straight onto a canvas (preview panel and PNG export) */
export function renderDocumentToCanvas(
  canvas: HTMLCanvasElement,
  document: Parameters<typeof resolveDocument>[0],
  resolver: VariableResolver,
  view: ViewTransform,
  options: RenderOptions = {},
  dpr = window.devicePixelRatio || 1,
): void {
  const renderer = new Canvas2DRenderer(canvas);
  renderer.resize(document.Canvas.Width * view.zoom, document.Canvas.Height * view.zoom, dpr);
  renderer.render(resolveDocument(document, resolver), document.Canvas, { zoom: view.zoom, offsetX: 0, offsetY: 0 }, options);
}
