export {};

declare global {
  interface SaveFilePickerAcceptType {
    description?: string;
    accept: Record<string, string[]>;
  }

  interface SaveFilePickerOptions {
    suggestedName?: string;
    types?: SaveFilePickerAcceptType[];
  }

  interface DirectoryPickerOptions {
    id?: string;
    mode?: "read" | "readwrite";
    startIn?: string;
  }

  interface FileSystemHandlePermissionDescriptor {
    mode?: "read" | "readwrite";
  }

  interface FileSystemHandle {
    queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  }

  interface Window {
    /**
     * File System Access API — chỉ có trên Chrome/Edge/Opera (Chromium).
     * Không có trên Firefox/Safari, luôn kiểm tra `'showSaveFilePicker' in window` trước khi gọi.
     */
    showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
    showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  }
}
