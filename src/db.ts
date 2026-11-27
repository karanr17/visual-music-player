const DB_NAME = "visual-music-player";
const STORES = ["scripts", "songPrefs", "kv", "unmapped", "sprites", "analysis", "plates"] as const;
type Store = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 4);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => {
      // Another tab upgrading the schema must not be blocked by this connection.
      req.result.onversionchange = () => {
        req.result.close();
        dbPromise = null;
      };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store: Store, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await open()).transaction(store, mode).objectStore(store);
}

export async function dbGet<T>(store: Store, key: string): Promise<T | undefined> {
  try {
    return await wrap((await tx(store, "readonly")).get(key));
  } catch (err) {
    console.warn("[db] get failed", store, key, err);
    return undefined;
  }
}

export async function dbPut(store: Store, key: string, value: unknown): Promise<void> {
  try {
    await wrap((await tx(store, "readwrite")).put(value, key));
  } catch (err) {
    console.warn("[db] put failed", store, key, err);
  }
}

export async function dbDelete(store: Store, key: string): Promise<void> {
  try {
    await wrap((await tx(store, "readwrite")).delete(key));
  } catch (err) {
    console.warn("[db] delete failed", store, key, err);
  }
}

export async function dbEntries<T>(store: Store): Promise<[string, T][]> {
  try {
    const s = await tx(store, "readonly");
    const [keys, values] = await Promise.all([wrap(s.getAllKeys()), wrap(s.getAll())]);
    return keys.map((k, i) => [String(k), values[i] as T]);
  } catch (err) {
    console.warn("[db] entries failed", store, err);
    return [];
  }
}
