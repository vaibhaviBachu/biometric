/**
 * Page cache: the last data a page loaded, kept in memory so switching back to a page shows it at once
 * while a fresh copy loads in the background (the page then updates to the fresh copy).
 *
 * Rules that keep it safe:
 * - memory only: nothing is written to storage, a reload starts empty;
 * - it never replaces loading: callers still fetch every time, the cache only fills the gap while they wait;
 * - entries expire (MAX_AGE_MS) and the whole cache is emptied when the signed-in user changes;
 * - callers drop an entry after they change that data (rename, delete) so the old copy is not shown.
 */

const MAX_AGE_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 200;

const store = new Map<string, { value: unknown; at: number }>();

/** The last value stored under `key`, or undefined when there is none or it is too old. */
export function peekPageCache<T>(key: string): T | undefined {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > MAX_AGE_MS) {
    store.delete(key);
    return undefined;
  }
  return hit.value as T;
}

export function putPageCache(key: string, value: unknown): void {
  store.delete(key); // re-inserting moves it to the newest position
  store.set(key, { value, at: Date.now() });
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Drops one entry, or every entry whose key starts with `prefix`. */
export function dropPageCache(prefixOrKey: string): void {
  for (const key of [...store.keys()]) {
    if (key === prefixOrKey || key.startsWith(prefixOrKey)) store.delete(key);
  }
}

export function clearPageCache(): void {
  store.clear();
}
