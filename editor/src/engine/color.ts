/**
 * Color utilities.
 *
 * Key design: keep the two "document color" and "CSS color" semantics apart so the alpha
 * channel never ends up in the wrong position.
 *
 *  - Document color (written to .vectanim.json): `#AARRGGBB` (WPF convention); also accepts
 *    `#RRGGBB`, `#RGB`, `rgba(...)`, named colors, and the numeric `0xRRGGBB` (used for color bindings).
 *  - CSS color (fed to Canvas2D / SVG): `rgba(r, g, b, a)`.
 *
 * The two must not be mixed: CSS 8-digit hex is `#RRGGBBAA`, so feeding it to WPF would read the
 * alpha channel as red.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

/** Color value type used inside documents */
export type ColorValue = string | number;

const NAMED_COLORS: Record<string, string> = {
  transparent: '#00000000',
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  lime: '#00ff00',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  aqua: '#00ffff',
  magenta: '#ff00ff',
  fuchsia: '#ff00ff',
  silver: '#c0c0c0',
  gray: '#808080',
  grey: '#808080',
  maroon: '#800000',
  olive: '#808000',
  navy: '#000080',
  purple: '#800080',
  teal: '#008080',
  orange: '#ffa500',
  gold: '#ffd700',
  pink: '#ffc0cb',
  brown: '#a52a2a',
  darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9',
  lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3',
  dimgray: '#696969',
  steelblue: '#4682b4',
  skyblue: '#87ceeb',
  royalblue: '#4169e1',
  dodgerblue: '#1e90ff',
  darkblue: '#00008b',
  darkred: '#8b0000',
  darkgreen: '#006400',
  lightblue: '#add8e6',
  lightgreen: '#90ee90',
  lightyellow: '#ffffe0',
  whitesmoke: '#f5f5f5',
  gainsboro: '#dcdcdc',
  crimson: '#dc143c',
  tomato: '#ff6347',
  coral: '#ff7f50',
  goldenrod: '#daa520',
  chocolate: '#d2691e',
  slategray: '#708090',
  midnightblue: '#191970',
  darkorange: '#ff8c00',
  forestgreen: '#228b22',
  seagreen: '#2e8b57',
  turquoise: '#40e0d0',
  skyblueLight: '#87cefa',
  aliceblue: '#f0f8ff',
};

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hexToRgba(hex: string, alphaLast: boolean): Rgba | null {
  const expand = (text: string): string => text.split('').map((char) => char + char).join('');
  let body = hex;
  if (body.length === 3) body = expand(body);
  if (body.length === 4) body = expand(body);

  if (body.length === 6) {
    return {
      r: parseInt(body.slice(0, 2), 16),
      g: parseInt(body.slice(2, 4), 16),
      b: parseInt(body.slice(4, 6), 16),
      a: 1,
    };
  }
  if (body.length === 8) {
    const first = parseInt(body.slice(0, 2), 16);
    const second = parseInt(body.slice(2, 4), 16);
    const third = parseInt(body.slice(4, 6), 16);
    const fourth = parseInt(body.slice(6, 8), 16);
    if (alphaLast) {
      return { r: first, g: second, b: third, a: fourth / 255 };
    }
    return { r: second, g: third, b: fourth, a: first / 255 };
  }
  return null;
}

function parseFunctionColor(input: string): Rgba | null {
  const rgbMatch = /^rgba?\(([^)]+)\)$/i.exec(input);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (raw: string): number => (raw.endsWith('%') ? (parseFloat(raw) / 100) * 255 : parseFloat(raw));
    const alphaPart = parts.length >= 4 ? parts[3] : '1';
    const alpha = alphaPart.endsWith('%') ? parseFloat(alphaPart) / 100 : parseFloat(alphaPart);
    return {
      r: clampByte(channel(parts[0])),
      g: clampByte(channel(parts[1])),
      b: clampByte(channel(parts[2])),
      a: clamp01(Number.isFinite(alpha) ? alpha : 1),
    };
  }

  const hslMatch = /^hsla?\(([^)]+)\)$/i.exec(input);
  if (hslMatch) {
    const parts = hslMatch[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const hue = ((parseFloat(parts[0]) % 360) + 360) % 360;
    const saturation = clamp01(parseFloat(parts[1]) / 100);
    const lightness = clamp01(parseFloat(parts[2]) / 100);
    const alphaPart = parts.length >= 4 ? parts[3] : '1';
    const alpha = alphaPart.endsWith('%') ? parseFloat(alphaPart) / 100 : parseFloat(alphaPart);
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const hp = hue / 60;
    const second = chroma * (1 - Math.abs((hp % 2) - 1));
    let rgb: [number, number, number];
    if (hp < 1) rgb = [chroma, second, 0];
    else if (hp < 2) rgb = [second, chroma, 0];
    else if (hp < 3) rgb = [0, chroma, second];
    else if (hp < 4) rgb = [0, second, chroma];
    else if (hp < 5) rgb = [second, 0, chroma];
    else rgb = [chroma, 0, second];
    const m = lightness - chroma / 2;
    return {
      r: clampByte((rgb[0] + m) * 255),
      g: clampByte((rgb[1] + m) * 255),
      b: clampByte((rgb[2] + m) * 255),
      a: clamp01(Number.isFinite(alpha) ? alpha : 1),
    };
  }
  return null;
}

/** Parse by CSS rules (`#RRGGBBAA`, rgba(), named colors) */
export function parseCssColor(input: string | null | undefined): Rgba | null {
  if (!input) return null;
  const text = String(input).trim().toLowerCase();
  if (!text) return null;

  const named = NAMED_COLORS[text];
  if (named) return hexToRgba(named.replace('#', ''), true);
  if (text.startsWith('#')) return hexToRgba(text.slice(1), true);
  return parseFunctionColor(text);
}

/** Parse by the document convention (8-digit hex is `#AARRGGBB`) */
export function parseDocColor(value: ColorValue | null | undefined): Rgba | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    const int = Math.round(value) & 0xffffff;
    return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff, a: 1 };
  }

  const text = String(value).trim();
  if (!text) return null;

  const lowered = text.toLowerCase();
  const named = NAMED_COLORS[lowered];
  if (named) return hexToRgba(named.replace('#', ''), false);

  if (/^#[0-9a-fA-F]+$/.test(text)) return hexToRgba(text.slice(1), false);

  // Plain numeric strings are treated as 0xRRGGBB (the string form written by expressions/variables)
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (Number.isFinite(numeric)) return parseDocColor(numeric);
  }
  return parseFunctionColor(lowered);
}

function toHex2(value: number): string {
  return clampByte(value).toString(16).padStart(2, '0').toUpperCase();
}

/** Emit a document color `#AARRGGBB` */
export function toDocColor(rgba: Rgba): string {
  return `#${toHex2(Math.round(clamp01(rgba.a) * 255))}${toHex2(rgba.r)}${toHex2(rgba.g)}${toHex2(rgba.b)}`;
}

/** Normalize any CSS color into a document color; unparsable or fully transparent returns null */
export function normalizeColor(input: string | null | undefined): string | null {
  const rgba = parseCssColor(input);
  if (!rgba || rgba.a <= 0) return null;
  return toDocColor(rgba);
}

/** Keep alpha (even when 0); used for the canvas background */
export function normalizeColorKeepAlpha(input: string | null | undefined, fallback = '#FFFFFFFF'): string {
  const rgba = parseCssColor(input);
  if (!rgba) return fallback;
  return toDocColor(rgba);
}

/** Rgba → CSS rgba() */
export function rgbaToCss(rgba: Rgba): string {
  const alpha = Math.round(clamp01(rgba.a) * 1000) / 1000;
  return `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${alpha})`;
}

/** Document color → CSS rgba() */
export function toCssColor(input: ColorValue | null | undefined, fallback = 'transparent'): string {
  const rgba = parseDocColor(input);
  if (!rgba) return fallback;
  return rgbaToCss(rgba);
}

/** Document color → `#RRGGBB` (for <input type="color">) */
export function toHex6(input: ColorValue | null | undefined, fallback = '#000000'): string {
  const rgba = parseDocColor(input);
  if (!rgba) return fallback;
  return `#${toHex2(rgba.r)}${toHex2(rgba.g)}${toHex2(rgba.b)}`;
}

export function alphaOf(input: ColorValue | null | undefined, fallback = 1): number {
  const rgba = parseDocColor(input);
  return rgba ? rgba.a : fallback;
}

/** Adjust alpha and return a document color */
export function withAlpha(input: ColorValue | null | undefined, alpha: number): string {
  const rgba = parseDocColor(input) ?? { r: 0, g: 0, b: 0, a: 1 };
  return toDocColor({ ...rgba, a: alpha });
}

/** Relative luminance, used to pick a foreground color automatically */
export function isLightColor(input: ColorValue | null | undefined): boolean {
  const rgba = parseDocColor(input);
  if (!rgba) return false;
  const luminance = (0.299 * rgba.r + 0.587 * rgba.g + 0.114 * rgba.b) / 255;
  return luminance > 0.6;
}

/** Parse any document color value (used by the render layer) */
export function parseColorValue(value: ColorValue | null | undefined): Rgba | null {
  return parseDocColor(value);
}

/** Legacy alias: parse by the document convention */
export const parseColor = parseDocColor;

/** Legacy alias: emit WPF hex */
export const toWpfHex = toDocColor;
