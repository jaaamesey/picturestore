/**
 * Uploaded fonts, kept in IndexedDB so they're there next time. One object
 * store of font files by id; a plain promise wrapper is all it needs.
 */

export interface StoredFont {
  readonly id: string;
  /** The file's name, as uploaded. */
  readonly name: string;
  /** sfnt data (WOFF is stored decompressed). */
  readonly bytes: Uint8Array;
  readonly added: number;
}

const DB = "picturestore-fonts";
const STORE = "fonts";

let db: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  return (db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const tx = d.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export const storedFonts = (): Promise<StoredFont[]> => run("readonly", (s) => s.getAll() as IDBRequest<StoredFont[]>).catch(() => []);
export const storeFont = (f: StoredFont): Promise<unknown> => run("readwrite", (s) => s.put(f));
export const deleteStoredFont = (id: string): Promise<unknown> => run("readwrite", (s) => s.delete(id));
