import type { ConstantValue, ValueRef } from './types';

/** Variable resolver callback; returns undefined when the variable is absent */
export type VariableResolver = (name: string) => ConstantValue | undefined;

export function isConstRef(ref: ValueRef | null | undefined): ref is { Const: ConstantValue } {
  return !!ref && typeof ref === 'object' && 'Const' in ref;
}

export function isBindRef(ref: ValueRef | null | undefined): ref is { Bind: string } {
  return !!ref && typeof ref === 'object' && 'Bind' in ref;
}

export function makeConst(value: ConstantValue): ValueRef {
  return { Const: value };
}

export function makeBind(name: string): ValueRef {
  return { Bind: name };
}

/** Name of the bound variable; undefined for a constant */
export function boundVariable(ref: ValueRef | null | undefined): string | undefined {
  return isBindRef(ref) ? ref.Bind : undefined;
}

/** Constant value; undefined for a bound reference */
export function constValue(ref: ValueRef | null | undefined): ConstantValue | undefined {
  return isConstRef(ref) ? ref.Const : undefined;
}

/** Human-readable description, used by the properties panel */
export function describeRef(ref: ValueRef | null | undefined): string {
  if (!ref) return '—';
  if (isBindRef(ref)) return `⟨${ref.Bind}⟩`;
  return String(ref.Const);
}

export function cloneRef(ref: ValueRef): ValueRef {
  return isBindRef(ref) ? { Bind: ref.Bind } : { Const: ref.Const };
}

export function refEquals(a: ValueRef | null | undefined, b: ValueRef | null | undefined): boolean {
  if (!a || !b) return a === b;
  if (isBindRef(a) && isBindRef(b)) return a.Bind === b.Bind;
  if (isConstRef(a) && isConstRef(b)) return a.Const === b.Const;
  return false;
}

export function toNumber(value: ConstantValue | undefined, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function toBoolean(value: ConstantValue | undefined, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true' || lower === '1') return true;
    if (lower === 'false' || lower === '0' || lower === '') return false;
  }
  return fallback;
}

export function toStringValue(value: ConstantValue | undefined, fallback = ''): string {
  if (value === undefined) return fallback;
  if (typeof value === 'number') return String(value);
  return String(value);
}

/**
 * Resolve a numeric property.
 * Falls back to `fallback` when bound to a missing / non-numeric variable
 * (a runtime fault-tolerance strategy, kept consistent with the WPF side).
 */
export function resolveNumber(
  ref: ValueRef | null | undefined,
  resolver: VariableResolver,
  fallback = 0,
): number {
  if (!ref) return fallback;
  if (isConstRef(ref)) return toNumber(ref.Const, fallback);
  const value = resolver(ref.Bind);
  if (value === undefined) return fallback;
  return toNumber(value, fallback);
}

export function resolveString(
  ref: ValueRef | null | undefined,
  resolver: VariableResolver,
  fallback = '',
): string {
  if (!ref) return fallback;
  if (isConstRef(ref)) return toStringValue(ref.Const, fallback);
  const value = resolver(ref.Bind);
  if (value === undefined) return fallback;
  return toStringValue(value, fallback);
}

export function resolveBoolean(
  ref: ValueRef | null | undefined,
  resolver: VariableResolver,
  fallback = false,
): boolean {
  if (!ref) return fallback;
  if (isConstRef(ref)) return toBoolean(ref.Const, fallback);
  const value = resolver(ref.Bind);
  if (value === undefined) return fallback;
  return toBoolean(value, fallback);
}

/** Whether the property is a "dynamic" (bound) reference — used for dirty checks */
export function isDynamic(ref: ValueRef | null | undefined): boolean {
  return isBindRef(ref);
}
