// TTSSpinner.tsx
import React from "react";

interface TTSSpinnerProps {
  message?: string;
}

const TTSSpinner: React.FC<TTSSpinnerProps> = ({
  message = "Đang tạo giọng đọc...",
}) => {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        animation: "fadeIn 0.3s ease",
      }}
    >
      <div
        style={{
          width: 16,
          height: 16,
          border: "2px solid #856404",
          borderTopColor: "transparent",
          borderRadius: "50%",
          animation: "spin 0.8s linear infinite",
        }}
      />
      <span>{message}</span>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
    </div>
  );
};

export default TTSSpinner;
