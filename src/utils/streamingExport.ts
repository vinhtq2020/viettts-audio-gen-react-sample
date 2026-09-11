import { getCachedAudio } from "./indexedDB";
import { downloadBlob } from "./audioExport";

export interface ExportPageRef {
  pageNum: number;
  cacheKey: string;
}

export function isStreamingExportSupported(): boolean {
  return typeof window !== "undefined" && "showSaveFilePicker" in window;
}

function buildWavHeader(
  sampleRate: number,
  numChannels: number,
  bitsPerSample: number,
  dataSize: number,
): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const enc = new TextEncoder();
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;

  view.setUint8(0, enc.encode("R")[0]);
  view.setUint8(1, enc.encode("I")[0]);
  view.setUint8(2, enc.encode("F")[0]);
  view.setUint8(3, enc.encode("F")[0]);
  view.setUint32(4, 36 + dataSize, true);
  new Uint8Array(buffer, 8, 4).set(enc.encode("WAVE"));
  new Uint8Array(buffer, 12, 4).set(enc.encode("fmt "));
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  new Uint8Array(buffer, 36, 4).set(enc.encode("data"));
  view.setUint32(40, dataSize, true);

  return new Uint8Array(buffer);
}

/** Tìm offset + kích thước của "data" chunk trong 1 file WAV (bỏ qua chunk phụ nếu có). */
function findWavDataChunk(view: DataView, byteLength: number): { offset: number; size: number } {
  let offset = 12;
  while (offset < byteLength - 8) {
    const id =
      String.fromCharCode(view.getUint8(offset)) +
      String.fromCharCode(view.getUint8(offset + 1)) +
      String.fromCharCode(view.getUint8(offset + 2)) +
      String.fromCharCode(view.getUint8(offset + 3));
    const size = view.getUint32(offset + 4, true);
    if (id === "data") return { offset: offset + 8, size };
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV không hợp lệ: không tìm thấy data chunk");
}

export class ExportCancelledError extends Error {
  constructor() {
    super("Export đã bị hủy");
    this.name = "ExportCancelledError";
  }
}

/**
 * XUẤT STREAMING (khuyến nghị cho sách dài): ghi PCM của từng trang thẳng ra file
 * trên đĩa ngay khi đọc xong từ IndexedDB, KHÔNG bao giờ giữ quá 1 trang trong RAM
 * cùng lúc — bộ nhớ trình duyệt dùng gần như không tăng theo độ dài sách.
 *
 * Chỉ chạy được trên Chrome/Edge/Opera (File System Access API). Không có polyfill
 * thật sự cho Firefox/Safari — dùng `exportInChunks` làm phương án thay thế ở đó.
 */
export async function exportBookStreaming(
  refs: ExportPageRef[],
  suggestedName: string,
  onProgress?: (done: number, total: number) => void,
  isCancelled?: () => boolean,
): Promise<void> {
  if (!window.showSaveFilePicker) {
    throw new Error("Trình duyệt không hỗ trợ ghi file trực tiếp (chỉ Chrome/Edge/Opera).");
  }

  const handle = await window.showSaveFilePicker({
    suggestedName,
    types: [{ description: "WAV audio", accept: { "audio/wav": [".wav"] } }],
  });
  const writable = await handle.createWritable();

  let headerWritten = false;
  let sampleRate = 0;
  let numChannels = 0;
  let bitsPerSample = 0;
  let totalDataBytes = 0;

  try {
    for (let i = 0; i < refs.length; i++) {
      if (isCancelled?.()) throw new ExportCancelledError();

      const cached = await getCachedAudio(refs[i].cacheKey);
      if (!cached) continue; // trang thiếu audio trong cache -> bỏ qua, đã cảnh báo trước khi bắt đầu

      // Chỉ giữ ĐÚNG 1 buffer của 1 trang trong bộ nhớ tại một thời điểm.
      const buf = await cached.blob.arrayBuffer();
      const view = new DataView(buf);

      if (!headerWritten) {
        sampleRate = view.getUint32(24, true);
        numChannels = view.getUint16(22, true);
        bitsPerSample = view.getUint16(34, true);
        await writable.write(new Uint8Array(44)); // placeholder, patch lại ở cuối
        headerWritten = true;
      }

      const { offset, size } = findWavDataChunk(view, buf.byteLength);
      const pcmChunk = new Uint8Array(buf.slice(offset, offset + size));
      await writable.write(pcmChunk);
      totalDataBytes += size;

      onProgress?.(i + 1, refs.length);
      // Nhường CPU/GC 1 nhịp giữa các trang thay vì xử lý dồn dập liên tục.
      await new Promise((r) => setTimeout(r, 0));
    }

    if (!headerWritten) {
      throw new Error("Không có trang nào để xuất");
    }

    const header = buildWavHeader(sampleRate, numChannels, bitsPerSample, totalDataBytes);
    await writable.seek(0);
    await writable.write(header);
    await writable.close();
  } catch (err) {
    await writable.close().catch(() => {});
    throw err;
  }
}

/**
 * XUẤT THEO LÔ (phương án cho Firefox/Safari, hoặc khi người dùng không chọn nơi lưu):
 * gộp từng lô ~20 trang thành 1 file WAV rồi tải về ngay, chỉ giữ 1 lô trong RAM tại
 * một thời điểm — bộ nhớ đỉnh bị chặn bởi kích thước lô, không phụ thuộc độ dài sách.
 * Kết quả là nhiều file nhỏ (phần 1, phần 2...) thay vì 1 file khổng lồ.
 */
export async function exportBookInChunks(
  refs: ExportPageRef[],
  baseName: string,
  chunkSize: number = 20,
  onProgress?: (done: number, total: number) => void,
  isCancelled?: () => boolean,
): Promise<{ fileCount: number }> {
  const { mergeWavBlobs } = await import("./audioExport");
  let fileCount = 0;

  for (let start = 0; start < refs.length; start += chunkSize) {
    if (isCancelled?.()) throw new ExportCancelledError();

    const chunkRefs = refs.slice(start, start + chunkSize);
    const blobs: Blob[] = [];
    for (const ref of chunkRefs) {
      const cached = await getCachedAudio(ref.cacheKey);
      if (cached) blobs.push(cached.blob);
    }
    if (blobs.length === 0) continue;

    const merged = blobs.length === 1 ? blobs[0] : await mergeWavBlobs(blobs);
    fileCount++;
    const firstPage = chunkRefs[0].pageNum;
    const lastPage = chunkRefs[chunkRefs.length - 1].pageNum;
    downloadBlob(merged, `${baseName}_p${firstPage}-${lastPage}.wav`);

    onProgress?.(Math.min(start + chunkSize, refs.length), refs.length);
    // Nghỉ 1 nhịp giữa các lô để trình duyệt kịp thu hồi bộ nhớ lô trước.
    await new Promise((r) => setTimeout(r, 50));
  }

  if (fileCount === 0) throw new Error("Không có trang nào để xuất");
  return { fileCount };
}
