/** Inline SVG icons (24×24, stroke uses currentColor so they follow the theme) */

const PATHS: Record<string, string> = {
  globe: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3a15 15 0 010 18M12 3a15 15 0 000 18',
  select: 'M4 3l7 17 2.5-6.5L20 11z',
  line: 'M4 20L20 4',
  rect: 'M4 5h16v14H4z',
  ellipse: 'M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z',
  arc: 'M3 18a9 9 0 0118 0M3 18h18',
  polygon: 'M12 3l8 6-3 10H7L4 9z',
  pen: 'M4 20l4-1 10-10-3-3L5 16z M14 6l3 3',
  pencil: 'M3 21l4-1 12-12-3-3L4 17z',
  hand: 'M8 13V5a1.5 1.5 0 013 0v6m0-1a1.5 1.5 0 013 0v1m0 0a1.5 1.5 0 013 0v5a6 6 0 01-6 6h-2a6 6 0 01-6-6v-3l3 2',
  undo: 'M9 14L4 9l5-5 M4 9h9a7 7 0 010 14H7',
  redo: 'M15 14l5-5-5-5 M20 9h-9a7 7 0 000 14h6',
  zoomIn: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3M11 8v6M8 11h6',
  zoomOut: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3M8 11h6',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  grid: 'M3 9h18M3 15h18M9 3v18M15 3v18',
  magnet: 'M6 4v8a6 6 0 0012 0V4h-4v8a2 2 0 01-4 0V4z',
  play: 'M8 5l11 7-11 7z',
  pause: 'M9 5v14M15 5v14',
  stop: 'M6 6h12v12H6z',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z M12 15a3 3 0 100-6 3 3 0 000 6z',
  eyeOff: 'M3 3l18 18 M10.6 6.2A9.6 9.6 0 0112 6c6.5 0 10 6 10 6a17 17 0 01-3.3 4M6.3 8.3A16.6 16.6 0 002 12s3.5 6 10 6a9.7 9.7 0 003.4-.6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  folder: 'M3 7h6l2 2h10v10H3z',
  download: 'M12 4v11M7 11l5 5 5-5M4 20h16',
  upload: 'M12 20V9M7 13l5-5 5 5M4 4h16',
  save: 'M5 3h11l3 3v15H5zM8 3v6h7V3M8 21v-7h8v7',
  file: 'M6 3h8l4 4v14H6zM14 3v5h4',
  link: 'M9 15l6-6M10 6l1-1a4 4 0 016 6l-1 1M14 18l-1 1a4 4 0 01-6-6l1-1',
  unlink: 'M9 15l2-2M14 10l2-2M4 4l16 16',
  lock: 'M6 11h12v9H6zM9 11V8a3 3 0 016 0v3',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1l2-1.6-2-3.4-2.3 1a7 7 0 00-1.7-1L14.5 3h-4l-.4 2.5a7 7 0 00-1.7 1l-2.3-1-2 3.4L6 11a7 7 0 000 2l-2 1.6 2 3.4 2.3-1a7 7 0 001.7 1l.4 2.5h4l.4-2.5a7 7 0 001.7-1l2.3 1 2-3.4-2-1.6c.1-.3.1-.7.1-1z',
  image: 'M3 5h18v14H3zM3 15l5-5 4 4 3-3 6 6',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  code: 'M8 6l-5 6 5 6M16 6l5 6-5 6',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  warning: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  check: 'M4 12l5 5L20 6',
  copy: 'M9 9h10v12H9zM5 15V3h10',
  group: 'M4 4h6v6H4zM14 14h6v6h-6zM10 7h4v7h-4z',
  ungroup: 'M4 4h6v6H4zM14 14h6v6h-6z',
  arrowUp: 'M12 20V4M5 11l7-7 7 7',
  arrowDown: 'M12 4v16M5 13l7 7 7-7',
  alignLeft: 'M4 3v18M8 7h9M8 15h6',
  alignCenterH: 'M12 3v18M7 7h10M9 15h6',
  alignRight: 'M20 3v18M7 7h9M10 15h6',
  alignTop: 'M3 4h18M7 8v9M15 8v6',
  alignCenterV: 'M3 12h18M7 7v10M15 9v6',
  alignBottom: 'M3 20h18M7 7v9M15 10v6',
  distribute: 'M4 3v18M20 3v18M9 8h6v8H9z',
  flipH: 'M12 3v18M4 8l5 4-5 4zM20 8l-5 4 5 4z',
  flipV: 'M3 12h18M8 4l4 5 4-5zM8 20l4-5 4 5z',
  close: 'M6 6l12 12M18 6L6 18',
  variable: 'M5 7c0-2 2-3 4-3s3 2 3 5-1 6-4 8M19 9c-3 0-5 2-5 5s2 5 4 5M7 14h8',
  expression: 'M4 6h6l-3 6 3 6H4M14 6v12M14 12h6',
  keyframe: 'M12 4l6 8-6 8-6-8z',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 5v6h-6',
  warning2: 'M12 3l9 17H3z',
  dot: 'M12 12h.01',
};

export function icon(name: string, size = 18, strokeWidth = 1.7): string {
  const path = PATHS[name] ?? PATHS.dot;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
}

export function iconNode(name: string, size = 18): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'va-icon';
  span.innerHTML = icon(name, size);
  return span;
}
