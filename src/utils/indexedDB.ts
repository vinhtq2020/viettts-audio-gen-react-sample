import { hashString } from "./hash";

const DB_NAME = "VieNeuTTS_Cache";
const DB_VERSION = 2;
const STORE_NAME = "audio_cache";
const STORE_JOBS = "batch_jobs";

/**
 * Sinh cache key ỔN ĐỊNH từ (voice, style, số trang, nội dung text).
 * Cùng 1 trang + cùng giọng + cùng phong cách + cùng nội dung → luôn ra
 * cùng 1 key, nên có thể tra lại cache sau khi F5/đóng mở lại tab.
 * Nếu người dùng đổi giọng/phong cách hoặc nội dung trang thay đổi,
 * key sẽ khác đi → tự động cache-miss và tạo audio mới (đúng như mong đợi).
 */
export function buildCacheKey(
  voice: string,
  style: string,
  pageNum: number,
  text: string,
): string {
  return `${voice}__${style}__p${pageNum}__${hashString(text)}`;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(STORE_JOBS)) {
        db.createObjectStore(STORE_JOBS, { keyPath: "documentId" });
      }
    };
  });
}

export async function cacheAudio(
  key: string,
  blob: Blob,
  metadata: any,
): Promise<void> {
  const db = await openDB();

  // 👇 FIX: Đọc blob thành ArrayBuffer TRƯỚC KHI mở transaction
  const arrayBuffer = await blob.arrayBuffer();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    // 👇 FIX: Dùng oncomplete/onerror của transaction, không phải request
    tx.oncomplete = () => {
      db.close(); // Đóng DB sau khi xong
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(new Error("Transaction aborted"));
    };

    // Put data
    store.put({ key, audio: arrayBuffer, metadata, timestamp: Date.now() });
  });
}

export async function getCachedAudio(
  key: string,
): Promise<{ blob: Blob; metadata: any } | null> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);

    // 👇 FIX: Đợi transaction complete thay vì chỉ request
    tx.oncomplete = () => {
      db.close();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };

    req.onsuccess = () => {
      if (!req.result) {
        resolve(null);
        return;
      }
      const blob = new Blob([req.result.audio], { type: "audio/wav" });
      resolve({ blob, metadata: req.result.metadata });
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteCachedAudio(key: string): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(new Error("Transaction aborted"));
    };

    store.delete(key);
  });
}

export async function clearAllCachedAudio(): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(new Error("Transaction aborted"));
    };

    store.clear();
  });
}

export async function clearOldCache(maxAgeDays: number = 7): Promise<void> {
  const db = await openDB();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };

    req.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest).result;
      if (!cursor) return;
      if (cursor.value.timestamp < cutoff) {
        cursor.delete();
      }
      cursor.continue();
    };
  });
}

export async function requestStorageQuota(): Promise<void> {
  if ("storage" in navigator && "persist" in navigator.storage) {
    const granted = await navigator.storage.persist();
    console.log(`Persistent storage: ${granted ? "granted" : "denied"}`);
  }
}

export interface StorageEstimate {
  usageBytes: number;
  quotaBytes: number;
}

/**
 * Đọc dung lượng storage thực tế trình duyệt đang cho phép dùng
 * (navigator.storage.estimate()). Đây là "mức tối đa cho phép" thật sự —
 * không phải con số cố định, mà do trình duyệt cấp phát tuỳ theo dung
 * lượng đĩa trống của máy. Trả về null nếu trình duyệt không hỗ trợ API
 * này (một số trình duyệt cũ, hoặc chế độ ẩn danh).
 */
export async function getStorageEstimate(): Promise<StorageEstimate | null> {
  if (!("storage" in navigator) || !("estimate" in navigator.storage)) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (usage === undefined || quota === undefined) return null;
    return { usageBytes: usage, quotaBytes: quota };
  } catch {
    return null;
  }
}

/**
 * Sinh ID ổn định cho 1 tài liệu (không phụ thuộc File object, vì file đã upload
 * không thể lưu lại — chỉ có thể so khớp lại khi người dùng import CÙNG file đó
 * lần nữa và nó parse ra đúng nội dung y hệt). Dùng tiêu đề + tổng số trang +
 * đoạn đầu/cuối văn bản để nhận diện tài liệu.
 */
export function computeDocumentId(
  title: string,
  totalPages: number,
  firstPageText: string,
  lastPageText: string,
): string {
  return hashString(
    `${title}::${totalPages}::${firstPageText.slice(0, 300)}::${lastPageText.slice(-300)}`,
  );
}

export type BatchJobStatus = "running" | "paused" | "error" | "completed";

export interface BatchJobRecord {
  documentId: string;
  title: string;
  startPage: number;
  endPage: number;
  /** Trang tiếp theo cần xử lý — con trỏ để tiếp tục khi bị gián đoạn. */
  nextPage: number;
  chunkSize: number;
  voice: string;
  style: string;
  status: BatchJobStatus;
  /** true nếu trình duyệt không hỗ trợ chọn thư mục -> dùng tải file từng lô thay thế. */
  useFallbackDownload: boolean;
  /** Handle thư mục đã chọn (Chromium hỗ trợ lưu handle này qua structured clone). */
  dirHandle?: FileSystemDirectoryHandle;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export async function saveBatchJob(job: BatchJobRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_JOBS, "readwrite");
    const store = tx.objectStore(STORE_JOBS);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(new Error("Transaction aborted"));
    };
    store.put(job);
  });
}

export async function getBatchJob(documentId: string): Promise<BatchJobRecord | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_JOBS, "readonly");
    const store = tx.objectStore(STORE_JOBS);
    const req = store.get(documentId);
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteBatchJob(documentId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_JOBS, "readwrite");
    const store = tx.objectStore(STORE_JOBS);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(new Error("Transaction aborted"));
    };
    store.delete(documentId);
  });
}
