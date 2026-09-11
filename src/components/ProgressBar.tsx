import React from "react";

export const ProgressBar: React.FC<{
  current: number;
  total: number;
  pageNum: number;
  status: string;
}> = ({ current, total, pageNum, status }) => {
  const percent = Math.round((current / total) * 100);
  return (
    <div style={{ width: "100%", marginTop: 8 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 12,
          marginBottom: 4,
        }}
      >
        <span>
          Trang {pageNum} ({current}/{total})
        </span>
        <span>
          {status === "generating"
            ? "⏳ Đang tạo..."
            : status === "success"
              ? "✅ Xong"
              : "❌ Lỗi"}
        </span>
      </div>
      <div
        style={{
          width: "100%",
          height: 8,
          background: "#e9ecef",
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${percent}%`,
            height: "100%",
            background:
              status === "error"
                ? "#dc3545"
                : status === "success"
                  ? "#28a745"
                  : "#fd7e14",
            transition: "width 0.3s ease",
          }}
        />
      </div>
    </div>
  );
};
