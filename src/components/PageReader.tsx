import React from "react";
import type { PageState } from "../hooks/useTTS";

interface PageReaderProps {
  pages: PageState[];
  currentPage: number;
  currentIndex: number;
  onPageClick: (pageIdx: number) => void;
  onLoadMore: () => void;
  onRetry?: (pageNum: number) => void;
  onDelete?: (pageNum: number) => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  generationMarkerArmed?: boolean;
  generationStartPage?: number;
  onSelectGenerationStartPage?: (pageNum: number) => void;
  locked?: boolean;
}

const PageReader: React.FC<PageReaderProps> = ({
  pages,
  currentPage,
  currentIndex,
  onPageClick,
  onLoadMore,
  onRetry,
  onDelete,
  hasMore,
  isLoadingMore,
  generationMarkerArmed = false,
  generationStartPage,
  onSelectGenerationStartPage,
  locked = false,
}) => {
  return (
    <div className="page-reader">
      {pages.map((page, idx) => (
        <div
          key={page.pageNum}
          data-page-num={page.pageNum}
          onClick={() => {
            if (locked || page.isLoading) return;
            if (generationMarkerArmed && onSelectGenerationStartPage) {
              onSelectGenerationStartPage(page.pageNum);
              return;
            }
            onPageClick(idx);
          }}
          style={{
            marginBottom: 16,
            padding: 20,
            borderRadius: 8,
            border:
              page.pageNum === generationStartPage
                ? "2px solid #dc3545"
                : idx === currentPage
                  ? "2px solid #ffc107"
                : page.generationError
                  ? "2px solid #dc3545"
                  : "1px solid #dee2e6",
            backgroundColor:
              idx === currentPage
                ? "#fffbf0"
                : page.isPlayed
                  ? "#f8f9fa"
                  : page.generationError
                    ? "#fff5f5"
                    : "#fff",
            cursor: locked ? "not-allowed" : page.isLoading ? "wait" : generationMarkerArmed ? "crosshair" : "pointer",
            opacity: locked && !page.isLoading ? 0.75 : 1,
            transition: "all 0.2s ease",
            position: "relative",
          }}
        >
          {/* Badge trạng thái */}
          <div
            style={{
              position: "absolute",
              top: 8,
              right: 12,
              fontSize: 12,
              fontWeight: 600,
              display: "flex",
              gap: 6,
              alignItems: "center",
            }}
          >
            <span>Trang {page.pageNum}</span>
            {page.pageNum === generationStartPage && <span title="Trang bắt đầu tạo audio">🚩</span>}
            {page.isGenerated && <span style={{ color: "#28a745" }}>✓</span>}
            {page.isLoading && <span style={{ color: "#fd7e14" }}>⏳</span>}
            {page.generationError && (
              <span style={{ color: "#dc3545" }}>❌</span>
            )}
            {page.isPlayed && <span style={{ color: "#6c757d" }}>▶</span>}
          </div>

          {/* Nội dung */}
          <div style={{ marginTop: 8, lineHeight: 1.8 }}>
            {idx === currentPage ? (
              highlightChunks(page.text, currentIndex)
            ) : (
              <p style={{ margin: 0 }}>
                {page.text.slice(0, 200)}
                {page.text.length > 200 ? "..." : ""}
              </p>
            )}
          </div>

          {/* 👇 Footer: Luôn hiển thị Retry */}
          <div
            style={{
              marginTop: 12,
              padding: "6px 0",
              borderTop: "1px solid #e9ecef",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            {/* Thông tin giọng đã dùng */}
            <span style={{ fontSize: 12, color: "#6c757d" }}>
              {page.voiceUsed ? `🎙️ ${page.voiceUsed}` : "Chưa tạo audio"}
              {page.retryCount && page.retryCount > 0
                ? ` • Đã tạo ${page.retryCount} lần`
                : ""}
            </span>

            {/* Nút Retry luôn hiển thị */}
            {onRetry && !page.isLoading && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRetry(page.pageNum);
                }}
                disabled={locked}
                style={{
                  padding: "4px 12px",
                  background: locked
                    ? "#adb5bd"
                    : page.generationError
                      ? "#dc3545"
                      : page.isGenerated
                        ? "#6c757d"
                        : "#fd7e14",
                  color: "#fff",
                  border: "none",
                  borderRadius: 4,
                  cursor: locked ? "not-allowed" : "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {page.generationError
                  ? "🔄 Thử lại"
                  : page.isGenerated
                    ? "🔄 Tạo lại"
                    : "🔨 Tạo ngay"}
              </button>
            )}

            {/* Nút xoá audio — chỉ hiện khi trang đã có audio */}
            {onDelete && page.isGenerated && !page.isLoading && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`Xoá audio đã tạo của trang ${page.pageNum}? Bạn sẽ cần tạo lại từ đầu nếu muốn nghe trang này.`)) {
                    onDelete(page.pageNum);
                  }
                }}
                disabled={locked}
                title="Xoá audio đã tạo của trang này"
                style={{
                  padding: "4px 10px",
                  background: "#fff",
                  color: locked ? "#adb5bd" : "#dc3545",
                  border: `1px solid ${locked ? "#dee2e6" : "#dc3545"}`,
                  borderRadius: 4,
                  cursor: locked ? "not-allowed" : "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                🗑️ Xoá
              </button>
            )}
          </div>

          {/* Hiển thị lỗi nếu có */}
          {page.generationError && (
            <div
              style={{
                marginTop: 8,
                padding: "4px 8px",
                background: "#f8d7da",
                borderRadius: 4,
                color: "#721c24",
                fontSize: 12,
              }}
            >
              ❌ {page.generationError}
            </div>
          )}
        </div>
      ))}

      {hasMore && (
        <button
          onClick={onLoadMore}
          disabled={isLoadingMore || locked}
          style={{
            width: "100%",
            padding: 12,
            background: isLoadingMore || locked ? "#6c757d" : "#007bff",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            cursor: isLoadingMore || locked ? "not-allowed" : "pointer",
            fontSize: 14,
          }}
        >
          {isLoadingMore ? "Đang tải..." : `Tải thêm 10 trang`}
        </button>
      )}
    </div>
  );
};

function highlightChunks(text: string, activeChunk: number): React.ReactNode {
  const chunks = text
    .replace(/([.!?…]+)/g, "$1|")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);

  return chunks.map((chunk, idx) => (
    <span
      key={idx}
      style={{
        backgroundColor: idx === activeChunk ? "#fff3cd" : "transparent",
        padding: "2px 0",
        borderRadius: 2,
        transition: "background 0.3s",
      }}
    >
      {chunk}
    </span>
  ));
}

export default PageReader;
