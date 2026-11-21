const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Client-generated section/block/menu-item id (contract P3-3): 10 chars of [a-z0-9] from crypto.getRandomValues. */
export function generateId(length = 10): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  // 256 % 36 = 4 → the first 4 symbols are very slightly more likely; acceptable for non-secret ids.
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** Returns an id that is not in `taken`. */
export function uniqueId(taken: Set<string>): string {
  let id = generateId();
  while (taken.has(id)) id = generateId();
  return id;
}
