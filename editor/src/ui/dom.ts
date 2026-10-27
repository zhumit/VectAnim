/** Minimal DOM helpers, so the editor does not need a UI framework and its version risk. */

import { t } from '../i18n';

type Child = Node | string | number | null | undefined | false;

export interface ElementProps {
  class?: string;
  className?: string;
  id?: string;
  title?: string;
  text?: string;
  html?: string;
  type?: string;
  value?: string | number;
  placeholder?: string;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  checked?: boolean;
  disabled?: boolean;
  selected?: boolean;
  draggable?: boolean;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
  attrs?: Record<string, string | number | boolean | undefined>;
  on?: Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElementProps = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyProps(node, props);
  appendChildren(node, children);
  return node;
}

export function applyProps(node: HTMLElement, props: ElementProps): void {
  if (props.class) node.className = props.class;
  if (props.className) node.className = props.className;
  if (props.id) node.id = props.id;
  if (props.title) node.title = props.title;
  if (props.text !== undefined) node.textContent = String(props.text);
  if (props.html !== undefined) node.innerHTML = props.html;

  const element = node as HTMLInputElement;
  if (props.type !== undefined) element.type = props.type;
  if (props.value !== undefined) element.value = String(props.value);
  if (props.placeholder !== undefined) element.placeholder = props.placeholder;
  if (props.min !== undefined) element.min = String(props.min);
  if (props.max !== undefined) element.max = String(props.max);
  if (props.step !== undefined) element.step = String(props.step);
  if (props.checked !== undefined) element.checked = props.checked;
  if (props.disabled !== undefined) element.disabled = props.disabled;
  if (props.selected !== undefined) (node as HTMLOptionElement).selected = props.selected;
  if (props.draggable !== undefined) node.draggable = props.draggable;

  if (props.style) {
    if (typeof props.style === 'string') node.setAttribute('style', props.style);
    else Object.assign(node.style, props.style);
  }

  if (props.dataset) {
    for (const [key, value] of Object.entries(props.dataset)) node.dataset[key] = value;
  }

  if (props.attrs) {
    for (const [key, value] of Object.entries(props.attrs)) {
      if (value === undefined || value === false) continue;
      node.setAttribute(key, String(value));
    }
  }

  if (props.on) {
    for (const [event, handler] of Object.entries(props.on)) {
      if (handler) node.addEventListener(event, handler as EventListener);
    }
  }
}

export function appendChildren(node: HTMLElement, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
  }
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function on<K extends keyof HTMLElementEventMap>(
  node: HTMLElement | Document | Window,
  event: K,
  handler: (ev: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void {
  node.addEventListener(event, handler as EventListener, options);
  return () => node.removeEventListener(event, handler as EventListener, options);
}

export function debounce<T extends (...args: never[]) => void>(fn: T, delay: number): T {
  let timer: number | undefined;
  return ((...args: never[]) => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  }) as T;
}

/** Number formatting: at most 3 decimals, trailing zeros dropped. */
export function formatNumber(value: number | undefined | null, digits = 3): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 10 ** digits) / 10 ** digits;
  return String(rounded);
}

export function formatTime(seconds: number): string {
  return `${seconds.toFixed(2)}s`;
}

/** Tiny modal dialog; returns a close function. */
export function openModal(options: {
  title: string;
  content: HTMLElement;
  width?: number;
  footer?: HTMLElement;
  onClose?: () => void;
}): { close: () => void; root: HTMLElement } {
  const overlay = el('div', { class: 'va-modal-overlay' });
  const dialog = el('div', { class: 'va-modal', style: { width: `${options.width ?? 520}px` } });

  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    options.onClose?.();
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };

  const header = el('div', { class: 'va-modal-header' }, [
    el('h3', { text: options.title }),
    el('button', { class: 'va-icon-btn', title: t('common.close'), html: '✕', on: { click: close } }),
  ]);

  const body = el('div', { class: 'va-modal-body' }, [options.content]);
  dialog.append(header, body);
  if (options.footer) dialog.append(el('div', { class: 'va-modal-footer' }, [options.footer]));
  overlay.append(dialog);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  return { close, root: dialog };
}

export interface ToastOptions {
  type?: 'info' | 'success' | 'warning' | 'error';
  duration?: number;
}

let toastHost: HTMLElement | null = null;

export function toast(message: string, options: ToastOptions = {}): void {
  if (!toastHost) {
    toastHost = el('div', { class: 'va-toast-host' });
    document.body.append(toastHost);
  }
  const type = options.type ?? 'info';
  const node = el('div', { class: `va-toast va-toast-${type}`, text: message });
  toastHost.append(node);
  const duration = options.duration ?? (type === 'error' ? 6000 : 3000);
  window.setTimeout(() => {
    node.classList.add('va-toast-out');
    window.setTimeout(() => node.remove(), 220);
  }, duration);
}

/** Make an element draggable (used by the timeline); returns a cleanup function. */
export function dragify(
  element: HTMLElement,
  handlers: {
    onStart?: (event: PointerEvent) => void;
    onMove: (event: PointerEvent, delta: { dx: number; dy: number }) => void;
    onEnd?: (event: PointerEvent) => void;
  },
): () => void {
  let startX = 0;
  let startY = 0;
  let active = false;

  const down = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    active = true;
    startX = event.clientX;
    startY = event.clientY;
    element.setPointerCapture(event.pointerId);
    handlers.onStart?.(event);
    event.preventDefault();
  };

  const move = (event: PointerEvent): void => {
    if (!active) return;
    handlers.onMove(event, { dx: event.clientX - startX, dy: event.clientY - startY });
  };

  const up = (event: PointerEvent): void => {
    if (!active) return;
    active = false;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    handlers.onEnd?.(event);
  };

  element.addEventListener('pointerdown', down);
  element.addEventListener('pointermove', move);
  element.addEventListener('pointerup', up);
  element.addEventListener('pointercancel', up);

  return () => {
    element.removeEventListener('pointerdown', down);
    element.removeEventListener('pointermove', move);
    element.removeEventListener('pointerup', up);
    element.removeEventListener('pointercancel', up);
  };
}

/** File picker dialog. */
export function pickFile(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', attrs: { accept, multiple: multiple ? 'multiple' : undefined } });
    input.style.display = 'none';
    document.body.append(input);
    input.addEventListener('change', () => {
      const files = input.files ? [...input.files] : [];
      input.remove();
      resolve(files);
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve([]);
    });
    input.click();
  });
}

export function downloadFile(filename: string, content: string | Blob, mime = 'application/json'): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = el('a', { attrs: { href: url, download: filename } });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ------------------------------------------------------------------ *
 * Popup menu / confirm dialog
 * ------------------------------------------------------------------ */

export interface MenuItem {
  label: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  onSelect?: () => void;
}

let activeMenu: HTMLElement | null = null;

export function closeMenu(): void {
  activeMenu?.remove();
  activeMenu = null;
}

export function openMenu(anchor: HTMLElement, items: MenuItem[], options: { align?: 'left' | 'right'; width?: number } = {}): void {
  closeMenu();
  const menu = el('div', { class: 'va-menu', style: { width: `${options.width ?? 190}px` } });

  for (const item of items) {
    if (item.separator) {
      menu.append(el('div', { class: 'va-menu-sep' }));
      continue;
    }
    const row = el('button', {
      class: `va-menu-item${item.danger ? ' is-danger' : ''}`,
      disabled: item.disabled,
      on: {
        click: () => {
          closeMenu();
          item.onSelect?.();
        },
      },
    }, [
      el('span', { class: 'va-menu-label', text: item.label }),
      item.hint ? el('span', { class: 'va-menu-hint', text: item.hint }) : null,
    ]);
    menu.append(row);
  }

  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const left = options.align === 'right' ? rect.right - menuRect.width : rect.left;
  const top = Math.min(window.innerHeight - menuRect.height - 8, rect.bottom + 4);
  menu.style.left = `${Math.max(6, Math.min(window.innerWidth - menuRect.width - 6, left))}px`;
  menu.style.top = `${Math.max(6, top)}px`;
  activeMenu = menu;

  const onDocDown = (event: MouseEvent): void => {
    if (menu.contains(event.target as Node) || anchor.contains(event.target as Node)) return;
    closeMenu();
    document.removeEventListener('mousedown', onDocDown, true);
  };
  window.setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0);
}

/** Single-line text input dialog. */
export function promptDialog(options: {
  title: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  validate?: (value: string) => string | undefined;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const input = el('input', {
      type: 'text',
      value: options.defaultValue ?? '',
      placeholder: options.placeholder ?? '',
      style: { width: '100%' },
    });
    const error = el('div', { class: 'va-hint is-error', style: { minHeight: '16px' } });
    const content = el('div', { style: { display: 'grid', gap: '6px' } }, [
      el('div', { class: 'va-hint', text: options.label }),
      input,
      error,
    ]);

    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      handle.close();
      resolve(value);
    };

    const submit = (): void => {
      const value = input.value.trim();
      const message = options.validate?.(value);
      if (message) {
        error.textContent = message;
        input.focus();
        return;
      }
      finish(value);
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
      if (event.key === 'Escape') finish(null);
      event.stopPropagation();
    });

    const footer = el('div', { class: 'va-list-row' }, [
      el('button', { class: 'va-btn', text: t('common.cancel'), on: { click: () => finish(null) } }),
      el('button', { class: 'va-btn is-primary', text: options.confirmText ?? t('common.confirm'), on: { click: submit } }),
    ]);

    const handle = openModal({
      title: options.title,
      content,
      width: 420,
      footer,
      onClose: () => finish(null),
    });
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
  });
}

/** Confirmation dialog for destructive actions. */
export function confirmDialog(options: {
  title: string;
  message: string;
  confirmText?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const content = el('div', { class: 'va-hint', style: { fontSize: '12.5px', lineHeight: '1.8' }, text: options.message });
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      handle.close();
      resolve(value);
    };
    const footer = el('div', { class: 'va-list-row' }, [
      el('button', { class: 'va-btn', text: t('common.cancel'), on: { click: () => finish(false) } }),
      el('button', {
        class: `va-btn ${options.danger ? 'is-danger' : 'is-primary'}`,
        text: options.confirmText ?? t('common.confirm'),
        on: { click: () => finish(true) },
      }),
    ]);
    const handle = openModal({
      title: options.title,
      content,
      width: 420,
      footer,
      onClose: () => finish(false),
    });
  });
}
