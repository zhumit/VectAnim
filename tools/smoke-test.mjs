#!/usr/bin/env node
/**
 * Editor smoke test (real browser: playwright-core + local Chrome).
 *
 * Covers: initial load, drawing rectangles/polygons, undo, property binding,
 *       variables panel, animations panel, live preview, SVG import, JSON export,
 *       and console errors.
 *
 * Usage: node tools/smoke-test.mjs [--headed]
 * Prerequisite: npm run build
 */

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const distDir = join(root, 'dist', 'editor');
const shotDir = join(root, 'artifacts', 'screenshots');

if (!existsSync(join(distDir, 'index.html'))) {
  console.error('Build output not found — run npm run build first');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path === '/' || path.endsWith('/')) path += 'index.html';
    const filePath = join(distDir, path);
    if (!filePath.startsWith(distDir)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    const data = await readFile(filePath);
    response.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    response.end(data);
  } catch {
    response.writeHead(404).end('not found');
  }
});

const port = await new Promise((resolvePort) => {
  server.listen(0, '127.0.0.1', () => resolvePort(server.address().port));
});
const baseUrl = `http://127.0.0.1:${port}/`;
console.log(`Static server started at ${baseUrl}`);

await mkdir(shotDir, { recursive: true });

const headed = process.argv.includes('--headed');
const executablePath = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await chromium.launch({ executablePath, headless: !headed });
const page = await browser.newPage({ viewport: { width: 1600, height: 980 }, deviceScaleFactor: 1 });

const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const shapeCount = () => page.evaluate(() => window.vectanim.store.getDocument().Shapes.length);

await page.goto(baseUrl, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

/* ------------------------------ Initial load ------------------------------ */
const countText = await page.locator('[data-testid="shape-count"]').innerText();
check('Initial sample document loaded', /shapes/i.test(countText), countText);
check('Canvas rendered', (await page.locator('.canvas-container canvas').count()) > 0);
check('Layer tree has content', (await page.locator('.va-layer').count()) > 0, `${await page.locator('.va-layer').count()} rows`);
await page.screenshot({ path: join(shotDir, '01-editor.png') });

/* ------------------------------ Draw rectangle ------------------------------ */
const before = await shapeCount();
await page.locator('.va-tool').nth(2).click();
const drawCursor = await page.evaluate(() => window.vectanim.view.canvas.upperCanvasEl.style.cursor);
const drawCursorLoads = await page.evaluate(() => {
  const match = /url\("(.*?)"\)/.exec(window.vectanim.view.canvas.upperCanvasEl.style.cursor);
  if (!match) return Promise.resolve(false);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth === 24 && image.naturalHeight === 24);
    image.onerror = () => resolve(false);
    image.src = match[1];
  });
});
check(
  'Drawing tool uses custom crosshair cursor (visible on white)',
  drawCursor.includes('data:image/svg+xml') && drawCursor.includes('12 12') && drawCursorLoads === true,
  `${drawCursor.slice(0, 42)}… image loadable: ${drawCursorLoads}`,
);
const canvasBox = await page.locator('#va-canvas-host').boundingBox();
await page.mouse.move(canvasBox.x + 240, canvasBox.y + 620);
await page.mouse.down();
await page.mouse.move(canvasBox.x + 340, canvasBox.y + 700, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
const afterRect = await shapeCount();
check('Drawing a rectangle adds a shape', afterRect === before + 1, `${before} → ${afterRect}`);
const selectCursor = await page.evaluate(() => window.vectanim.view.canvas.upperCanvasEl.style.cursor);
check('Select tool restores the arrow cursor', selectCursor === 'default', selectCursor);

// After the space-pan ends the cursor must return to the active tool cursor, not fall back to the arrow
await page.locator('.va-tool').nth(2).click();
await page.keyboard.down('Space');
const spaceCursor = await page.evaluate(() => window.vectanim.view.canvas.upperCanvasEl.style.cursor);
await page.keyboard.up('Space');
const restoredCursor = await page.evaluate(() => window.vectanim.view.canvas.upperCanvasEl.style.cursor);
check(
  'Cursor returns to the drawing crosshair after space-pan ends',
  spaceCursor === 'grab' && restoredCursor.includes('data:image/svg+xml'),
  `${spaceCursor} → ${restoredCursor.slice(0, 30)}`,
);
await page.locator('.va-tool').nth(0).click();
await page.waitForTimeout(120);

/* --------------------- Hold Shift to draw a square (kept after release) --------------------- */
const lastRect = () =>
  page.evaluate(() => {
    const doc = window.vectanim.store.getDocument();
    const rects = doc.Shapes.filter((shape) => shape.Type === 'Rectangle');
    const rect = rects[rects.length - 1];
    return rect ? { w: rect.Width.Const, h: rect.Height.Const } : null;
  });

await page.keyboard.down('Shift');
// The editor switches back to the select tool after creation, so re-select the rectangle tool here
await page.locator('.va-tool').nth(2).click();
await page.mouse.move(canvasBox.x + 400, canvasBox.y + 620);
await page.mouse.down();
await page.mouse.move(canvasBox.x + 500, canvasBox.y + 680, { steps: 8 });
await page.mouse.up();
await page.keyboard.up('Shift');
await page.waitForTimeout(300);
const square = await lastRect();
check('Shape is still a square after Shift-drag release', !!square && Math.abs(square.w - square.h) < 0.01, square ? `${square.w} × ${square.h}` : 'not created');

/* --------------------- Hold Shift to draw a perfect circle (kept after release) --------------------- */
const lastEllipse = () =>
  page.evaluate(() => {
    const doc = window.vectanim.store.getDocument();
    const ellipses = doc.Shapes.filter((shape) => shape.Type === 'Ellipse');
    const ellipse = ellipses[ellipses.length - 1];
    return ellipse ? { rx: ellipse.RadiusX.Const, ry: ellipse.RadiusY.Const } : null;
  });

await page.locator('.va-tool').nth(3).click();
await page.keyboard.down('Shift');
await page.mouse.move(canvasBox.x + 560, canvasBox.y + 620);
await page.mouse.down();
await page.mouse.move(canvasBox.x + 660, canvasBox.y + 670, { steps: 8 });
await page.mouse.up();
await page.keyboard.up('Shift');
await page.waitForTimeout(300);
const circle = await lastEllipse();
check('Shape is still a perfect circle after Shift-drag release', !!circle && Math.abs(circle.rx - circle.ry) < 0.01, circle ? `rx ${circle.rx} / ry ${circle.ry}` : 'not created');

/* ------------------------------ Draw a half-circle arc ------------------------------ */
const beforeArc = await shapeCount();
await page.locator('.va-tool').nth(4).click();
await page.mouse.move(canvasBox.x + 300, canvasBox.y + 760);
await page.mouse.down();
await page.mouse.move(canvasBox.x + 420, canvasBox.y + 760, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
const arc = await page.evaluate(() => {
  const doc = window.vectanim.store.getDocument();
  const paths = doc.Shapes.filter((shape) => shape.Type === 'Path' && / A /.test(shape.Data));
  return paths.length ? { data: paths[paths.length - 1].Data, name: paths[paths.length - 1].Name } : null;
});
check('Half-circle tool creates an arc path', (await shapeCount()) === beforeArc + 1 && !!arc, arc ? arc.data : 'not created');
check('Half-circle is a circular arc (rx == ry)', !!arc && /A ([\d.]+),\1 /.test(arc.data), arc?.data ?? '');

/* ------------------------------ Draw polygon ------------------------------ */
const beforePolygon = await shapeCount();
await page.locator('.va-tool').nth(5).click();
await page.mouse.click(canvasBox.x + 700, canvasBox.y + 620);
await page.mouse.click(canvasBox.x + 780, canvasBox.y + 650);
await page.mouse.click(canvasBox.x + 740, canvasBox.y + 730);
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
const afterPolygon = await shapeCount();
check('Polygon tool creates a shape', afterPolygon === beforePolygon + 1, `${beforePolygon} → ${afterPolygon}`);
const polygonPoints = await page.evaluate(() => {
  const doc = window.vectanim.store.getDocument();
  const polygon = doc.Shapes.find((shape) => shape.Type === 'Polygon' && shape.Id.startsWith('polygon'));
  return polygon?.Points?.length ?? 0;
});
check('Polygon vertex count is correct', polygonPoints === 3, `${polygonPoints} vertices`);

/* ------------------------------ Undo ------------------------------ */
await page.locator('.va-tool').nth(0).click();
const createdCount = afterPolygon - before;
for (let i = 0; i < createdCount; i += 1) await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
check('Undo reverts everything drawn in this pass', (await shapeCount()) === before, `${afterPolygon} → ${await shapeCount()} (undid ${createdCount} steps)`);

/* ------------------------------ Marquee select / arrow-key nudge ------------------------------ */
const view = await page.evaluate(() => {
  const app = window.vectanim;
  const canvas = app.view.canvas;
  const el = canvas.getElement().getBoundingClientRect();
  const vpt = canvas.viewportTransform;
  const doc = app.store.getDocument();
  const toPage = (x, y) => ({ x: el.left + x * vpt[0] + vpt[4], y: el.top + y * vpt[3] + vpt[5] });
  return {
    canvas: { left: el.left, top: el.top, right: el.right, bottom: el.bottom },
    tl: toPage(0, 0),
    br: toPage(doc.Canvas.Width, doc.Canvas.Height),
    visible: doc.Shapes.filter((shape) => shape.IsVisible !== false).length,
  };
});

// Scene coordinates → page coordinates (used to position later clicks/drags)
const toPage = async (sx, sy) =>
  page.evaluate(
    ([x, y]) => {
      const canvas = window.vectanim.view.canvas;
      const el = canvas.getElement().getBoundingClientRect();
      const vpt = canvas.viewportTransform;
      return { x: el.left + x * vpt[0] + vpt[4], y: el.top + y * vpt[3] + vpt[5] };
    },
    [sx, sy],
  );

const x0 = Math.max(view.canvas.left + 4, view.tl.x - 12);
const y0 = Math.max(view.canvas.top + 4, view.tl.y - 12);
const x1 = Math.min(view.canvas.right - 4, view.br.x + 12);
const y1 = Math.min(view.canvas.bottom - 4, view.br.y + 12);

await page.mouse.move(x0, y0);
await page.mouse.down();
await page.mouse.move(x1, y0, { steps: 5 });
await page.mouse.move(x1, y1, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(300);
const marqueeSelected = await page.evaluate(() => window.vectanim.store.getSelection().length);
check('Marquee drag selects every shape inside the region', marqueeSelected === view.visible, `selected ${marqueeSelected} / ${view.visible}`);
await page.mouse.click(x0 + 2, y0 + 2);
await page.waitForTimeout(200);
check('Clicking empty space clears the selection', (await page.evaluate(() => window.vectanim.store.getSelection().length)) === 0);

await page.mouse.move(x0 + 6, y0 + 6);
await page.mouse.down();
await page.mouse.move(x0 + 70, y0 + 70, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(300);
const rectSelected = await page.evaluate(() => window.vectanim.store.getSelection().length);
check('Small marquee selects only the nearby shapes', rectSelected >= 1 && rectSelected < view.visible, `selected ${rectSelected}`);

/* Multi-select drag must not jump */
const beforeDrag = await page.evaluate(() => {
  const app = window.vectanim;
  return app.store.getSelection().map((id) => {
    const obj = app.view.objects.get(id);
    const c = obj.getCenterPoint();
    return { id, x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10 };
  });
});
const grabCenter = await page.evaluate(() => {
  const app = window.vectanim;
  const canvas = app.view.canvas;
  const obj = app.view.objects.get(app.store.getSelection()[0]);
  const c = obj.getCenterPoint();
  const el = canvas.getElement().getBoundingClientRect();
  const vpt = canvas.viewportTransform;
  return { x: el.left + c.x * vpt[0] + vpt[4], y: el.top + c.y * vpt[3] + vpt[5] };
});
await page.mouse.move(grabCenter.x, grabCenter.y);
await page.mouse.down();
await page.mouse.move(grabCenter.x + 40, grabCenter.y + 40, { steps: 6 });
await page.waitForTimeout(120);
const duringDrag = await page.evaluate(() => {
  const app = window.vectanim;
  return app.store.getSelection().map((id) => {
    const c = app.view.objects.get(id).getCenterPoint();
    return { id, x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10 };
  });
});
await page.mouse.up();
await page.waitForTimeout(350);
const afterDrag = await page.evaluate(() => {
  const app = window.vectanim;
  return app.store.getSelection().map((id) => {
    const c = app.view.objects.get(id).getCenterPoint();
    return { id, x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10 };
  });
});
const movedDistance = afterDrag.length
  ? Math.hypot(afterDrag[0].x - beforeDrag[0].x, afterDrag[0].y - beforeDrag[0].y)
  : 0;
const jump = duringDrag.every((item, index) => Math.abs(item.x - afterDrag[index].x) < 0.5 && Math.abs(item.y - afterDrag[index].y) < 0.5);
check('Multi-select drag works', movedDistance > 20, `moved ${Math.round(movedDistance)}`);
check('Multi-select drag does not jump on release', jump, duringDrag.map((item, index) => `${item.id}:${item.x},${item.y}→${afterDrag[index].x},${afterDrag[index].y}`).join(' | '));

/* Arrow-key nudge */
const nudgeBefore = await page.evaluate(() => {
  const app = window.vectanim;
  const id = app.store.getDocument().Shapes[0].Id;
  app.store.setSelection([id]);
  const shape = app.store.getDocument().Shapes[0];
  return { id, x: shape.X?.Const ?? shape.CenterX?.Const, y: shape.Y?.Const ?? shape.CenterY?.Const };
});
await page.waitForTimeout(150);
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(150);
const nudgeOnce = await page.evaluate(() => {
  const shape = window.vectanim.store.getDocument().Shapes[0];
  return { x: shape.X?.Const ?? shape.CenterX?.Const, y: shape.Y?.Const ?? shape.CenterY?.Const };
});
await page.keyboard.press('Shift+ArrowDown');
await page.waitForTimeout(150);
const nudgeShift = await page.evaluate(() => {
  const shape = window.vectanim.store.getDocument().Shapes[0];
  return { x: shape.X?.Const ?? shape.CenterX?.Const, y: shape.Y?.Const ?? shape.CenterY?.Const };
});
check('Arrow key nudges by 1px', Math.abs(nudgeOnce.x - nudgeBefore.x - 1) < 0.01, `${nudgeBefore.x} → ${nudgeOnce.x}`);
check('Shift+Arrow key moves 10px', Math.abs(nudgeShift.y - nudgeOnce.y - 10) < 0.01, `${nudgeOnce.y} → ${nudgeShift.y}`);

/* ------------------------------ Shift / Ctrl click multi-select ------------------------------ */
await page.evaluate(() => {
  window.vectanim.store.update((draft) => {
    draft.Shapes.length = 0;
    draft.Groups.length = 0;
  }, { label: 'Clear' });
});
await page.waitForTimeout(200);
for (const [x1, y1, x2, y2] of [[100, 100, 200, 200], [300, 100, 400, 200], [500, 300, 600, 400]]) {
  await page.locator('.va-tool').nth(2).click();
  const a = await toPage(x1, y1);
  const b = await toPage(x2, y2);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(120);
}
await page.locator('.va-tool').nth(0).click();
await page.evaluate(() => window.vectanim.store.setSelection([]));
await page.waitForTimeout(150);

const selCount = () => page.evaluate(() => window.vectanim.store.getSelection().length);
const rectCenter = async (index) => {
  const shape = await page.evaluate((i) => {
    const s = window.vectanim.store.getDocument().Shapes[i];
    return { x: s.X.Const + s.Width.Const / 2, y: s.Y.Const + s.Height.Const / 2 };
  }, index);
  return toPage(shape.x, shape.y);
};

const c1 = await rectCenter(0);
const c2 = await rectCenter(1);
const c3 = await rectCenter(2);
await page.mouse.click(c1.x, c1.y);
await page.waitForTimeout(150);
await page.keyboard.down('Shift');
await page.mouse.click(c2.x, c2.y);
await page.waitForTimeout(200);
await page.keyboard.up('Shift');
check('Shift + click multi-select', (await selCount()) === 2, `${await selCount()} selected`);

await page.keyboard.down('Control');
await page.mouse.click(c3.x, c3.y);
await page.waitForTimeout(200);
await page.keyboard.up('Control');
check('Ctrl + click adds to the selection', (await selCount()) === 3, `${await selCount()} selected`);

/* ------------------------------ Group acts as a single unit ------------------------------ */
await page.evaluate(() => window.vectanim.store.setSelection([]));
await page.waitForTimeout(120);
await page.mouse.click(c1.x, c1.y);
await page.keyboard.down('Shift');
await page.mouse.click(c2.x, c2.y);
await page.keyboard.up('Shift');
await page.waitForTimeout(200);
await page.keyboard.press('Control+g');
await page.waitForTimeout(250);
check('Grouping writes a group', (await page.evaluate(() => window.vectanim.store.getDocument().Groups.length)) === 1);

await page.mouse.click(x0 + 2, y0 + 2);
await page.waitForTimeout(150);
check('Clicking empty space after grouping clears the selection', (await selCount()) === 0);
await page.mouse.click(c2.x, c2.y);
await page.waitForTimeout(200);
check('Clicking a group member selects the whole group', (await selCount()) === 2, `${await selCount()} selected`);

const groupBefore = await page.evaluate(() => window.vectanim.store.getDocument().Shapes.map((s) => Math.round(s.X?.Const ?? 0)));
await page.mouse.click(x0 + 2, y0 + 2);
await page.waitForTimeout(150);
await page.mouse.move(c2.x, c2.y);
await page.mouse.down();
await page.mouse.move(c2.x + 50, c2.y + 30, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(350);
const groupAfter = await page.evaluate(() => window.vectanim.store.getDocument().Shapes.map((s) => Math.round(s.X?.Const ?? 0)));
check(
  'Dragging a group member moves the whole group',
  Math.abs(groupAfter[0] - groupBefore[0] - 40) < 12 && Math.abs(groupAfter[1] - groupBefore[1] - 40) < 12 && groupAfter[2] === groupBefore[2],
  `${JSON.stringify(groupBefore)} → ${JSON.stringify(groupAfter)}`,
);

const groupKeyBefore = await page.evaluate(() => window.vectanim.store.getDocument().Shapes.map((s) => Math.round(s.X?.Const ?? 0)));
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(200);
const groupKeyAfter = await page.evaluate(() => window.vectanim.store.getDocument().Shapes.map((s) => Math.round(s.X?.Const ?? 0)));
check(
  'Arrow key nudges the whole group',
  groupKeyAfter[0] === groupKeyBefore[0] + 1 && groupKeyAfter[1] === groupKeyBefore[1] + 1 && groupKeyAfter[2] === groupKeyBefore[2],
  `${JSON.stringify(groupKeyBefore)} → ${JSON.stringify(groupKeyAfter)}`,
);

await page.keyboard.press('Control+Shift+g');
await page.waitForTimeout(200);
check('Ungroup', (await page.evaluate(() => window.vectanim.store.getDocument().Groups.length)) === 0);

/* ------------------------------ Paste offset / Ctrl-drag copy ------------------------------ */
await page.mouse.click(x0 + 2, y0 + 2);
await page.waitForTimeout(150);
const src = await rectCenter(2);
await page.mouse.click(src.x, src.y);
await page.waitForTimeout(180);
const copySource = await page.evaluate(() => {
  const app = window.vectanim;
  const id = app.store.getSelection()[0];
  const shape = app.store.getDocument().Shapes.find((item) => item.Id === id);
  return { id, x: shape.X.Const, y: shape.Y.Const, count: app.store.getDocument().Shapes.length };
});
await page.keyboard.press('Control+c');
await page.keyboard.press('Control+v');
await page.waitForTimeout(300);
const pasted = await page.evaluate((countBefore) => {
  const doc = window.vectanim.store.getDocument();
  const shape = doc.Shapes[doc.Shapes.length - 1];
  return { x: shape.X.Const, y: shape.Y.Const, added: doc.Shapes.length - countBefore };
}, copySource.count);
check(
  'Pasted shape is offset from the original position',
  pasted.added === 1 && Math.abs(pasted.x - copySource.x - 16) < 0.01 && Math.abs(pasted.y - copySource.y - 16) < 0.01,
  `${copySource.x},${copySource.y} → ${pasted.x},${pasted.y}`,
);

await page.mouse.click(x0 + 2, y0 + 2);
await page.waitForTimeout(150);
const dragSource = await rectCenter(0);
await page.mouse.click(dragSource.x, dragSource.y);
await page.waitForTimeout(180);
const dragSelCount = await selCount();
const beforeCtrlDrag = await shapeCount();
const dragOriginBefore = await page.evaluate(() => {
  const shape = window.vectanim.store.getDocument().Shapes[0];
  return { x: shape.X.Const, y: shape.Y.Const };
});
await page.keyboard.down('Control');
await page.mouse.move(dragSource.x, dragSource.y);
await page.mouse.down();
await page.mouse.move(dragSource.x + 70, dragSource.y + 50, { steps: 8 });
await page.screenshot({ path: join(shotDir, 'ctrl-drag-copy.png') });
await page.mouse.up();
await page.keyboard.up('Control');
await page.waitForTimeout(350);
const afterCtrlDrag = await shapeCount();
check(
  'Ctrl + drag copies the shape',
  dragSelCount === 1 && afterCtrlDrag === beforeCtrlDrag + 1,
  `${dragSelCount} selected, shapes ${beforeCtrlDrag} → ${afterCtrlDrag}`,
);

const dragResult = await page.evaluate((countBefore) => {
  const doc = window.vectanim.store.getDocument();
  const zoom = window.vectanim.view.canvas.viewportTransform[0];
  const origin = doc.Shapes[0];
  const copy = doc.Shapes[doc.Shapes.length - 1];
  const selected = window.vectanim.store.getSelection();
  return {
    originX: origin.X.Const,
    originY: origin.Y.Const,
    dx: copy.X.Const - origin.X.Const,
    dy: copy.Y.Const - origin.Y.Const,
    expectedDx: 70 / zoom,
    expectedDy: 50 / zoom,
    selectedIsCopy: selected.length === 1 && selected[0] === copy.Id,
    added: doc.Shapes.length - countBefore,
  };
}, beforeCtrlDrag);
check(
  'Ctrl-drag copy: the original shape stays in place',
  Math.abs(dragResult.originX - dragOriginBefore.x) < 0.01 && Math.abs(dragResult.originY - dragOriginBefore.y) < 0.01,
  `${dragOriginBefore.x},${dragOriginBefore.y} → ${dragResult.originX},${dragResult.originY}`,
);
check(
  'Ctrl-drag copy: the copy lands at the release point and is selected',
  dragResult.added === 1 &&
    dragResult.selectedIsCopy &&
    Math.abs(dragResult.dx - dragResult.expectedDx) < 10 &&
    Math.abs(dragResult.dy - dragResult.expectedDy) < 10,
  `delta ${dragResult.dx.toFixed(1)},${dragResult.dy.toFixed(1)} (expected ${dragResult.expectedDx.toFixed(1)},${dragResult.expectedDy.toFixed(1)}), copy selected: ${dragResult.selectedIsCopy}`,
);

// Release Ctrl first → copy is cancelled: shape count and original position both stay the same
await page.mouse.click(x0 + 2, y0 + 2);
await page.waitForTimeout(150);
const cancelSource = await rectCenter(1);
await page.mouse.click(cancelSource.x, cancelSource.y);
await page.waitForTimeout(180);
const cancelBefore = await page.evaluate(() => {
  const doc = window.vectanim.store.getDocument();
  const shape = doc.Shapes[1];
  return { id: shape.Id, x: shape.X.Const, y: shape.Y.Const, count: doc.Shapes.length };
});
await page.keyboard.down('Control');
await page.mouse.move(cancelSource.x, cancelSource.y);
await page.mouse.down();
await page.mouse.move(cancelSource.x + 60, cancelSource.y + 40, { steps: 6 });
await page.keyboard.up('Control');
await page.mouse.move(cancelSource.x + 90, cancelSource.y + 60, { steps: 4 });
await page.mouse.up();
await page.waitForTimeout(300);
const cancelAfter = await page.evaluate((id) => {
  const doc = window.vectanim.store.getDocument();
  const shape = doc.Shapes.find((item) => item.Id === id);
  return {
    count: doc.Shapes.length,
    x: shape.X.Const,
    y: shape.Y.Const,
    selected: window.vectanim.store.getSelection(),
  };
}, cancelBefore.id);
check(
  'Releasing Ctrl first cancels the drag-copy',
  cancelAfter.count === cancelBefore.count &&
    Math.abs(cancelAfter.x - cancelBefore.x) < 0.01 &&
    Math.abs(cancelAfter.y - cancelBefore.y) < 0.01 &&
    cancelAfter.selected.length === 1 &&
    cancelAfter.selected[0] === cancelBefore.id,
  `shapes ${cancelBefore.count} → ${cancelAfter.count}, position ${cancelBefore.x},${cancelBefore.y} → ${cancelAfter.x},${cancelAfter.y}, selection restored: ${cancelAfter.selected.length === 1 && cancelAfter.selected[0] === cancelBefore.id}`,
);

// Ctrl + click (no drag) still deselects: the drag-copy takeover must not swallow click semantics
const toggleBefore = await selCount();
await page.keyboard.down('Control');
await page.mouse.click(cancelSource.x, cancelSource.y);
await page.keyboard.up('Control');
await page.waitForTimeout(250);
const toggleAfter = await selCount();
check('Ctrl + click deselects (no drag)', toggleBefore === 1 && toggleAfter === 0, `selected ${toggleBefore} → ${toggleAfter}`);

// Multi-select Ctrl-drag copy: the whole copy set follows the mouse and neither original moves
await page.mouse.click(x0 + 2, y0 + 2);
await page.waitForTimeout(150);
const multiBefore = await page.evaluate(() => {
  const doc = window.vectanim.store.getDocument();
  const ids = [doc.Shapes[0].Id, doc.Shapes[1].Id];
  window.vectanim.store.setSelection(ids);
  return {
    ids,
    count: doc.Shapes.length,
    origin: ids.map((id) => {
      const shape = doc.Shapes.find((item) => item.Id === id);
      return { x: shape.X.Const, y: shape.Y.Const };
    }),
  };
});
await page.waitForTimeout(220);
const multiCenter = await rectCenter(0);
await page.keyboard.down('Control');
await page.mouse.move(multiCenter.x, multiCenter.y);
await page.mouse.down();
await page.mouse.move(multiCenter.x + 80, multiCenter.y + 60, { steps: 8 });
await page.mouse.up();
await page.keyboard.up('Control');
await page.waitForTimeout(350);
const multiAfter = await page.evaluate((before) => {
  const doc = window.vectanim.store.getDocument();
  const origin = before.ids.map((id) => {
    const shape = doc.Shapes.find((item) => item.Id === id);
    return { x: shape.X.Const, y: shape.Y.Const };
  });
  const copies = doc.Shapes.slice(-2).map((shape) => ({ x: shape.X.Const, y: shape.Y.Const }));
  return {
    count: doc.Shapes.length,
    origin,
    copies,
    selected: window.vectanim.store.getSelection(),
    copyIds: doc.Shapes.slice(-2).map((shape) => shape.Id),
  };
}, multiBefore);
const multiDelta = { x: multiAfter.copies[0].x - multiBefore.origin[0].x, y: multiAfter.copies[0].y - multiBefore.origin[0].y };
const multiDelta2 = { x: multiAfter.copies[1].x - multiBefore.origin[1].x, y: multiAfter.copies[1].y - multiBefore.origin[1].y };
check(
  'Multi-select Ctrl-drag copy: originals stay put, copies keep their relative offsets',
  multiAfter.count === multiBefore.count + 2 &&
    multiAfter.origin.every((point, index) => Math.abs(point.x - multiBefore.origin[index].x) < 0.01 && Math.abs(point.y - multiBefore.origin[index].y) < 0.01) &&
    Math.hypot(multiDelta.x, multiDelta.y) > 30 &&
    Math.abs(multiDelta.x - multiDelta2.x) < 0.01 &&
    Math.abs(multiDelta.y - multiDelta2.y) < 0.01 &&
    multiAfter.selected.length === 2 &&
    multiAfter.copyIds.every((id) => multiAfter.selected.includes(id)),
  `shapes ${multiBefore.count} → ${multiAfter.count}, delta ${multiDelta.x.toFixed(1)},${multiDelta.y.toFixed(1)} / ${multiDelta2.x.toFixed(1)},${multiDelta2.y.toFixed(1)}, ${multiAfter.selected.length} copies selected`,
);

/* ------------------------------ Property binding ------------------------------ */
await page.locator('.va-layer').first().click();
await page.waitForTimeout(200);
const bindButtons = await page.locator('.va-bind-btn').count();
check('Property panel shows bind buttons', bindButtons > 0, `${bindButtons} of them`);

await page.locator('.va-bind-btn').first().click();
await page.waitForTimeout(200);
check('Bind menu lists variables', (await page.locator('.va-menu-item').count()) > 0, `${await page.locator('.va-menu-item').count()} items`);
await page.locator('.va-menu-item').first().click();
await page.waitForTimeout(300);
const bound = await page.evaluate(() => {
  const doc = window.vectanim.store.getDocument();
  const selected = window.vectanim.store.getSelection();
  const shape = doc.Shapes.find((item) => item.Id === selected[0]);
  return JSON.stringify(shape).includes('"Bind"');
});
check('Property binding is written to the document', bound === true);
await page.screenshot({ path: join(shotDir, '02-properties.png') });
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);

/* ------------------------------ Variables / Animations ------------------------------ */
await page.locator('.va-tab').nth(1).click();
await page.waitForTimeout(250);
check('Variables panel lists variables', (await page.locator('.va-var').count()) > 0, `${await page.locator('.va-var').count()} of them`);
await page.screenshot({ path: join(shotDir, '03-variables.png') });

await page.locator('.va-tab').nth(2).click();
await page.waitForTimeout(250);
check('Animation panel shows the timeline', (await page.locator('.va-timeline').count()) > 0);
check('Keyframe nodes rendered', (await page.locator('.va-timeline-key').count()) > 0, `${await page.locator('.va-timeline-key').count()} of them`);
await page.screenshot({ path: join(shotDir, '04-animations.png') });

/* ------------------------------ Live preview ------------------------------ */
await page.locator('.va-btn.is-primary').first().click();
await page.waitForTimeout(1200);
check('Preview dialog opens', (await page.locator('.va-preview canvas').count()) > 0);
await page.screenshot({ path: join(shotDir, '05-preview.png') });
const previewPixel = await page.evaluate(() => {
  const canvas = document.querySelector('.va-preview canvas');
  if (!canvas) return null;
  const context = canvas.getContext('2d');
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let painted = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) painted += 1;
  }
  return { total: data.length / 4, painted };
});
check('Preview canvas renders pixels', (previewPixel?.painted ?? 0) > 1000, JSON.stringify(previewPixel));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

/* ------------------------------ SVG import ------------------------------ */
const beforeSvg = await shapeCount();
const imported = await page.evaluate(async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90" viewBox="0 0 120 90">
    <rect x="5" y="5" width="50" height="40" fill="#22c55e" stroke="#166534" stroke-width="2"/>
    <circle cx="85" cy="30" r="20" fill="#f97316"/>
    <path d="M10,70 L40,80 L70,70 Z" fill="#3b82f6"/>
  </svg>`;
  return window.vectanim.importSvgText(svg);
});
await page.waitForTimeout(500);
check('SVG import creates primitives', imported >= 3 && (await shapeCount()) === beforeSvg + imported, `imported ${imported}`);
const svgTypes = await page.evaluate(() => {
  const doc = window.vectanim.store.getDocument();
  return doc.Shapes.slice(-3).map((shape) => shape.Type).join(',');
});
check('SVG primitive types mapped correctly', svgTypes.includes('Rectangle') && svgTypes.includes('Ellipse') && svgTypes.includes('Path'), svgTypes);
await page.screenshot({ path: join(shotDir, '06-svg-import.png') });

/* ------------------------------ Export JSON ------------------------------ */
const downloadPromise = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
await page.keyboard.press('Control+s');
const download = await downloadPromise;
if (download) {
  const target = join(root, 'artifacts', 'export-smoke.vectanim.json');
  await download.saveAs(target);
  const text = await readFile(target, 'utf8');
  let ok = false;
  try {
    const parsed = JSON.parse(text);
    ok = Array.isArray(parsed.Shapes) && parsed.SchemaVersion === '1.0';
  } catch {
    ok = false;
  }
  check('Exported JSON parses and has the correct structure', ok, `${text.length} bytes`);
} else {
  check('Exported JSON parses and has the correct structure', false, 'download was not triggered');
}

/* ------------------------- Groups and multi-select ------------------------- */
// A group must behave like a single object: rename by double click, its own transform, and a
// common-property panel when several shapes are selected.
await page.locator('.va-tab').nth(0).click();
await page.waitForTimeout(250);
await page.evaluate(() => window.vectanim.store.setSelection([]));
await page.waitForTimeout(200);

const multiIds = await page.evaluate(() => {
  const doc = window.vectanim.store.getDocument();
  const grouped = new Set(doc.Groups.flatMap((group) => group.ShapeIds));
  return doc.Shapes.filter((shape) => !grouped.has(shape.Id)).slice(0, 2).map((shape) => shape.Id);
});
await page.evaluate((ids) => window.vectanim.store.setSelection(ids), multiIds);
await page.waitForTimeout(300);
const multiPanelText = await page.locator('.va-panel').nth(1).innerText();
check(
  'Multi-selection lists the common properties',
  /Common properties/.test(multiPanelText) && /Align/.test(multiPanelText),
  `${multiIds.length} shapes`,
);

const multiOpacity = page.locator('.va-panel').nth(1).locator('.va-row', { hasText: 'Opacity' }).first().locator('input[type="number"]');
await multiOpacity.fill('0.5');
await multiOpacity.press('Enter');
await page.waitForTimeout(300);
const opacityApplied = await page.evaluate((ids) => {
  const doc = window.vectanim.store.getDocument();
  return ids.every((id) => {
    const shape = doc.Shapes.find((item) => item.Id === id);
    return shape?.Opacity && 'Const' in shape.Opacity && Math.abs(Number(shape.Opacity.Const) - 0.5) < 1e-6;
  });
}, multiIds);
check('Editing a common property applies it to every selected shape', opacityApplied);

// Group those two shapes through the panel, then exercise the group panel
await page.locator('.va-panel').nth(1).locator('button', { hasText: /^Group$/ }).first().click();
await page.waitForTimeout(350);
const groupId = await page.evaluate(() => window.vectanim.store.getDocument().Groups.at(-1)?.GroupId ?? null);
check('Grouping from the panel creates a group', !!groupId, String(groupId));

const groupPanelText = await page.locator('.va-panel').nth(1).innerText();
check(
  'Group selection shows its own transform section',
  /Group transform/.test(groupPanelText) && /Offset X/.test(groupPanelText),
);
check('Group panel lists the members', /Members/.test(groupPanelText));

const groupHeaderName = page.locator('.va-layer-group-header .va-layer-name').last();
await groupHeaderName.dblclick();
await page.waitForTimeout(150);
const groupRenameOpen = (await page.locator('.va-layer-group-header input[type="text"]').count()) > 0;
check('Double-click renames a group', groupRenameOpen);
if (groupRenameOpen) {
  await page.keyboard.type('Smoke group');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const renamed = await page.evaluate(() => window.vectanim.store.getDocument().Groups.at(-1)?.Name);
  check('Renaming a group writes the new name', renamed === 'Smoke group', String(renamed));
}

const memberId = await page.evaluate(() => window.vectanim.store.getDocument().Groups.at(-1)?.ShapeIds[0] ?? null);
const memberCenter = () =>
  page.evaluate((id) => {
    const object = window.vectanim.view.objects.get(id);
    const center = object.getCenterPoint();
    return { x: Math.round(center.x), y: Math.round(center.y) };
  }, memberId);

const beforeOffset = await memberCenter();
const offsetField = page.locator('.va-panel').nth(1).locator('input[type="number"]').first();
await offsetField.fill('25');
await offsetField.press('Enter');
await page.waitForTimeout(350);
const afterOffset = await memberCenter();
check(
  'Group offset moves every member on the canvas',
  afterOffset.x - beforeOffset.x === 25 && afterOffset.y === beforeOffset.y,
  `${beforeOffset.x} → ${afterOffset.x}`,
);

const groupTranslate = await page.evaluate(() => {
  const group = window.vectanim.store.getDocument().Groups.at(-1);
  return group?.RenderTransform?.Translate?.X ?? null;
});
check('Group transform is written to the document', groupTranslate?.Const === 25, JSON.stringify(groupTranslate));

await page.evaluate(() => window.vectanim.store.setSelection([]));
await page.waitForTimeout(200);

/* ---------------------------- Localization ---------------------------- */
// Done last: switching the locale reloads the editor.
await page.goto(`${baseUrl}?lang=zh`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
const zhText = await page.locator('body').innerText();
check(
  '?lang=zh renders the Chinese UI',
  /图层/.test(zhText) && (await page.evaluate(() => document.documentElement.lang)) === 'zh-CN',
  `lang=${await page.evaluate(() => document.documentElement.lang)}`,
);
await page.screenshot({ path: join(shotDir, '07-zh-ui.png') });

await page.goto(baseUrl, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
const enText = await page.locator('body').innerText();
check(
  'Without the query parameter the UI is English again',
  /layers/i.test(enText) && !/图层/.test(enText),
  `lang=${await page.evaluate(() => document.documentElement.lang)}`,
);

/* ------------------------------ Console ------------------------------ */
check('No console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

await browser.close();
server.close();

const failed = results.filter((item) => !item.ok);
await writeFile(
  join(root, 'artifacts', 'smoke-report.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`,
  'utf8',
);

console.log(`\nPassed ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.error('Failed checks:', failed.map((item) => item.name).join(', '));
  process.exit(1);
}
