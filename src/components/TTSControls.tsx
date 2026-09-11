// TTSControls.tsx
import React from "react";

interface TTSControlsProps {
  isPlaying: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  speed: number;
  onSpeedChange: (speed: number) => void;
  disabled?: boolean;
}

const TTSControls: React.FC<TTSControlsProps> = ({
  isPlaying,
  onPlay,
  onPause,
  onStop,
  speed,
  onSpeedChange,
  disabled = false,
}) => (
  <div
    style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}
  >
    <button disabled={disabled} onClick={isPlaying ? onPause : onPlay}>
      {isPlaying ? "⏸️ Tạm dừng" : "▶️ Đọc"}
    </button>
    <button disabled={disabled} onClick={onStop}>⏹️ Dừng</button>
    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
      Tốc độ: {speed.toFixed(1)}x
      <input
        type="range"
        min={0.5}
        max={2.0}
        step={0.1}
        value={speed}
        disabled={disabled}
        onChange={(e) => onSpeedChange(parseFloat(e.target.value))}
      />
    </label>
  </div>
);

export default TTSControls;
