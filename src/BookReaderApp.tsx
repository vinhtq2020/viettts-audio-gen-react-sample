import React, { useState, useCallback } from "react";
import { useTTS } from "./hooks/useTTS";
import { parseDocument } from "./utils/fileParsers";
import { downloadBlob } from "./utils/audioExport";
import { isStreamingExportSupported } from "./utils/streamingExport";
import PageReader from "./components/PageReader";
import VoiceSelector from "./components/VoiceSelector";
import TTSControls from "./components/TTSControls";
import TTSSpinner from "./components/TTSSpinner";
import { ProgressBar } from "./components/ProgressBar";
import VoiceCloneUploader from "./components/VoiceCloneUploader";
import { useToast } from "./components/Toast";

// Trên ngưỡng này, KHÔNG gộp toàn bộ audio vào RAM nữa (dùng streaming/chunked export).
const EXPORT_STREAMING_THRESHOLD = 50;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Một nhóm điều khiển trong toolbar, có tiêu đề nhỏ phía trên để dễ phân biệt
// (thay vì tất cả các control dồn chung 1 hàng như trước).
const ToolbarSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={{ marginTop: 12 }}>
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        color: "#868e96",
        marginBottom: 6,
        textTransform: "uppercase",
        letterSpacing: 0.4,
      }}
    >
      {title}
    </div>
    <div
      style={{
        display: "flex",
        gap: 12,
        flexWrap: "wrap",
        alignItems: "center",
        padding: 12,
        background: "#f8f9fa",
        borderRadius: 8,
      }}
    >
      {children}
    </div>
  </div>
);

const BookReaderApp: React.FC = () => {
  const [title, setTitle] = useState<string>("📚 Đọc sách với VieNeu-TTS");
  const [isUploading, setIsUploading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [generateStartPage, setGenerateStartPage] = useState(1);
  const [generatePageCount, setGeneratePageCount] = useState(5);
  const [generateMarkerArmed, setGenerateMarkerArmed] = useState(false);
  const [jumpPage, setJumpPage] = useState(1);
  const [exportStartPage, setExportStartPage] = useState(1);
  const [exportEndPage, setExportEndPage] = useState(10);
  const [toolbarOpen, setToolbarOpen] = useState(true);
  const [batchStartPage, setBatchStartPage] = useState(1);
  const [batchEndPage, setBatchEndPage] = useState(10);
  const { showToast } = useToast();

  const {
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
    engine,
    setEngine,
    voices,
    pages,
    allPages,
    loadedBatch,
    totalPages,
    initDocument,
    loadBatch,
    generateFromPage,
    jumpToPage,
    deletePageAudio,
    deleteAllAudio,
    storageEstimate,
    play,
    pause,
    resume,
    retryPageAudio,
    stop,
    seekToPage,
    exportAudio,
    exportAudioStreaming,
    exportAudioChunked,
    generationPaceMs,
    setGenerationPaceMs,
    clonedVoices,
    addClonedVoice,
    removeClonedVoice,
    batchJob,
    resumableJob,
    startBatchExportJob,
    resumeBatchExportJob,
    dismissResumableJob,
    cancelBatchExportJob,
    style,
    setStyle,
    styles
  } = useTTS();

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      showToast("File quá lớn (tối đa 50MB).", "warning");
      return;
    }

    setIsUploading(true);
    stop();

    try {
      const doc = await parseDocument(file);
      setTitle(doc.title);

      const all = doc.pages.map((p) => ({
        pageNum: p.pageNum,
        text: p.text,
        audioUrl: null,
        isLoading: false,
        isGenerated: false,
        isPlayed: false,
      }));

      initDocument(all, doc.totalPages, doc.title);
      setGenerateStartPage(1);
      setGeneratePageCount(5);
      setGenerateMarkerArmed(false);
      setJumpPage(1);
      setExportStartPage(1);
      setExportEndPage(Math.min(doc.totalPages, 10));
      setBatchStartPage(1);
      setBatchEndPage(doc.totalPages);
    } catch (err: any) {
      showToast("Lỗi đọc file: " + (err.message || "Không thể đọc file"), "error");
    } finally {
      setIsUploading(false);
    }
  };

  const handlePlay = useCallback(() => {
    // 👇 BUG FIX #3: trước đây luôn play(0) -> đang nghe dở, bấm Tạm dừng
    // rồi bấm Đọc lại sẽ bị phát lại từ trang 1. Giờ nếu đang ở trạng thái
    // "tạm dừng" thì resume() tiếp tục đúng chỗ đang dừng.
    if (isPaused) {
      resume();
      return;
    }
    if (pages.length === 0) return;
    play(0);
  }, [isPaused, pages, play, resume]);

  const handleLoadMore = useCallback(() => {
    const nextBatch = loadedBatch + 1;
    loadBatch(nextBatch);
  }, [loadedBatch, loadBatch]);

  const handleJumpToPage = async () => {
    if (jumpPage < 1 || jumpPage > totalPages) {
      showToast(`Trang cần đến phải từ 1 đến ${totalPages}.`, "warning");
      return;
    }
    const targetIndex = await jumpToPage(jumpPage);
    if (targetIndex === null) return;
    window.setTimeout(() => {
      document.querySelector(`[data-page-num="${jumpPage}"]`)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 0);
  };

  const handleSelectGenerationStartPage = (pageNum: number) => {
    setGenerateStartPage(pageNum);
    setGenerateMarkerArmed(false);
    showToast(`Đã đặt cờ bắt đầu tạo audio tại trang ${pageNum}.`, "info");
  };

  const handleGenerate = async () => {
    if (generateStartPage < 1 || generateStartPage > totalPages) {
      showToast(`Trang bắt đầu phải từ 1 đến ${totalPages}.`, "warning");
      return;
    }
    if (generatePageCount < 1 || generatePageCount > 10) {
      showToast("Số trang tạo mỗi lần phải từ 1 đến 10.", "warning");
      return;
    }
    await generateFromPage(generateStartPage, generatePageCount);
  };

  const handleExport = async () => {
    if (exportStartPage < 1 || exportEndPage > totalPages || exportStartPage > exportEndPage) {
      showToast(`Khoảng export không hợp lệ. Chọn từ 1 đến ${totalPages}.`, "warning");
      return;
    }

    setIsExporting(true);
    const safeTitle = title.replace(/\s+/g, "_");
    const requestedPageCount = exportEndPage - exportStartPage + 1;
    const fileName = `${safeTitle}_audio_p${exportStartPage}-${exportEndPage}.wav`;

    try {
      if (requestedPageCount > EXPORT_STREAMING_THRESHOLD) {
        if (isStreamingExportSupported()) {
          showToast(`Đang ghi audio trang ${exportStartPage}-${exportEndPage} trực tiếp ra file...`, "info");
          const ok = await exportAudioStreaming(
            exportStartPage,
            exportEndPage,
            fileName,
            (done, total) => {
              if (done === total || done % 25 === 0) {
                showToast(`Đã ghi ${done}/${total} trang...`, "info");
              }
            },
          );
          if (ok) showToast(`Xuất trang ${exportStartPage}-${exportEndPage} hoàn tất!`, "success");
        } else {
          showToast(
            "Trình duyệt này không hỗ trợ ghi file trực tiếp (chỉ Chrome/Edge) — sẽ xuất thành nhiều file nhỏ.",
            "info",
          );
          const baseName = `${safeTitle}_audio`;
          const fileCount = await exportAudioChunked(
            exportStartPage,
            exportEndPage,
            baseName,
            20,
            (done, total) => showToast(`Đã xuất ${done}/${total} trang...`, "info"),
          );
          if (fileCount > 0) showToast(`Đã tải về ${fileCount} file.`, "success");
        }
      } else {
        const blob = await exportAudio(exportStartPage, exportEndPage);
        if (blob) {
          downloadBlob(blob, fileName);
          showToast(`Xuất trang ${exportStartPage}-${exportEndPage} hoàn tất!`, "success");
        }
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        showToast(err.message || "Không thể export audio.", "error");
      }
    } finally {
      setIsExporting(false);
    }
  };

  const handleDeleteAllAudio = async () => {
    const confirmed = window.prompt(
      'Thao tác này xoá TOÀN BỘ audio đã tạo đang lưu trong trình duyệt — kể cả của những file KHÁC bạn từng mở trước đây, không chỉ file đang mở. Không thể hoàn tác.\n\nGõ "XOA" (không dấu) để xác nhận:',
    );
    if (confirmed?.trim().toUpperCase() !== "XOA") return;
    await deleteAllAudio();
  };

  const hasMore = allPages.length > pages.length;
  const generatedCount = pages.filter((p) => p.isGenerated).length;
  const errorPages = pages.filter((p) => p.generationError);
  // 👇 Khi đang generate nhiều trang: khoá MỌI thao tác khác, chỉ chừa lại
  // nút "Hủy tạo" và khu vực Export (đọc thẳng từ IndexedDB, không đụng GPU
  // nên an toàn để dùng song song với lúc đang generate).
  const isLocked = isGenerating;


  const progressText =
    pages.length > 0
      ? `Hiển thị ${pages.length}/${allPages.length} | Audio: ${generatedCount}/${pages.length}`
      : "Sẵn sàng";

  return (
    <div
      style={{
        maxWidth: 900,
        margin: "0 auto",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ marginBottom: 4 }}>{title}</h1>
      <p style={{ color: "#666", marginBottom: 20, fontSize: 14 }}>
        Self-hosted TTS | GTX 3060 12GB
      </p>

      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          background: "#fff",
          borderBottom: "1px solid #dee2e6",
          boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
          marginBottom: 16,
          marginLeft: -24,
          marginRight: -24,
          paddingLeft: 24,
          paddingRight: 24,
        }}
      >
        {/* Hàng luôn hiển thị dù toolbar đang thu gọn hay mở rộng */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 0",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <button
              onClick={() => setToolbarOpen((open) => !open)}
              aria-label={toolbarOpen ? "Thu gọn thanh công cụ" : "Mở rộng thanh công cụ"}
              title={toolbarOpen ? "Thu gọn" : "Mở rộng"}
              style={{
                width: 28,
                height: 28,
                flexShrink: 0,
                border: "1px solid #dee2e6",
                borderRadius: 6,
                background: "#fff",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              {toolbarOpen ? "▲" : "▼"}
            </button>
            <span
              style={{
                fontWeight: 600,
                fontSize: 14,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {title}
            </span>
            {!toolbarOpen && (
              <span style={{ fontSize: 12, color: "#6c757d", whiteSpace: "nowrap" }}>
                {progressText}
              </span>
            )}
          </div>

          {/* Các thao tác luôn khả dụng kể cả khi toolbar đang thu gọn hoặc đang khoá */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {batchJob?.status === "running" ? (
              <button
                onClick={cancelBatchExportJob}
                style={{
                  padding: "6px 14px",
                  background: "#dc3545",
                  color: "#fff",
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontSize: 13,
                  whiteSpace: "nowrap",
                }}
              >
                ⏸️ Tạm dừng tác vụ (đang xử lý trang {batchJob.nextPage})
              </button>
            ) : isGenerating ? (
              <button
                onClick={stop}
                style={{
                  padding: "6px 14px",
                  background: "#dc3545",
                  color: "#fff",
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontSize: 13,
                  whiteSpace: "nowrap",
                }}
              >
                ⛔ Hủy tạo
              </button>
            ) : null}
            {!toolbarOpen && pages.length > 0 && (
              <button
                onClick={handleExport}
                disabled={isExporting}
                title="Export nhanh theo khoảng trang đã chọn gần nhất"
                style={{
                  padding: "6px 14px",
                  background: isExporting ? "#6c757d" : "#28a745",
                  color: "#fff",
                  border: "none",
                  borderRadius: 4,
                  cursor: isExporting ? "wait" : "pointer",
                  fontSize: 13,
                  whiteSpace: "nowrap",
                }}
              >
                {isExporting ? "⏳..." : `💾 Export p${exportStartPage}-${exportEndPage}`}
              </button>
            )}
          </div>
        </div>

        {/* Phần nội dung đầy đủ — chỉ hiện khi mở rộng */}
        {toolbarOpen && (
          <div style={{ paddingBottom: 16 }}>
            <ToolbarSection title="📄 Tài liệu & giọng đọc">
              <input
                type="file"
                accept=".pdf,.docx,.doc,.txt,.md"
                onChange={handleFileUpload}
                disabled={isUploading || isLocked}
                style={{ fontSize: 14 }}
              />

              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <label title="VieNeu chạy GPU; ZeroTTS chạy CPU và không cần GPU.">
                  🧠 Model TTS:
                </label>
                <select
                  value={engine}
                  onChange={(e) => setEngine(e.target.value as "vieneu" | "zerotts")}
                  disabled={isLocked}
                  style={{ padding: "4px 8px", borderRadius: 4, minWidth: 170 }}
                >
                  <option value="vieneu">VieNeu (GPU, có clone giọng)</option>
                  <option value="zerotts">ZeroTTS (CPU)</option>
                </select>
              </div>

              <VoiceCloneUploader
                engine={engine}
                onVoiceCloned={addClonedVoice}
                clonedVoices={clonedVoices.filter((v) => v.engine === engine)}
                onVoiceRemoved={removeClonedVoice}
                disabled={isLocked}
              />
              {isUploading && <TTSSpinner message="Đang đọc file..." />}

              {pages.length > 0 && (
                <>
                  <VoiceSelector
                    voices={voices.filter((v) => v.engine === engine)}
                    voice={voice}
                    onChange={setVoice}
                    clonedVoices={clonedVoices.filter((v) => v.engine === engine)}
                    disabled={isLocked}
                  />
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <label>🎭 Phong cách:</label>
                    <select
                      value={style}
                      onChange={(e) => setStyle(e.target.value)}
                      disabled={isLocked || engine === "zerotts"}
                      title={engine === "zerotts" ? "ZeroTTS chưa hỗ trợ chọn phong cách đọc" : undefined}
                      style={{ padding: "4px 8px", borderRadius: 4, minWidth: 140 }}
                    >
                      {styles.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}
            </ToolbarSection>

            {pages.length > 0 && (
              <>
                <ToolbarSection title="🧭 Điều hướng & tạo audio">
                  <label>🔎 Đi tới trang:</label>
                  <input
                    type="number"
                    min={1}
                    max={totalPages}
                    value={jumpPage}
                    onChange={(e) => setJumpPage(Number(e.target.value))}
                    onKeyDown={(e) => { if (e.key === "Enter") void handleJumpToPage(); }}
                    disabled={isLocked}
                    style={{ width: 72, padding: "5px 7px" }}
                  />
                  <button
                    onClick={handleJumpToPage}
                    disabled={isLocked}
                    style={{ padding: "6px 12px", border: "1px solid #adb5bd", borderRadius: 4, background: "#fff", cursor: isLocked ? "not-allowed" : "pointer" }}
                  >
                    Đi tới
                  </button>
                  <button
                    onClick={() => setGenerateMarkerArmed((armed) => !armed)}
                    disabled={isLocked}
                    title={generateMarkerArmed ? "Click vào một trang bên dưới để đặt cờ" : "Bật để chọn trang bắt đầu bằng cách click vào trang"}
                    style={{
                      padding: "6px 12px",
                      border: generateMarkerArmed ? "2px solid #dc3545" : "1px solid #adb5bd",
                      borderRadius: 4,
                      background: generateMarkerArmed ? "#fff3cd" : "#fff",
                      cursor: isLocked ? "not-allowed" : "pointer",
                      fontWeight: 600,
                    }}
                  >
                    🚩 {generateMarkerArmed ? "Chọn trang bắt đầu..." : `Bắt đầu: p${generateStartPage}`}
                  </button>
                  <span style={{ fontSize: 12, color: generateMarkerArmed ? "#dc3545" : "#6c757d" }}>
                    {generateMarkerArmed ? "Click vào trang bên dưới để cắm cờ." : `Cờ: trang ${generateStartPage}`}
                  </span>

                  <span style={{ width: 1, alignSelf: "stretch", background: "#dee2e6" }} />

                  <label>Số trang:</label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={generatePageCount}
                    onChange={(e) => setGeneratePageCount(Number(e.target.value))}
                    disabled={isLocked}
                    style={{ width: 72, padding: "5px 7px" }}
                  />
                  <label title="Nghỉ giữa các lần gọi TTS liên tiếp, để GPU có nhịp nghỉ khi tạo hàng loạt trang">
                    ⏸️ Nghỉ:
                  </label>
                  <select
                    value={generationPaceMs}
                    onChange={(e) => setGenerationPaceMs(Number(e.target.value))}
                    disabled={isLocked}
                    style={{ padding: "4px 8px", borderRadius: 4, minWidth: 100 }}
                  >
                    <option value={0}>Không nghỉ</option>
                    <option value={250}>250 ms</option>
                    <option value={500}>500 ms</option>
                    <option value={1000}>1 giây</option>
                    <option value={2000}>2 giây</option>
                  </select>
                  <button
                    onClick={handleGenerate}
                    disabled={isLocked}
                    style={{
                      padding: "6px 16px",
                      background: isLocked ? "#6c757d" : "#fd7e14",
                      color: "#fff",
                      border: "none",
                      borderRadius: 4,
                      cursor: isLocked ? "wait" : "pointer",
                    }}
                  >
                    {isGenerating ? "⏳ Đang tạo..." : `Tạo ${generatePageCount} trang`}
                  </button>
                </ToolbarSection>

                <ToolbarSection title="🔊 Nghe & export">
                  <TTSControls
                    isPlaying={isPlaying}
                    onPlay={handlePlay}
                    onPause={pause}
                    onStop={stop}
                    speed={speed}
                    onSpeedChange={setSpeed}
                    disabled={isLocked}
                  />

                  <span style={{ width: 1, alignSelf: "stretch", background: "#dee2e6" }} />

                  <label>💾 Export:</label>
                  <input
                    type="number"
                    min={1}
                    max={totalPages}
                    value={exportStartPage}
                    onChange={(e) => setExportStartPage(Number(e.target.value))}
                    disabled={isExporting}
                    style={{ width: 72, padding: "5px 7px" }}
                  />
                  <span>→</span>
                  <input
                    type="number"
                    min={1}
                    max={totalPages}
                    value={exportEndPage}
                    onChange={(e) => setExportEndPage(Number(e.target.value))}
                    disabled={isExporting}
                    style={{ width: 72, padding: "5px 7px" }}
                  />
                  <button
                    onClick={handleExport}
                    disabled={isExporting}
                    style={{
                      padding: "6px 16px",
                      background: isExporting ? "#6c757d" : "#28a745",
                      color: "#fff",
                      border: "none",
                      borderRadius: 4,
                      cursor: isExporting ? "wait" : "pointer",
                    }}
                  >
                    {isExporting ? "⏳ Đang export..." : `Export p${exportStartPage}-${exportEndPage}`}
                  </button>
                </ToolbarSection>

                {!batchJob && !resumableJob && (
                  <ToolbarSection title="🚀 Tạo audio hàng loạt tự động (vượt quá 10 trang/lần)">
                    <label>Từ trang:</label>
                    <input
                      type="number"
                      min={1}
                      max={totalPages}
                      value={batchStartPage}
                      onChange={(e) => setBatchStartPage(Number(e.target.value))}
                      disabled={isLocked}
                      style={{ width: 72, padding: "5px 7px" }}
                    />
                    <label>đến trang:</label>
                    <input
                      type="number"
                      min={1}
                      max={totalPages}
                      value={batchEndPage}
                      onChange={(e) => setBatchEndPage(Number(e.target.value))}
                      disabled={isLocked}
                      style={{ width: 72, padding: "5px 7px" }}
                    />
                    <button
                      onClick={() => startBatchExportJob(batchStartPage, batchEndPage)}
                      disabled={isLocked || batchStartPage > batchEndPage}
                      title={batchStartPage > batchEndPage ? "Trang bắt đầu không thể lớn hơn trang kết thúc" : "Chọn thư mục lưu, rồi tự động tạo + export + dọn cache từng lô 10 trang"}
                      style={{
                        padding: "6px 16px",
                        background: isLocked || batchStartPage > batchEndPage ? "#adb5bd" : "#0d6efd",
                        color: "#fff",
                        border: "none",
                        borderRadius: 4,
                        cursor: isLocked || batchStartPage > batchEndPage ? "not-allowed" : "pointer",
                        fontWeight: 600,
                      }}
                    >
                      🚀 Bắt đầu tự động
                    </button>
                    <span style={{ fontSize: 12, color: "#6c757d" }}>
                      Cứ {batchStartPage <= batchEndPage ? Math.min(10, batchEndPage - batchStartPage + 1) : 10} trang sẽ tự export 1 file
                      về máy rồi dọn cache — an toàn với sách rất dài, không cần theo dõi liên tục.
                    </span>
                  </ToolbarSection>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Phát hiện tác vụ tạo audio hàng loạt bị dở dang từ trước (đóng tab/F5 giữa chừng) */}
      {resumableJob && !batchJob && (
        <div
          style={{
            marginBottom: 16,
            padding: 14,
            background: "#fff3cd",
            border: "1px solid #ffe69c",
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 10,
          }}
        >
          <div style={{ fontSize: 14 }}>
            ⚠️ Phát hiện tác vụ tạo audio hàng loạt <strong>bị gián đoạn</strong> trước đó: trang{" "}
            <strong>{resumableJob.startPage}-{resumableJob.endPage}</strong>, đã xử lý xong tới trang{" "}
            <strong>{resumableJob.nextPage - 1 >= resumableJob.startPage ? resumableJob.nextPage - 1 : "(chưa có)"}</strong>.
            {resumableJob.status === "error" && resumableJob.errorMessage && (
              <div style={{ fontSize: 12, color: "#dc3545", marginTop: 4 }}>Lỗi trước đó: {resumableJob.errorMessage}</div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button
              onClick={resumeBatchExportJob}
              style={{ padding: "6px 14px", background: "#fd7e14", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontWeight: 600 }}
            >
              ▶️ Tiếp tục từ trang {resumableJob.nextPage}
            </button>
            <button
              onClick={dismissResumableJob}
              style={{ padding: "6px 14px", background: "#fff", color: "#6c757d", border: "1px solid #adb5bd", borderRadius: 4, cursor: "pointer" }}
            >
              Bỏ qua
            </button>
          </div>
        </div>
      )}

      {/* Tiến độ tác vụ tạo audio hàng loạt đang chạy/tạm dừng/lỗi */}
      {batchJob && (
        <div
          style={{
            marginBottom: 16,
            padding: 14,
            background: batchJob.status === "error" ? "#fff5f5" : batchJob.status === "completed" ? "#f0fff4" : "#e7f5ff",
            border: `1px solid ${batchJob.status === "error" ? "#dc3545" : batchJob.status === "completed" ? "#28a745" : "#74c0fc"}`,
            borderRadius: 8,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
            <strong style={{ fontSize: 14 }}>
              🚀 Tác vụ hàng loạt trang {batchJob.startPage}-{batchJob.endPage}
              {batchJob.status === "running" && " — đang chạy"}
              {batchJob.status === "paused" && " — đã tạm dừng"}
              {batchJob.status === "error" && " — dừng do lỗi"}
              {batchJob.status === "completed" && " — hoàn tất!"}
            </strong>
            {batchJob.status === "paused" && (
              <button onClick={resumeBatchExportJob} style={{ padding: "5px 12px", background: "#fd7e14", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontWeight: 600 }}>
                ▶️ Tiếp tục
              </button>
            )}
            {batchJob.status === "error" && (
              <button onClick={resumeBatchExportJob} style={{ padding: "5px 12px", background: "#dc3545", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontWeight: 600 }}>
                🔄 Thử tiếp tục
              </button>
            )}
          </div>
          <div style={{ width: "100%", height: 8, background: "#e9ecef", borderRadius: 4, overflow: "hidden", marginBottom: 6 }}>
            <div
              style={{
                width: `${Math.min(100, Math.round(((batchJob.nextPage - batchJob.startPage) / (batchJob.endPage - batchJob.startPage + 1)) * 100))}%`,
                height: "100%",
                background: batchJob.status === "error" ? "#dc3545" : batchJob.status === "completed" ? "#28a745" : "#339af0",
                transition: "width 0.3s ease",
              }}
            />
          </div>
          <div style={{ fontSize: 12, color: "#495057" }}>
            {batchJob.status === "completed"
              ? `Đã xử lý xong toàn bộ ${batchJob.endPage - batchJob.startPage + 1} trang.`
              : `Đang ở trang ${Math.min(batchJob.nextPage, batchJob.endPage)}/${batchJob.endPage} — mỗi ${batchJob.chunkSize} trang tự động export 1 file rồi dọn cache.`}
            {batchJob.useFallbackDownload && " (đang tải từng file về thư mục Downloads mặc định)"}
          </div>
          {batchJob.status === "error" && batchJob.errorMessage && (
            <div style={{ fontSize: 12, color: "#dc3545", marginTop: 4 }}>{batchJob.errorMessage}</div>
          )}
        </div>
      )}



      {isGenerating && genProgress.status !== "idle" && (
        <div
          style={{
            marginBottom: 16,
            padding: 12,
            background: "#fff3cd",
            borderRadius: 6,
          }}
        >
          <ProgressBar
            current={genProgress.current}
            total={genProgress.total}
            pageNum={genProgress.pageNum}
            status={genProgress.status}
          />
        </div>
      )}

      {/* Dung lượng audio đã lưu trong trình duyệt / mức tối đa được cấp phép */}
      {storageEstimate && storageEstimate.quotaBytes > 0 && (
        <div
          style={{
            marginBottom: 16,
            padding: 12,
            background: "#f8f9fa",
            borderRadius: 6,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, marginBottom: 4, color: "#495057" }}>
            <span>💽 Dung lượng audio đã lưu (trình duyệt)</span>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span>
                {formatBytes(storageEstimate.usageBytes)} / {formatBytes(storageEstimate.quotaBytes)}{" "}
                ({Math.round((storageEstimate.usageBytes / storageEstimate.quotaBytes) * 100)}%)
              </span>
              <button
                onClick={handleDeleteAllAudio}
                disabled={isLocked || isExporting}
                title="Xoá toàn bộ audio đã tạo đang lưu trong trình duyệt, kể cả của các file khác từng mở trước đây"
                style={{
                  padding: "3px 10px",
                  fontSize: 11,
                  fontWeight: 600,
                  border: "1px solid #dc3545",
                  borderRadius: 4,
                  background: "#fff",
                  color: isLocked || isExporting ? "#adb5bd" : "#dc3545",
                  cursor: isLocked || isExporting ? "not-allowed" : "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                🗑️ Xoá tất cả
              </button>
            </div>
          </div>
          <div style={{ width: "100%", height: 8, background: "#e9ecef", borderRadius: 4, overflow: "hidden" }}>
            <div
              style={{
                width: `${Math.min(100, (storageEstimate.usageBytes / storageEstimate.quotaBytes) * 100)}%`,
                height: "100%",
                background:
                  storageEstimate.usageBytes / storageEstimate.quotaBytes > 0.9
                    ? "#dc3545"
                    : storageEstimate.usageBytes / storageEstimate.quotaBytes > 0.7
                      ? "#fd7e14"
                      : "#28a745",
                transition: "width 0.3s ease",
              }}
            />
          </div>
          {storageEstimate.usageBytes / storageEstimate.quotaBytes > 0.9 && (
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "#dc3545" }}>
              ⚠️ Sắp đầy dung lượng cho phép — trình duyệt có thể tự xoá bớt cache cũ. Cân nhắc export và xoá bớt audio các trang không cần.
            </p>
          )}
        </div>
      )}

      {/* Status */}
      <div
        style={{
          marginBottom: 16,
          padding: "8px 16px",
          background: isGenerating
            ? "#fff3cd"
            : isPlaying
              ? "#d4edda"
              : isLoading
                ? "#cce5ff"
                : "#e2e3e5",
          borderRadius: 6,
          color: isGenerating
            ? "#856404"
            : isPlaying
              ? "#155724"
              : isLoading
                ? "#004085"
                : "#383d41",
          fontSize: 14,
          fontWeight: 500,
          display: "flex",
          alignItems: "center",
          gap: 10,
          minHeight: 36,
        }}
      >
        {isGenerating && (
          <TTSSpinner message={`Đang tạo audio... ${progressText}`} />
        )}
        {isLoading && !isGenerating && (
          <TTSSpinner message={`Đang tải... ${progressText}`} />
        )}
        {!isGenerating &&
          !isLoading &&
          isPlaying &&
          `🔊 Đang đọc: ${progressText}`}
        {!isGenerating && !isLoading && !isPlaying && `⏸️ ${progressText}`}
      </div>

      {/* Error banner */}
      {errorPages.length > 0 && (
        <div
          style={{
            marginBottom: 16,
            padding: "8px 16px",
            background: "#f8d7da",
            borderRadius: 6,
            color: "#721c24",
            fontSize: 13,
          }}
        >
          ⚠️ {errorPages.length} trang bị lỗi:{" "}
          {errorPages.map((p) => `Trang ${p.pageNum}`).join(", ")}. Export sẽ
          gộp đến trang cuối thành công.
        </div>
      )}

      <PageReader
        pages={pages}
        currentPage={currentPage}
        currentIndex={currentIndex}
        onPageClick={seekToPage}
        onLoadMore={handleLoadMore}
        hasMore={hasMore}
        isLoadingMore={isLoading}
        onRetry={retryPageAudio}
        onDelete={deletePageAudio}
        locked={isLocked}
        generationMarkerArmed={generateMarkerArmed}
        generationStartPage={generateStartPage}
        onSelectGenerationStartPage={handleSelectGenerationStartPage}
      />
    </div>
  );
};

export default BookReaderApp;
