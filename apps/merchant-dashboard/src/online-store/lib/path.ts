/** Reads a dot path (`club.heading`) from a plain object. */
export function getAt(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), obj);
}

/** Immutable set of a dot path. `undefined` removes the key (optional settings are omitted, not emptied). */
export function setAt<T extends Record<string, unknown>>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.');
  const copy: Record<string, unknown> = { ...obj };
  if (rest.length === 0) {
    if (value === undefined) delete copy[head!];
    else copy[head!] = value;
    return copy as T;
  }
  const child = copy[head!];
  copy[head!] = setAt(child && typeof child === 'object' ? (child as Record<string, unknown>) : {}, rest.join('.'), value);
  return copy as T;
}
