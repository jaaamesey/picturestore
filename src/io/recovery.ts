/**
 * Recovery information (Preferences ▸ File Handling): unsaved documents are
 * written periodically to the origin-private file system, so a crash — or
 * the tab being killed for running out of memory — loses at most a few
 * minutes of work. Each entry is a PSD plus a small JSON record.
 */
export interface RecoveryEntry {
  readonly key: string;
  readonly name: string;
  readonly savedAt: number;
  readonly file: File;
}

const DIR = "recovery";

async function directory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(DIR, { create: true });
  } catch {
    return null; // OPFS unavailable (e.g. some private windows)
  }
}

async function write(dir: FileSystemDirectoryHandle, name: string, data: Blob | string) {
  const stream = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await stream.write(data);
  await stream.close();
}

/** Writes (or replaces) a document's recovery copy. The PSD is written before its record, so a record always has its file. */
export async function saveRecovery(key: string, name: string, psd: Blob): Promise<void> {
  const dir = await directory();
  if (!dir) return;
  await write(dir, `${key}.psd`, psd);
  await write(dir, `${key}.json`, JSON.stringify({ name, savedAt: Date.now() }));
}

export async function removeRecovery(key: string): Promise<void> {
  const dir = await directory();
  if (!dir) return;
  for (const name of [`${key}.json`, `${key}.psd`]) await dir.removeEntry(name).catch(() => {});
}

/** Recovery copies left by earlier sessions, oldest first. Incomplete entries are ignored. */
export async function listRecovery(): Promise<RecoveryEntry[]> {
  const dir = await directory();
  if (!dir) return [];
  const entries: RecoveryEntry[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (!name.endsWith(".json") || handle.kind !== "file") continue;
    const key = name.slice(0, -5);
    try {
      const meta = JSON.parse(await (await (handle as FileSystemFileHandle).getFile()).text()) as { name: string; savedAt: number };
      const file = await (await dir.getFileHandle(`${key}.psd`)).getFile();
      entries.push({ key, name: meta.name, savedAt: meta.savedAt, file });
    } catch {
      // Torn write: skip it.
    }
  }
  return entries.sort((a, b) => a.savedAt - b.savedAt);
}

export const newRecoveryKey = () => crypto.randomUUID();
