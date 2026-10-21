// File System Access API (Chromium). Not yet in TypeScript's DOM lib.
interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

interface Window {
  showOpenFilePicker?(options?: { multiple?: boolean; types?: FilePickerAcceptType[] }): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(options?: { suggestedName?: string; types?: FilePickerAcceptType[] }): Promise<FileSystemFileHandle>;
}

interface FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}
