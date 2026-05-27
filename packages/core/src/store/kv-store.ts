/**
 * Minimal async key/value store. Two implementations ship:
 *
 * - `InMemoryKVStore` — for tests and ephemeral sessions.
 * - `IndexedDBKVStore` — for browser persistence.
 *
 * Anything stored MUST be JSON-serialisable. The store does not
 * encrypt at rest — callers wrap values in WebAuthn PRF-derived keys
 * (or similar) before writing if the value is sensitive (e.g. a
 * holder identity's secret JWK).
 */
export interface KVStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Enumerate keys, optionally filtered to those starting with
   *  `prefix`. Order is unspecified. Used for prefix-scanned
   *  collections (e.g. multi-VTA holder records under
   *  `pnm/holder-identity/v4/`). */
  keys(prefix?: string): Promise<string[]>;
}

/** Backing for tests. Forgets state on process exit. */
export class InMemoryKVStore implements KVStore {
  private readonly map = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const v = this.map.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async keys(prefix?: string): Promise<string[]> {
    const out: string[] = [];
    for (const k of this.map.keys()) {
      if (prefix === undefined || k.startsWith(prefix)) out.push(k);
    }
    return out;
  }
}

/**
 * `IndexedDB`-backed `KVStore`. Single object store, single
 * database. Suitable for browser + extension contexts where
 * `indexedDB` is available. Node 22+ has `indexedDB` via the
 * `node:sqlite`-backed implementation behind a flag; tests should
 * use `InMemoryKVStore` instead.
 */
export class IndexedDBKVStore implements KVStore {
  private readonly dbName: string;
  private readonly storeName: string;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(opts?: { dbName?: string; storeName?: string }) {
    this.dbName = opts?.dbName ?? "pnm";
    this.storeName = opts?.storeName ?? "kv";
  }

  async get<T>(key: string): Promise<T | undefined> {
    const db = await this.openDb();
    return new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const req = tx.objectStore(this.storeName).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  }

  async put(key: string, value: unknown): Promise<void> {
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      tx.objectStore(this.storeName).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async delete(key: string): Promise<void> {
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      tx.objectStore(this.storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async keys(prefix?: string): Promise<string[]> {
    const db = await this.openDb();
    // Use a key range when a prefix is provided so IndexedDB does the
    // filtering — avoids walking the entire keyspace for a handful of
    // matches. The upper bound is `prefix + '￿'` (the highest
    // BMP code point), giving a half-open range that captures every
    // string starting with `prefix`.
    const range =
      prefix !== undefined
        ? IDBKeyRange.bound(prefix, prefix + "￿", false, false)
        : undefined;
    return new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const req = range !== undefined ? store.getAllKeys(range) : store.getAllKeys();
      req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String));
      req.onerror = () => reject(req.error);
    });
  }

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }
}
