import { useState, useRef, useCallback, useEffect } from "react";
import {
  getCachedAudio,
  cacheAudio,
  deleteCachedAudio,
  clearAllCachedAudio,
  clearOldCache,
  requestStorageQuota,
  getStorageEstimate,
  buildCacheKey,
  computeDocumentId,
  saveBatchJob,
  getBatchJob,
  deleteBatchJob,
  type StorageEstimate,
  type BatchJobRecord,
} from "../utils/indexedDB";
import { chunkText, chunkTextStrings } from "../utils/textChunker";
import { API_URL } from "../config";
import { useToast } from "../components/Toast";

const PAGES_PER_BATCH = 10;
const DEFAULT_PAGES_PER_GENERATE = 5;
const MAX_PAGES_PER_GENERATE = 10;
// Kích thước 1 lô trong tác vụ tạo audio hàng loạt tự động: cứ đủ N trang này
// là export thành 1 file + xoá cache để giải phóng bộ nhớ, rồi làm tiếp lô sau.
const BATCH_JOB_CHUNK_SIZE = 10;

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, "_").trim();
  return cleaned || "audio";
}

/**
 * Xin quyền ghi vào 1 thư mục đã chọn trước đó (dùng khi tiếp tục tác vụ sau
 * gián đoạn), hoặc mở hộp thoại chọn thư mục mới nếu chưa có/quyền đã bị thu hồi.
 * PHẢI được gọi trực tiếp trong 1 user gesture (onClick) — trình duyệt yêu cầu vậy.
 *
 * useFallback=true nghĩa là trình duyệt không hỗ trợ File System Access API
 * (Firefox/Safari) -> sẽ dùng tải file từng lô về thư mục Downloads mặc định thay thế.
 */
async function pickDirectoryForJob(
  existingHandle?: FileSystemDirectoryHandle,
): Promise<{ handle: FileSystemDirectoryHandle | null; useFallback: boolean }> {
  if (!window.showDirectoryPicker) {
    return { handle: null, useFallback: true };
  }

  if (existingHandle) {
    try {
      const already = await existingHandle.queryPermission?.({ mode: "readwrite" });
      if (already === "granted") return { handle: existingHandle, useFallback: false };
      const granted = await existingHandle.requestPermission?.({ mode: "readwrite" });
      if (granted === "granted") return { handle: existingHandle, useFallback: false };
    } catch {
      // Quyền bị thu hồi hoặc handle không còn hợp lệ -> rơi xuống chọn lại thư mục bên dưới.
    }
  }

  try {
    const handle = await window.showDirectoryPicker!({ mode: "readwrite" });
    return { handle, useFallback: false };
  } catch {
    // Người dùng bấm Hủy ở hộp thoại chọn thư mục.
    return { handle: null, useFallback: false };
  }
}

async function writeChunkToDirectory(
  dirHandle: FileSystemDirectoryHandle,
  filename: string,
  blob: Blob,
): Promise<void> {
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}
const MAX_TEXT_PER_REQUEST = 1800;
const MAX_RETRIES = 2;
const HIGHLIGHT_CHUNK_SIZE = 400;
const AUDIO_PIPELINE_VERSION = "v2-pauses";
// 👇 Số trang tối đa được giữ "nóng" (blob URL sống) trong RAM cùng lúc.
// Trang bị giải phóng khỏi RAM KHÔNG mất dữ liệu — vẫn nằm trong IndexedDB
// và sẽ tự tải lại (rất nhanh, không cần gọi API) khi cần phát/export.
const RESIDENT_AUDIO_CAP = 30;
// 👇 Khoảng nghỉ mặc định giữa các lần gọi TTS liên tiếp (ms), để GPU có
// nhịp nghỉ thay vì chạy liên tục hàng giờ khi tạo audio cho cả cuốn sách.
// Có thể chỉnh qua setGenerationPaceMs.
const DEFAULT_GENERATION_PACE_MS = 250;
const LAST_VOICE_KEY = "vieneu_last_voice";
const LAST_STYLE_KEY = "vieneu_last_style";

export interface Voice {
  id: string;
  name: string;
  type?: 'preset' | 'cloned';
}

export interface PageState {
  pageNum: number;
  text: string;
  audioUrl: string | null;
  isLoading: boolean;
  isGenerated: boolean;
  isPlayed: boolean;
  generationError?: string;
  retryCount?: number;
  voiceUsed?: string;
}

const VALID_STYLES = [
  { id: "tu_nhien", name: "Tự nhiên" },
  { id: "tin_tuc", name: "Tin tức" },
  { id: "doc_truyen", name: "Đọc truyện" },
];

export interface GenerationProgress {
  current: number;
  total: number;
  pageNum: number;
  status: "idle" | "generating" | "success" | "error";
  errorPage?: number;
}

export interface BatchJobUIState {
  status: "running" | "paused" | "error" | "completed";
  startPage: number;
  endPage: number;
  /** Trang tiếp theo sẽ xử lý — cũng là điểm sẽ tiếp tục nếu tạm dừng/lỗi. */
  nextPage: number;
  chunkSize: number;
  /** true nếu đang tải file từng lô về Downloads thay vì ghi thẳng vào thư mục đã chọn. */
  useFallbackDownload: boolean;
  errorMessage?: string;
}

export function useTTS() {
  const [clonedVoices, setClonedVoices] = useState<Voice[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  // 👇 BUG FIX #3: theo dõi trạng thái "đang tạm dừng" tách biệt với "đã dừng hẳn",
  // để nút Đọc biết nên resume() tiếp tục hay play(0) từ đầu.
  const [isPaused, setIsPaused] = useState(false);
  const [isLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState<GenerationProgress>({
    current: 0,
    total: DEFAULT_PAGES_PER_GENERATE,
    pageNum: 0,
    status: "idle",
  });
  const [currentPage, setCurrentPage] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);

  const [speed, setSpeed] = useState(1.0);
  // 👇 SỬA: trước đây voice/style luôn hardcode về mặc định mỗi lần F5, trong khi
  // cache key lại phụ thuộc ĐÚNG giọng+phong cách đã dùng để tạo audio. Nếu trước đó
  // bạn chọn giọng khác mặc định, F5 xong sẽ quay về mặc định -> cache key không khớp
  // -> tưởng "mất" audio dù dữ liệu vẫn còn nguyên trong IndexedDB. Giờ nhớ lựa chọn
  // gần nhất qua localStorage để F5 xong vẫn khớp cache như cũ.
  const [voice, setVoiceState] = useState<string>(
    () => localStorage.getItem(LAST_VOICE_KEY) || "Trúc Ly",
  );
  const setVoice = useCallback((v: string) => {
    setVoiceState(v);
    try {
      localStorage.setItem(LAST_VOICE_KEY, v);
    } catch {
      // localStorage có thể bị chặn (chế độ ẩn danh nghiêm ngặt) — bỏ qua, không ảnh hưởng chức năng chính
    }
  }, []);
  const [voices, setVoices] = useState<Voice[]>([]);

  const [pages, setPages] = useState<PageState[]>([]);
  const [allPages, setAllPages] = useState<PageState[]>([]);
  const [loadedBatch, setLoadedBatch] = useState(0);
  const [totalPages, setTotalPages] = useState(0);

  const [style, setStyleState] = useState<string>(
    () => localStorage.getItem(LAST_STYLE_KEY) || "tu_nhien",
  );
  const setStyle = useCallback((s: string) => {
    setStyleState(s);
    try {
      localStorage.setItem(LAST_STYLE_KEY, s);
    } catch {
      // ignore
    }
  }, []);
  const [generationPaceMs, setGenerationPaceMs] = useState(DEFAULT_GENERATION_PACE_MS);
  const [storageEstimate, setStorageEstimate] = useState<StorageEstimate | null>(null);
  const [batchJob, setBatchJob] = useState<BatchJobUIState | null>(null);
  const [resumableJob, setResumableJob] = useState<BatchJobRecord | null>(null);
  const batchJobCancelRef = useRef(false);
  const docTitleRef = useRef<string>("");
  const { showToast } = useToast();

  // Đọc lại dung lượng IndexedDB đang dùng / mức trình duyệt cho phép.
  // Gọi mỗi khi ghi/xoá audio — không polling định kỳ để tránh gọi thừa.
  const refreshStorageEstimate = useCallback(() => {
    getStorageEstimate()
      .then((est) => {
        if (isMountedRef.current) setStorageEstimate(est);
      })
      .catch(() => {});
  }, []);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isMountedRef = useRef(true);
  const fetchingRef = useRef<Set<number>>(new Set());
  const generationAbortRef = useRef<AbortController | null>(null);
  const generationTotalRef = useRef(DEFAULT_PAGES_PER_GENERATE);
  // Thời điểm truy cập gần nhất của mỗi trang (LRU) — quyết định trang nào bị
  // giải phóng blob URL trước khi RESIDENT_AUDIO_CAP bị vượt quá.
  const audioAccessRef = useRef<Map<number, number>>(new Map());
  const touchAudioAccess = useCallback((pageNum: number) => {
    audioAccessRef.current.set(pageNum, Date.now());
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    audioRef.current = new Audio();
    return () => {
      isMountedRef.current = false;
      audioRef.current?.pause();
      audioRef.current = null;
      generationAbortRef.current?.abort();
      generationAbortRef.current = null;
    };
  }, []);

  useEffect(() => {
    fetch(`${API_URL}/voices`)
      .then((r) => r.json())
      .then((data: Voice[]) => {
        setVoices(data);
        if (data.length > 0 && !data.find((v) => v.id === voice)) {
          setVoice(data[0].id);
        }
      })
      .catch(console.error);
  }, []);

  // 👇 BUG FIX #2: clearOldCache/requestStorageQuota tồn tại sẵn trong indexedDB.ts
  // nhưng chưa từng được gọi ở đâu -> cache phình to vô hạn, trình duyệt có thể
  // xoá dữ liệu bất cứ lúc nào vì không xin persistent storage.
  useEffect(() => {
    clearOldCache(7).catch((err) => console.warn("Không thể dọn cache cũ:", err));
    requestStorageQuota().catch((err) => console.warn("Không thể xin persistent storage:", err));
    refreshStorageEstimate();
  }, [refreshStorageEstimate]);

  const addClonedVoice = useCallback((voiceId: string, name: string) => {
    setClonedVoices(prev => {
      if (prev.find(v => v.id === voiceId)) return prev;
      return [...prev, { id: voiceId, name: `🎙️ ${name}`, type: 'cloned' }];
    });
    setVoice(voiceId);
  }, []);

  const getPageCacheKey = useCallback(
    (page: PageState) => buildCacheKey(voice, style, page.pageNum, `${AUDIO_PIPELINE_VERSION}::${page.text}`),
    [voice, style],
  );

  // 👇 Thử phục hồi audio đã tạo trước đó từ IndexedDB cho một batch trang,
  // dựa trên cache key ổn định (voice + style + số trang + nội dung).
  // Đây là phần chính giải quyết BUG #1 (F5 là mất sạch audio đã tạo).
  const hydrateBatchFromCache = useCallback(
    async (batch: PageState[]): Promise<PageState[]> => {
      return Promise.all(
        batch.map(async (p) => {
          try {
            const key = getPageCacheKey(p);
            const cached = await getCachedAudio(key);
            if (cached) {
              const url = URL.createObjectURL(cached.blob);
              touchAudioAccess(p.pageNum);
              return {
                ...p,
                audioUrl: url,
                isGenerated: true,
                voiceUsed: voice,
              };
            }
          } catch (err) {
            console.warn(`Không đọc được cache cho trang ${p.pageNum}:`, err);
          }
          return p;
        }),
      );
    },
    [voice, style, getPageCacheKey, touchAudioAccess],
  );

  const fetchTTSWithRetry = useCallback(
    async (text: string): Promise<Blob> => {
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const controller = generationAbortRef.current;
        if (!controller || controller.signal.aborted) {
          throw new DOMException("Generation cancelled", "AbortError");
        }

        try {
          const newlineCount = (text.match(/\n/g) || []).length;
          const paragraphBreakCount = (text.match(/\n\n+/g) || []).length;
          const singleBreakCount = (text.match(/\n/g) || []).length - paragraphBreakCount;

          console.debug("[TTS final payload]", {
            newlineCount,
            singleBreakCount,
            paragraphBreakCount,
            textLength: text.length,
            preview: text.slice(0, 220),
          });

          const res = await fetch(`${API_URL}/tts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, voice: voice || undefined, style }),
            signal: controller.signal,
          });
          if (!res.ok) {
            const err = await res
              .json()
              .catch(() => ({ error: `HTTP ${res.status}` }));
            throw new Error(err.error || `HTTP ${res.status}`);
          }
          return res.blob();
        } catch (err) {
          if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
            throw err;
          }
          console.warn(`TTS attempt ${attempt} failed:`, err);
          if (attempt === MAX_RETRIES) throw err;
          await new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(resolve, 1000);
            const onAbort = () => {
              window.clearTimeout(timer);
              controller.signal.removeEventListener("abort", onAbort);
              reject(new DOMException("Generation cancelled", "AbortError"));
            };
            controller.signal.addEventListener("abort", onAbort, { once: true });
          });
        }
      }
      throw new Error("All retries failed");
    },
    [voice, style],
  );

  const updatePageState = useCallback((pageNum: number, updater: (p: PageState) => PageState) => {
    setPages((prev) => prev.map((p) => p.pageNum === pageNum ? updater(p) : p));
    setAllPages((prev) => prev.map((p) => p.pageNum === pageNum ? updater(p) : p));
  }, []);

  // Tạo audio cho 1 trang.
  // forceRegenerate=true (dùng khi bấm "Tạo lại") sẽ bỏ qua cache và luôn gọi API mới.
  const generatePageAudio = useCallback(
    async (page: PageState, progressIdx: number, forceRegenerate: boolean = false): Promise<string | null> => {
      if (fetchingRef.current.has(page.pageNum)) {
        while (fetchingRef.current.has(page.pageNum)) {
          await new Promise((r) => setTimeout(r, 100));
        }
        const updated = pages.find((p) => p.pageNum === page.pageNum);
        return updated?.audioUrl || null;
      }

      fetchingRef.current.add(page.pageNum);

      setGenProgress({
        current: progressIdx + 1,
        total: generationTotalRef.current,
        pageNum: page.pageNum,
        status: "generating",
      });

      updatePageState(page.pageNum, (p) => ({
        ...p,
        isLoading: true,
        generationError: undefined,
        voiceUsed: `${voice} • ${VALID_STYLES.find(s => s.id === style)?.name || style}`,
      }));

      const cacheKey = getPageCacheKey(page);

      try {
        // 👇 BUG FIX #1: kiểm tra cache trước khi gọi API tốn kém, trừ khi
        // người dùng chủ động bấm "Tạo lại" (forceRegenerate).
        if (!forceRegenerate) {
          const cached = await getCachedAudio(cacheKey);
          if (cached) {
            const url = URL.createObjectURL(cached.blob);
            touchAudioAccess(page.pageNum);
            updatePageState(page.pageNum, (p) => ({
              ...p, audioUrl: url, isLoading: false, isGenerated: true, voiceUsed: voice,
            }));
            setGenProgress({
              current: progressIdx + 1,
              total: generationTotalRef.current,
              pageNum: page.pageNum,
              status: "success",
            });
            return url;
          }
        }

        const textChunks = chunkText(page.text, MAX_TEXT_PER_REQUEST);
        const audioBlobs: Blob[] = [];
        const pausesAfterMs: number[] = [];

        for (const chunk of textChunks) {
          const blob = await fetchTTSWithRetry(chunk.text);
          audioBlobs.push(blob);
          pausesAfterMs.push(chunk.pauseAfterMs);
        }

        const mergedBlob =
          audioBlobs.length === 1
            ? audioBlobs[0]
            : await mergeAudioBlobs(audioBlobs, pausesAfterMs);
        const url = URL.createObjectURL(mergedBlob);

        await cacheAudio(cacheKey, mergedBlob, {
          pageNum: page.pageNum,
          voice,
          style,
        });
        touchAudioAccess(page.pageNum);
        refreshStorageEstimate();

        setPages((prev) => {
          const oldPage = prev.find((p) => p.pageNum === page.pageNum);
          if (oldPage?.audioUrl) {
            URL.revokeObjectURL(oldPage.audioUrl);
          }

          const newPages = prev.map((p) =>
            p.pageNum === page.pageNum
              ? {
                ...p,
                audioUrl: url,
                isLoading: false,
                isGenerated: true,
                // Chỉ tăng khi thực sự là một lần TẠO LẠI, không tăng ở lần tạo đầu tiên.
                retryCount: forceRegenerate ? (p.retryCount || 0) + 1 : (p.retryCount || 0),
                voiceUsed: voice,
              }
              : p,
          );

          // 👇 GIẢI PHÓNG RAM THEO LRU — KHÔNG đụng tới isGenerated.
          // Trang bị evict vẫn còn nguyên dữ liệu trong IndexedDB (cacheAudio ở trên),
          // nên vẫn coi là "đã tạo" đúng nghĩa — chỉ audioUrl (blob URL đang sống
          // trong RAM) bị giải phóng, và sẽ được tự động tải lại khi cần play/export
          // (xem playPage + exportAudio). Điều này giữ RAM ổn định bất kể sách dài
          // bao nhiêu trang, thay vì trước đây RAM tăng vô hạn khi tạo audio hàng loạt
          // mà không phát (điều kiện evict cũ yêu cầu "đã nghe" mới được dọn).
          const resident = newPages.filter((p) => p.audioUrl);
          if (resident.length > RESIDENT_AUDIO_CAP) {
            const evictable = resident
              .filter((p) => p.pageNum !== page.pageNum)
              .sort(
                (a, b) =>
                  (audioAccessRef.current.get(a.pageNum) || 0) -
                  (audioAccessRef.current.get(b.pageNum) || 0),
              );
            const toEvict = evictable.slice(0, resident.length - RESIDENT_AUDIO_CAP);
            toEvict.forEach((p) => {
              URL.revokeObjectURL(p.audioUrl!);
              audioAccessRef.current.delete(p.pageNum);
              const idx = newPages.findIndex((np) => np.pageNum === p.pageNum);
              if (idx !== -1) newPages[idx] = { ...newPages[idx], audioUrl: null };
            });
          }
          return newPages;
        });
        setAllPages((prev) =>
          prev.map((p) => p.pageNum === page.pageNum
            ? { ...p, audioUrl: url, isLoading: false, isGenerated: true, generationError: undefined, voiceUsed: voice, retryCount: forceRegenerate ? (p.retryCount || 0) + 1 : (p.retryCount || 0) }
            : p,
          ),
        );

        setGenProgress({
          current: progressIdx + 1,
          total: generationTotalRef.current,
          pageNum: page.pageNum,
          status: "success",
        });

        return url;
      } catch (err: any) {
        const cancelled =
          generationAbortRef.current?.signal.aborted ||
          (err instanceof DOMException && err.name === "AbortError");

        if (cancelled) {
          setPages((prev) =>
            prev.map((p) =>
              p.pageNum === page.pageNum
                ? { ...p, isLoading: false, generationError: undefined }
                : p,
            ),
          );
          setAllPages((prev) => prev.map((p) => p.pageNum === page.pageNum ? { ...p, isLoading: false, generationError: undefined } : p));
          return null;
        }

        console.error(`Generate audio failed for page ${page.pageNum}:`, err);

        setPages((prev) =>
          prev.map((p) =>
            p.pageNum === page.pageNum
              ? {
                ...p,
                isLoading: false,
                generationError: err.message || "Lỗi tạo audio",
                retryCount: (p.retryCount || 0) + 1,
              }
              : p,
          ),
        );
        setAllPages((prev) => prev.map((p) => p.pageNum === page.pageNum
          ? { ...p, isLoading: false, generationError: err.message || "Lỗi tạo audio", retryCount: (p.retryCount || 0) + 1 }
          : p,
        ));

        setGenProgress({
          current: progressIdx + 1,
          total: generationTotalRef.current,
          pageNum: page.pageNum,
          status: "error",
          errorPage: page.pageNum,
        });

        showToast(`Trang ${page.pageNum}: ${err.message || "Lỗi tạo audio"}`, "error");
        return null;
      } finally {
        fetchingRef.current.delete(page.pageNum);
      }
    },
    [voice, style, pages, fetchTTSWithRetry, showToast, getPageCacheKey, touchAudioAccess, updatePageState, refreshStorageEstimate],
  );

  // Retry/Regenerate 1 trang — luôn bỏ qua cache, ép gọi API mới.
  const retryPageAudio = useCallback(
    async (pageNum: number): Promise<boolean> => {
      const page = pages.find((p) => p.pageNum === pageNum);
      if (!page) return false;
      if (page.isLoading) return false;

      setPages((prev) =>
        prev.map((p) =>
          p.pageNum === pageNum
            ? { ...p, generationError: undefined, isLoading: false }
            : p,
        ),
      );

      generationAbortRef.current?.abort();
      generationAbortRef.current = new AbortController();
      setIsGenerating(true);
      try {
        const result = await generatePageAudio(page, 0, true);
        return result !== null;
      } finally {
        generationAbortRef.current = null;
        setIsGenerating(false);
      }

    },
    [pages, generatePageAudio],
  );

  // Xoá TOÀN BỘ audio đã cache trong IndexedDB — kể cả audio của những file
  // KHÁC từng mở trước đây (không chỉ file đang mở hiện tại). Đây là nút
  // "giải phóng bộ nhớ trình duyệt" tổng — dùng khi thanh dung lượng báo gần đầy.
  const deleteAllAudio = useCallback(async (): Promise<void> => {
    try {
      await clearAllCachedAudio();
    } catch (err) {
      console.warn("Không xoá được toàn bộ cache:", err);
      showToast("Không thể xoá cache — xem console để biết chi tiết.", "error");
      return;
    }

    audioAccessRef.current.clear();

    const resetPage = (p: PageState): PageState => {
      if (p.audioUrl) URL.revokeObjectURL(p.audioUrl);
      return {
        ...p,
        audioUrl: null,
        isGenerated: false,
        generationError: undefined,
        voiceUsed: undefined,
        retryCount: 0,
      };
    };
    // Chỉ tài liệu ĐANG MỞ mới còn trong state để reset UI; audio của các file
    // khác đã xoá thẳng dưới IndexedDB rồi (không có state nào để reset thêm).
    setPages((prev) => prev.map(resetPage));
    setAllPages((prev) => prev.map(resetPage));

    showToast("Đã xoá toàn bộ audio đã lưu trong trình duyệt.", "success");
    refreshStorageEstimate();
  }, [showToast, refreshStorageEstimate]);

  // Xoá audio đã tạo của 1 trang: xoá khỏi IndexedDB (vĩnh viễn, phải tạo lại từ đầu
  // nếu muốn có audio lại), giải phóng blob URL đang giữ RAM (nếu có), reset trạng thái trang.
  const deletePageAudio = useCallback(
    async (pageNum: number): Promise<void> => {
      const page = allPages.find((p) => p.pageNum === pageNum);
      if (!page) return;

      try {
        await deleteCachedAudio(getPageCacheKey(page));
      } catch (err) {
        console.warn(`Không xoá được cache cho trang ${pageNum}:`, err);
      }

      audioAccessRef.current.delete(pageNum);

      const resetPage = (p: PageState): PageState => {
        if (p.audioUrl) URL.revokeObjectURL(p.audioUrl);
        return {
          ...p,
          audioUrl: null,
          isGenerated: false,
          generationError: undefined,
          voiceUsed: undefined,
          retryCount: 0,
        };
      };
      setPages((prev) => prev.map((p) => (p.pageNum === pageNum ? resetPage(p) : p)));
      setAllPages((prev) => prev.map((p) => (p.pageNum === pageNum ? resetPage(p) : p)));

      showToast(`Đã xoá audio trang ${pageNum}.`, "info");
      refreshStorageEstimate();
    },
    [allPages, getPageCacheKey, showToast, refreshStorageEstimate],
  );

  // Xoá audio đã tạo của MỘT KHOẢNG trang (dùng nội bộ bởi tác vụ tạo audio
  // hàng loạt: sau khi export xong 1 lô ra file, xoá cache của lô đó để giải
  // phóng bộ nhớ trình duyệt trước khi làm lô tiếp theo).
  const deletePageRangeAudio = useCallback(
    async (startPage: number, endPage: number, opts?: { silent?: boolean }): Promise<void> => {
      const rangePages = allPages.filter((p) => p.pageNum >= startPage && p.pageNum <= endPage);

      for (const page of rangePages) {
        try {
          await deleteCachedAudio(getPageCacheKey(page));
        } catch (err) {
          console.warn(`Không xoá được cache trang ${page.pageNum}:`, err);
        }
        audioAccessRef.current.delete(page.pageNum);
      }

      const resetPage = (p: PageState): PageState => {
        if (p.pageNum < startPage || p.pageNum > endPage) return p;
        if (p.audioUrl) URL.revokeObjectURL(p.audioUrl);
        return {
          ...p,
          audioUrl: null,
          isGenerated: false,
          generationError: undefined,
          voiceUsed: undefined,
          retryCount: 0,
        };
      };
      setPages((prev) => prev.map(resetPage));
      setAllPages((prev) => prev.map(resetPage));

      if (!opts?.silent) {
        showToast(`Đã xoá audio trang ${startPage}-${endPage}.`, "info");
      }
      refreshStorageEstimate();
    },
    [allPages, getPageCacheKey, showToast, refreshStorageEstimate],
  );

  // Tạo audio bắt đầu từ một trang bất kỳ, tối đa 10 trang/lần.
  // Các trang đã có audio sẽ được bỏ qua; nếu cuối sách còn ít hơn số lượng yêu cầu
  // thì chỉ tạo phần còn lại rồi tự dừng.
  const generateFromPage = useCallback(async (startPage: number, requestedCount: number) => {
    const safeStart = Math.max(1, Math.floor(startPage));
    const safeCount = Math.min(MAX_PAGES_PER_GENERATE, Math.max(1, Math.floor(requestedCount)));
    if (safeStart > totalPages) return;

    generationAbortRef.current?.abort();
    const controller = new AbortController();
    generationAbortRef.current = controller;
    generationTotalRef.current = safeCount;
    setIsGenerating(true);
    setGenProgress({ current: 0, total: safeCount, pageNum: safeStart, status: "idle" });
    const startedAt = Date.now();

    try {
      // Quét từ trang bắt đầu. Với mỗi trang, kiểm tra IndexedDB nếu state hiện tại
      // chưa biết nó đã có audio. Không tạo Blob URL cho cả vùng quét để tránh ngốn RAM.
      const candidates = allPages
        .filter((p) => p.pageNum >= safeStart)
        .sort((a, b) => a.pageNum - b.pageNum);
      const targets: PageState[] = [];

      for (const candidate of candidates) {
        if (targets.length >= safeCount) break;
        if (candidate.isGenerated || candidate.isLoading) continue;

        const cached = await getCachedAudio(getPageCacheKey(candidate));
        if (cached) {
          setAllPages((prev) => prev.map((p) => p.pageNum === candidate.pageNum
            ? { ...p, isGenerated: true, generationError: undefined }
            : p,
          ));
          setPages((prev) => prev.map((p) => p.pageNum === candidate.pageNum
            ? { ...p, isGenerated: true, generationError: undefined }
            : p,
          ));
          continue;
        }

        targets.push(candidate);
      }

      if (targets.length === 0) {
        showToast(`Không còn trang chưa tạo audio từ trang ${safeStart}.`, "info");
        return;
      }

      generationTotalRef.current = targets.length;
      setGenProgress({ current: 0, total: targets.length, pageNum: targets[0].pageNum, status: "idle" });

      let generatedCount = 0;
      for (let i = 0; i < targets.length; i++) {
        if (controller.signal.aborted) break;
        const result = await generatePageAudio(targets[i], i);
        if (result === null || controller.signal.aborted) break;
        generatedCount++;

        if (generationPaceMs > 0 && i < targets.length - 1) {
          await new Promise<void>((resolve) => {
            const timer = window.setTimeout(resolve, generationPaceMs);
            const onAbort = () => {
              window.clearTimeout(timer);
              resolve();
            };
            controller.signal.addEventListener("abort", onAbort, { once: true });
          });
        }
      }
      if (generatedCount > 0) {
        const elapsedMs = Date.now() - startedAt;
        showToast(
          `✅ Đã tạo xong ${generatedCount} trang audio (bắt đầu từ trang ${targets[0].pageNum}) ` +
          `trong ${formatDuration(elapsedMs)}.`,
          "success",
        );
      }
    } finally {
      if (generationAbortRef.current === controller) generationAbortRef.current = null;
      setIsGenerating(false);
      setGenProgress((prev) => ({ ...prev, status: "idle" }));
    }
  }, [allPages, totalPages, generatePageAudio, generationPaceMs, showToast, getPageCacheKey]);

  // Giữ API cũ để không phá các chỗ gọi khác.
  const generateNextBatch = useCallback(async () => {
    const firstUngenerated = allPages.find((p) => !p.isGenerated && !p.isLoading);
    if (!firstUngenerated) return;
    await generateFromPage(firstUngenerated.pageNum, DEFAULT_PAGES_PER_GENERATE);
  }, [allPages, generateFromPage]);

  const playPage = useCallback(
    async (pageIdx: number) => {
      if (pageIdx >= pages.length) {
        setIsPlaying(false);
        return;
      }
      let page = pages[pageIdx];

      // 👇 Trang đã tạo trước đó nhưng blob URL đã bị giải phóng khỏi RAM (LRU) —
      // tải lại từ IndexedDB. Rất nhanh (đọc local), không gọi API/không tốn GPU.
      if (page.isGenerated && !page.audioUrl) {
        const cached = await getCachedAudio(getPageCacheKey(page));
        if (cached) {
          const url = URL.createObjectURL(cached.blob);
          setPages((prev) =>
            prev.map((p) => (p.pageNum === page.pageNum ? { ...p, audioUrl: url } : p)),
          );
          page = { ...page, audioUrl: url };
        }
      }

      if (!page.audioUrl || !page.isGenerated) {
        const errorMsg = page.generationError
          ? `Trang ${page.pageNum} bị lỗi: ${page.generationError}`
          : `Trang ${page.pageNum} chưa có audio. Nhấn 'Tạo audio' trước.`;
        showToast(errorMsg, "warning");
        return;
      }

      touchAudioAccess(page.pageNum);
      setCurrentPage(pageIdx);
      setIsPaused(false); // bắt đầu phát mới (không phải resume) thì không còn ở trạng thái "tạm dừng"
      const textChunks = chunkTextStrings(page.text, HIGHLIGHT_CHUNK_SIZE);
      const audio = audioRef.current;
      if (!audio || !isMountedRef.current) return;

      audio.src = page.audioUrl;
      audio.playbackRate = speed;

      audio.onended = () => {
        if (!isMountedRef.current) return;
        setPages((prev) =>
          prev.map((p, i) => (i === pageIdx ? { ...p, isPlayed: true } : p)),
        );
        playPage(pageIdx + 1);
      };

      audio.onerror = () => {
        console.error("Audio playback error");
        setIsPlaying(false);
      };

      audio.ontimeupdate = () => {
        if (!audio.duration) return;
        const progress = audio.currentTime / audio.duration;
        const chunkIdx = Math.floor(progress * textChunks.length);
        setCurrentIndex(Math.min(chunkIdx, textChunks.length - 1));
      };

      await audio.play();
      setIsPlaying(true);
    },
    [pages, speed, showToast, getPageCacheKey, touchAudioAccess],
  );

  const play = useCallback(
    (startPage: number = 0) => playPage(startPage),
    [playPage],
  );
  const pause = useCallback(() => {
    audioRef.current?.pause();
    setIsPlaying(false);
    setIsPaused(true); // 👈 BUG FIX #3: đánh dấu đang tạm dừng (khác với đã dừng hẳn)
  }, []);
  const resume = useCallback(() => {
    audioRef.current
      ?.play()
      .then(() => {
        setIsPlaying(true);
        setIsPaused(false);
      })
      .catch(console.error);
  }, []);

  const stop = useCallback(() => {
    const wasGenerating = generationAbortRef.current !== null;
    generationAbortRef.current?.abort();
    generationAbortRef.current = null;
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.currentTime = 0;
    setIsPlaying(false);
    setIsPaused(false);
    setIsGenerating(false);
    setCurrentPage(0);
    setCurrentIndex(0);
    setGenProgress({
      current: 0,
      total: DEFAULT_PAGES_PER_GENERATE,
      pageNum: 0,
      status: "idle",
    });
    if (wasGenerating) showToast("Đã hủy quá trình tạo audio.", "info");
  }, [showToast]);

  const seekToPage = useCallback(
    (pageIdx: number) => {
      audioRef.current?.pause();
      playPage(pageIdx);
    },
    [playPage],
  );

  const loadBatch = useCallback(
    (batchNum: number) => {
      const start = batchNum * PAGES_PER_BATCH;
      const end = Math.min(start + PAGES_PER_BATCH, allPages.length);
      const batch = allPages.slice(start, end);
      if (batch.length === 0) return;
      setPages((prev) => {
        const existing = new Set(prev.map((p) => p.pageNum));
        return [...prev, ...batch.filter((p) => !existing.has(p.pageNum))];
      });
      setLoadedBatch(batchNum);

      // Thử phục hồi audio đã cache cho batch này (BUG FIX #1)
      hydrateBatchFromCache(batch).then((hydrated) => {
        if (!hydrated.some((p) => p.isGenerated)) return;
        setPages((prev) =>
          prev.map((p) => hydrated.find((h) => h.pageNum === p.pageNum) ?? p),
        );
      });
    },
    [allPages, hydrateBatchFromCache],
  );

  // Jump tới một trang bất kỳ và đảm bảo batch chứa trang đó đã được render.
  // Không dùng cho generate trực tiếp: đây chỉ là thao tác điều hướng UI.
  const jumpToPage = useCallback(
    async (pageNum: number): Promise<number | null> => {
      const target = Math.max(1, Math.min(totalPages, Math.floor(pageNum)));
      if (target < 1 || target > totalPages) return null;

      const targetBatch = Math.floor((target - 1) / PAGES_PER_BATCH);
      const neededPages = allPages.slice(0, Math.min((targetBatch + 1) * PAGES_PER_BATCH, allPages.length));

      setPages((prev) => {
        const existing = new Set(prev.map((p) => p.pageNum));
        return [...prev, ...neededPages.filter((p) => !existing.has(p.pageNum))];
      });
      setLoadedBatch(targetBatch);

      // Hydrate audio của toàn bộ phần vừa đưa vào UI, nhưng chỉ tạo URL cho
      // những audio thực sự tồn tại trong IndexedDB.
      const newlyNeeded = neededPages.filter((p) => !pages.some((existing) => existing.pageNum === p.pageNum));
      if (newlyNeeded.length > 0) {
        const hydrated = await hydrateBatchFromCache(newlyNeeded);
        if (hydrated.some((p) => p.isGenerated)) {
          setPages((prev) =>
            prev.map((p) => hydrated.find((h) => h.pageNum === p.pageNum) ?? p),
          );
        }
      }

      return target - 1;
    },
    [allPages, totalPages, pages, hydrateBatchFromCache],
  );

  // Lấy đúng khoảng trang yêu cầu và đọc trạng thái audio trực tiếp từ IndexedDB.
  // Không phụ thuộc vào pages đang được render hay audioUrl còn nằm trong RAM.
  const getExportablePageRefs = useCallback(async (startPage: number, endPage: number): Promise<{ pageNum: number; cacheKey: string; page: PageState }[]> => {
    const start = Math.max(1, Math.floor(startPage));
    const end = Math.min(totalPages, Math.floor(endPage));
    if (start > end) return [];

    const candidates = allPages
      .filter((p) => p.pageNum >= start && p.pageNum <= end)
      .sort((a, b) => a.pageNum - b.pageNum);

    const refs: { pageNum: number; cacheKey: string; page: PageState }[] = [];
    for (const page of candidates) {
      const cached = await getCachedAudio(getPageCacheKey(page));
      if (!cached) {
        showToast(`Trang ${page.pageNum} chưa có audio. Vui lòng tạo đủ trang ${start}-${end} trước khi export.`, "warning");
        return [];
      }
      refs.push({ pageNum: page.pageNum, cacheKey: getPageCacheKey(page), page });
    }
    return refs;
  }, [allPages, totalPages, getPageCacheKey, showToast]);

  const exportAudio = useCallback(async (startPage: number, endPage: number): Promise<Blob | null> => {
    const refs = await getExportablePageRefs(startPage, endPage);
    if (refs.length === 0) {
      showToast("Không có audio liên tục trong khoảng trang đã chọn.", "warning");
      return null;
    }
    const blobs: Blob[] = [];
    for (const ref of refs) {
      const cached = await getCachedAudio(ref.cacheKey);
      if (cached) blobs.push(cached.blob);
    }
    if (blobs.length === 0) return null;
    if (blobs.length === 1) return blobs[0];
    const { mergeWavBlobs } = await import("../utils/audioExport");
    return mergeWavBlobs(blobs);
  }, [getExportablePageRefs, showToast]);

  const exportAudioStreaming = useCallback(async (startPage: number, endPage: number, suggestedName: string, onProgress?: (done: number, total: number) => void): Promise<boolean> => {
    const refs = await getExportablePageRefs(startPage, endPage);
    if (refs.length === 0) return false;
    const { exportBookStreaming } = await import("../utils/streamingExport");
    await exportBookStreaming(refs, suggestedName, onProgress);
    return true;
  }, [getExportablePageRefs]);

  const exportAudioChunked = useCallback(async (startPage: number, endPage: number, baseName: string, chunkSize: number = 20, onProgress?: (done: number, total: number) => void): Promise<number> => {
    const refs = await getExportablePageRefs(startPage, endPage);
    if (refs.length === 0) return 0;
    const { exportBookInChunks } = await import("../utils/streamingExport");
    const { fileCount } = await exportBookInChunks(refs, baseName, chunkSize, onProgress);
    return fileCount;
  }, [getExportablePageRefs]);

  // ============================================================
  // TÁC VỤ TẠO AUDIO HÀNG LOẠT TỰ ĐỘNG (vượt giới hạn 10 trang/lần thủ công)
  // ============================================================
  //
  // Xử lý theo từng lô BATCH_JOB_CHUNK_SIZE trang: tạo audio -> export lô đó
  // thành 1 file (ghi thẳng vào thư mục đã chọn, hoặc tải về nếu trình duyệt
  // không hỗ trợ chọn thư mục) -> xoá cache của lô đó để giải phóng bộ nhớ ->
  // sang lô tiếp theo. Tiến trình được lưu vào IndexedDB sau MỖI LÔ, nên nếu
  // tab bị đóng/tắt máy/F5 giữa chừng, lần mở tài liệu này (đúng file) sau đó
  // sẽ phát hiện và gợi ý tiếp tục đúng từ lô còn dang dở.

  const runBatchJob = useCallback(
    async (job: BatchJobRecord, dirHandle: FileSystemDirectoryHandle | null) => {
      batchJobCancelRef.current = false;
      // 👇 FIX: fetchTTSWithRetry bắt buộc generationAbortRef.current phải là 1
      // AbortController hợp lệ chưa bị abort (xem dòng ~299), nếu không sẽ coi
      // như đã bị hủy và ném lỗi ngay lập tức — batch job trước đây không khởi
      // tạo controller này nên MỌI request TTS trong batch đều bị coi là "đã hủy",
      // dẫn tới lỗi giả "Lỗi tạo audio trong khoảng trang X-Y" dù backend hoàn toàn ổn.
      generationAbortRef.current?.abort();
      const controller = new AbortController();
      generationAbortRef.current = controller;
      setIsGenerating(true); // tái dùng khoá UI sẵn có (isLocked) để tránh đổi giọng/phong cách giữa chừng job
      setBatchJob({
        status: "running",
        startPage: job.startPage,
        endPage: job.endPage,
        nextPage: job.nextPage,
        chunkSize: job.chunkSize,
        useFallbackDownload: job.useFallbackDownload,
      });

      try {
        let cursor = job.nextPage;

        while (cursor <= job.endPage) {
          if (batchJobCancelRef.current) {
            await saveBatchJob({ ...job, nextPage: cursor, status: "paused", updatedAt: Date.now(), dirHandle: dirHandle || undefined });
            setBatchJob((s) => (s ? { ...s, status: "paused", nextPage: cursor } : s));
            showToast(`⏸️ Đã tạm dừng tác vụ tại trang ${cursor}. Có thể tiếp tục bất cứ lúc nào.`, "info");
            return;
          }

          const chunkEnd = Math.min(cursor + job.chunkSize - 1, job.endPage);
          setBatchJob((s) => (s ? { ...s, nextPage: cursor } : s));

          // Bước 1: tạo audio cho các trang trong lô (bỏ qua trang đã có sẵn nhờ
          // cache-check có sẵn trong generatePageAudio, nên an toàn khi resume).
          const chunkPages = allPages
            .filter((p) => p.pageNum >= cursor && p.pageNum <= chunkEnd)
            .sort((a, b) => a.pageNum - b.pageNum);

          let chunkOk = true;
          for (let i = 0; i < chunkPages.length; i++) {
            if (batchJobCancelRef.current) { chunkOk = false; break; }
            const result = await generatePageAudio(chunkPages[i], i);
            if (result === null) { chunkOk = false; break; }
            if (generationPaceMs > 0 && i < chunkPages.length - 1) {
              await new Promise<void>((resolve) => setTimeout(resolve, generationPaceMs));
            }
          }

          if (batchJobCancelRef.current) {
            await saveBatchJob({ ...job, nextPage: cursor, status: "paused", updatedAt: Date.now(), dirHandle: dirHandle || undefined });
            setBatchJob((s) => (s ? { ...s, status: "paused", nextPage: cursor } : s));
            showToast(`⏸️ Đã tạm dừng tác vụ tại trang ${cursor}.`, "info");
            return;
          }

          if (!chunkOk) {
            const errorMessage = `Lỗi tạo audio trong khoảng trang ${cursor}-${chunkEnd}.`;
            await saveBatchJob({ ...job, nextPage: cursor, status: "error", errorMessage, updatedAt: Date.now(), dirHandle: dirHandle || undefined });
            setBatchJob((s) => (s ? { ...s, status: "error", errorMessage, nextPage: cursor } : s));
            showToast(`❌ Tác vụ dừng: ${errorMessage} Có thể tiếp tục sau khi khắc phục.`, "error");
            return;
          }

          // Bước 2: export lô này thành 1 file audio.
          const blob = await exportAudio(cursor, chunkEnd);
          if (!blob) {
            const errorMessage = `Không export được khoảng trang ${cursor}-${chunkEnd}.`;
            await saveBatchJob({ ...job, nextPage: cursor, status: "error", errorMessage, updatedAt: Date.now(), dirHandle: dirHandle || undefined });
            setBatchJob((s) => (s ? { ...s, status: "error", errorMessage, nextPage: cursor } : s));
            showToast(`❌ Tác vụ dừng: ${errorMessage}`, "error");
            return;
          }

          const filename = `${sanitizeFilename(job.title)}_p${cursor}-${chunkEnd}.wav`;
          try {
            if (dirHandle) {
              await writeChunkToDirectory(dirHandle, filename, blob);
            } else {
              const { downloadBlob } = await import("../utils/audioExport");
              downloadBlob(blob, filename);
            }
          } catch (err: any) {
            const errorMessage = `Không ghi được file "${filename}": ${err?.message || err}`;
            await saveBatchJob({ ...job, nextPage: cursor, status: "error", errorMessage, updatedAt: Date.now(), dirHandle: dirHandle || undefined });
            setBatchJob((s) => (s ? { ...s, status: "error", errorMessage, nextPage: cursor } : s));
            showToast(`❌ Tác vụ dừng: ${errorMessage}`, "error");
            return;
          }

          // Bước 3: xoá cache của lô này để giải phóng bộ nhớ trình duyệt.
          await deletePageRangeAudio(cursor, chunkEnd, { silent: true });

          // Bước 4: cập nhật con trỏ tiếp tục + lưu tiến trình (để resume đúng chỗ nếu bị gián đoạn).
          cursor = chunkEnd + 1;
          await saveBatchJob({ ...job, nextPage: cursor, status: "running", updatedAt: Date.now(), dirHandle: dirHandle || undefined });
          setBatchJob((s) => (s ? { ...s, nextPage: cursor } : s));
        }

        await deleteBatchJob(job.documentId).catch(() => {});
        setBatchJob((s) => (s ? { ...s, status: "completed", nextPage: job.endPage + 1 } : s));
        setResumableJob(null);
        showToast(`🎉 Đã hoàn tất tạo & export audio trang ${job.startPage}-${job.endPage} (${job.useFallbackDownload ? "đã tải về Downloads" : "đã lưu vào thư mục đã chọn"}).`, "success");
      } finally {
        if (generationAbortRef.current === controller) generationAbortRef.current = null;
        setIsGenerating(false);
      }
    },
    [allPages, generatePageAudio, generationPaceMs, exportAudio, deletePageRangeAudio, showToast],
  );

  /** Bắt đầu tác vụ mới: tạo + export + dọn cache tự động cho khoảng trang [startPage, endPage]. */
  const startBatchExportJob = useCallback(
    async (startPage: number, endPage: number) => {
      const start = Math.max(1, Math.floor(startPage));
      const end = Math.min(totalPages, Math.floor(endPage));
      if (start > end) {
        showToast("Trang bắt đầu không thể lớn hơn trang kết thúc.", "warning");
        return;
      }
      if (allPages.length === 0) return;

      const docId = computeDocumentId(docTitleRef.current, totalPages, allPages[0].text, allPages[allPages.length - 1].text);

      const { handle, useFallback } = await pickDirectoryForJob();
      if (!handle && !useFallback) return; // người dùng huỷ hộp thoại chọn thư mục

      if (useFallback) {
        showToast("Trình duyệt này không hỗ trợ chọn thư mục lưu trực tiếp — mỗi lô sẽ tự tải về thư mục Downloads mặc định.", "info");
      }

      const job: BatchJobRecord = {
        documentId: docId,
        title: docTitleRef.current || "audio",
        startPage: start,
        endPage: end,
        nextPage: start,
        chunkSize: BATCH_JOB_CHUNK_SIZE,
        voice,
        style,
        status: "running",
        useFallbackDownload: useFallback,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await saveBatchJob({ ...job, dirHandle: handle || undefined });
      setResumableJob(null);
      await runBatchJob(job, handle);
    },
    [totalPages, allPages, voice, style, runBatchJob, showToast],
  );

  /** Tiếp tục tác vụ dở dang được phát hiện khi mở lại tài liệu (F5/đóng tab giữa chừng). */
  const resumeBatchExportJob = useCallback(async () => {
    if (!resumableJob) return;

    let handle: FileSystemDirectoryHandle | null = null;
    if (!resumableJob.useFallbackDownload) {
      const result = await pickDirectoryForJob(resumableJob.dirHandle);
      if (!result.handle) return; // người dùng huỷ, hoặc quyền bị từ chối
      handle = result.handle;
    }

    const job: BatchJobRecord = { ...resumableJob, status: "running", updatedAt: Date.now() };
    await saveBatchJob({ ...job, dirHandle: handle || undefined });
    setResumableJob(null);
    await runBatchJob(job, handle);
  }, [resumableJob, runBatchJob]);

  /** Huỷ bỏ hoàn toàn gợi ý tiếp tục (không xoá audio đã tạo, chỉ xoá bản ghi tiến trình). */
  const dismissResumableJob = useCallback(async () => {
    if (resumableJob) {
      await deleteBatchJob(resumableJob.documentId).catch(() => {});
    }
    setResumableJob(null);
  }, [resumableJob]);

  /** Tạm dừng tác vụ đang chạy — tiến trình đã lưu, có thể tiếp tục lại sau (kể cả sau khi F5). */
  const cancelBatchExportJob = useCallback(() => {
    batchJobCancelRef.current = true;
    generationAbortRef.current?.abort();
  }, []);

  const initDocument = useCallback((docPages: PageState[], total: number, title: string = "") => {
    docTitleRef.current = title;
    setAllPages(docPages);
    setTotalPages(total);
    setPages([]);
    setLoadedBatch(-1);
    setCurrentPage(0);
    setCurrentIndex(0);
    setIsPlaying(false);
    setIsPaused(false);
    setIsGenerating(false);
    setGenProgress({
      current: 0,
      total: DEFAULT_PAGES_PER_GENERATE,
      pageNum: 0,
      status: "idle",
    });
    setBatchJob(null);
    setResumableJob(null);

    const firstBatch = docPages.slice(0, PAGES_PER_BATCH);
    setPages(firstBatch);
    setLoadedBatch(0);

    // Thử phục hồi audio đã cache cho batch đầu tiên (BUG FIX #1)
    hydrateBatchFromCache(firstBatch).then((hydrated) => {
      if (!hydrated.some((p) => p.isGenerated)) return;
      setPages((prev) =>
        prev.map((p) => hydrated.find((h) => h.pageNum === p.pageNum) ?? p),
      );
    });

    // Kiểm tra xem tài liệu này có tác vụ tạo audio hàng loạt bị dở dang từ
    // trước (do đóng tab/F5 giữa chừng) hay không, để gợi ý tiếp tục.
    if (docPages.length > 0) {
      const docId = computeDocumentId(
        title,
        total,
        docPages[0].text,
        docPages[docPages.length - 1].text,
      );
      getBatchJob(docId)
        .then((job) => {
          if (job && job.status !== "completed" && job.nextPage <= job.endPage) {
            setResumableJob(job);
          }
        })
        .catch(() => {});
    }
  }, [hydrateBatchFromCache]);

  return {
    clonedVoices,
    addClonedVoice,
    batchJob,
    resumableJob,
    startBatchExportJob,
    resumeBatchExportJob,
    dismissResumableJob,
    cancelBatchExportJob,
    isPlaying,
    isPaused,
    isLoading,
    isGenerating,
    genProgress,
    currentPage,
    currentIndex,
    speed,
    setSpeed,
    voice,
    setVoice,
    voices,
    pages,
    allPages,
    loadedBatch,
    totalPages,
    initDocument,
    loadBatch,
    generateNextBatch,
    generateFromPage,
    retryPageAudio,
    deletePageAudio,
    deleteAllAudio,
    storageEstimate,
    play,
    pause,
    resume,
    stop,
    seekToPage,
    jumpToPage,
    exportAudio,
    exportAudioStreaming,
    exportAudioChunked,
    generationPaceMs,
    setGenerationPaceMs,
    style,
    setStyle,
    styles: VALID_STYLES
  };
}

async function mergeAudioBlobs(blobs: Blob[], pausesAfterMs: number[] = []): Promise<Blob> {
  if (blobs.length === 1) return blobs[0];
  const { mergeWavBlobs } = await import("../utils/audioExport");
  return mergeWavBlobs(blobs, pausesAfterMs);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} giây`;
  return `${minutes} phút ${seconds} giây`;
}
