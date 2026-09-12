import { useState, useRef, useCallback, useEffect } from "react";
import VoiceSelector from "../components/VoiceSelector";
import VoiceCloneUploader from "../components/VoiceCloneUploader";
import { downloadBlob } from "../utils/audioExport";
import { chunkText } from "../utils/textChunker";
import { API_URL } from "../config";
import { useToast } from "../components/Toast";

interface Voice {
  id: string;
  name: string;
  type?: 'preset' | 'cloned';
}

export default function TextToSpeechPage() {
  const [text, setText] = useState("");
  const [voice, setVoice] = useState<string>("Trúc Ly");
  const [voices, setVoices] = useState<Voice[]>([]);
  const [clonedVoices, setClonedVoices] = useState<Voice[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [style, setStyle] = useState<string>("tu_nhien");
  const STYLES = [
    { id: "tu_nhien", name: "Tự nhiên" },
    { id: "tin_tuc", name: "Tin tức" },
    { id: "doc_truyen", name: "Đọc truyện" },
  ];
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const { showToast } = useToast();

  useEffect(() => {
    fetch(`${API_URL}/voices`)
      .then(r => r.json())
      .then((data: Voice[]) => {
        const presets = data.filter(v => v.type === 'preset' || !v.type);
        const clones = data.filter(v => v.type === 'cloned');
        setVoices(presets);
        setClonedVoices(clones);
        if (presets.length > 0 && !voice) setVoice(presets[0].id);
      })
      .catch(console.error);
  }, []);

  const isClonedVoice = clonedVoices.some(v => v.id === voice);

  const handleGenerate = async () => {
    if (!text.trim()) {
      showToast("Vui lòng nhập văn bản.", "warning");
      return;
    }

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsGenerating(true);
    setError(null);
    setAudioUrl(null);
    setAudioBlob(null);

    try {
      const chunks = chunkText(text.trim(), 1800);
      setProgress({ current: 0, total: chunks.length });
      const blobs: Blob[] = [];
      const pausesAfterMs = chunks.map((chunk) => chunk.pauseAfterMs);

      for (let i = 0; i < chunks.length; i++) {
        setProgress({ current: i + 1, total: chunks.length });

        const res = await fetch(`${API_URL}/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: chunks[i].text,
            voice: isClonedVoice ? undefined : voice,
            use_clone: isClonedVoice,
            cloned_voice_id: isClonedVoice ? voice : undefined,
            style,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "TTS failed" }));
          throw new Error(err.error);
        }

        blobs.push(await res.blob());
      }

      let finalBlob: Blob;
      if (blobs.length === 1) {
        finalBlob = blobs[0];
      } else {
        const { mergeWavBlobs } = await import("../utils/audioExport");
        finalBlob = await mergeWavBlobs(blobs, pausesAfterMs);
      }

      const url = URL.createObjectURL(finalBlob);
      setAudioUrl(url);
      setAudioBlob(finalBlob);
    } catch (err: any) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        setError(null);
        showToast("Đã hủy quá trình tạo audio.", "info");
      } else {
        const message = err.message || "Lỗi tạo audio";
        setError(message);
        showToast(message, "error");
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setIsGenerating(false);
      setProgress({ current: 0, total: 0 });
    }
  };

  const handleCancel = () => {
    abortControllerRef.current?.abort();
  };

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const handlePlay = useCallback(() => {
    if (!audioUrl || !audioRef.current) return;
    audioRef.current.src = audioUrl;
    audioRef.current.play().catch(console.error);
  }, [audioUrl]);

  const handleDownload = () => {
    if (!audioBlob) return;
    downloadBlob(audioBlob, "tts_output.wav");
  };

  // 👇 Callback khi clone thành công
  const handleVoiceCloned = (voiceId: string, name: string) => {
    setClonedVoices(prev => {
      if (prev.find(v => v.id === voiceId)) return prev;
      return [...prev, { id: voiceId, name: `🎙️ ${name}`, type: 'cloned' as const }];
    });
    setVoice(voiceId);
  };

  const handleVoiceRemoved = async (voiceId: string): Promise<boolean> => {
    try {
      const res = await fetch(`${API_URL}/clone-voice/${encodeURIComponent(voiceId)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
    } catch (err: any) {
      showToast(`Không xoá được giọng: ${err.message || err}`, "error");
      return false;
    }

    setClonedVoices(prev => prev.filter(v => v.id !== voiceId));
    if (voice === voiceId) {
      setVoice(voices[0]?.id || "Trúc Ly");
    }
    showToast("Đã xoá giọng đã clone.", "success");
    return true;
  };

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>📝 Text to Speech</h1>
      <p style={{ color: "#666", marginBottom: 20 }}>
        Nhập văn bản tiếng Việt → Chọn giọng → Tạo audio
      </p>

      {/* 👇 Voice Clone Uploader */}
      <VoiceCloneUploader
        onVoiceCloned={handleVoiceCloned}
        clonedVoices={clonedVoices}
        onVoiceRemoved={handleVoiceRemoved}
      />

      {/* Voice Selector */}
      <div style={{ marginTop: 16, marginBottom: 16 }}>
        <VoiceSelector
          voices={voices}
          clonedVoices={clonedVoices}
          voice={voice}
          onChange={setVoice}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label>🎭 Phong cách:</label>
          <select
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            disabled={isGenerating}
            style={{ padding: "4px 8px", borderRadius: 4, minWidth: 140 }}
          >
            {STYLES.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Text Input */}
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Nhập văn bản tiếng Việt tại đây..."
        style={{
          width: "100%",
          minHeight: 200,
          padding: 16,
          fontSize: 16,
          lineHeight: 1.6,
          borderRadius: 8,
          border: "1px solid #ced4da",
          resize: "vertical",
          fontFamily: "system-ui, sans-serif",
        }}
      />
      <div style={{ textAlign: "right", color: "#6c757d", fontSize: 12, marginTop: 4 }}>
        {text.length} ký tự • {chunkText(text, 1800).length} đoạn sẽ gửi
      </div>

      {/* Generate Button */}
      <div style={{ marginTop: 16, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button
          onClick={handleGenerate}
          disabled={isGenerating || !text.trim()}
          style={{
            padding: "10px 24px",
            background: isGenerating ? "#6c757d" : "#fd7e14",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            cursor: isGenerating ? "wait" : "pointer",
            fontSize: 16,
            fontWeight: 600,
          }}
        >
          {isGenerating ? "⏳ Đang tạo..." : "🔨 Tạo audio"}
        </button>

        {isGenerating && (
          <button
            onClick={handleCancel}
            style={{
              padding: "10px 18px",
              background: "#dc3545",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 16,
            }}
          >
            ⛔ Hủy
          </button>
        )}

        {audioUrl && (
          <>
            <button
              onClick={handlePlay}
              style={{
                padding: "10px 24px",
                background: "#28a745",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 16,
              }}
            >
              ▶️ Phát
            </button>
            <button
              onClick={handleDownload}
              style={{
                padding: "10px 24px",
                background: "#007bff",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 16,
              }}
            >
              💾 Tải xuống
            </button>
          </>
        )}
      </div>

      {/* Progress */}
      {isGenerating && progress.total > 0 && (
        <div style={{ marginTop: 16, padding: 12, background: "#fff3cd", borderRadius: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginBottom: 6 }}>
            <span>Đang xử lý đoạn {progress.current}/{progress.total}</span>
            <span>{Math.round((progress.current / progress.total) * 100)}%</span>
          </div>
          <div style={{ width: "100%", height: 8, background: "#e9ecef", borderRadius: 4 }}>
            <div style={{
              width: `${(progress.current / progress.total) * 100}%`,
              height: "100%",
              background: "#fd7e14",
              borderRadius: 4,
              transition: "width 0.3s",
            }} />
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ marginTop: 16, padding: 12, background: "#f8d7da", borderRadius: 6, color: "#721c24" }}>
          ❌ {error}
        </div>
      )}

      {/* Audio Player */}
      <audio
        ref={audioRef}
        controls={!!audioUrl}
        style={{ marginTop: 16, width: "100%", display: audioUrl ? "block" : "none" }}
      />

      {audioUrl && (
        <div style={{ marginTop: 12, color: "#28a745", fontSize: 14 }}>
          ✅ Đã tạo audio thành công! {isClonedVoice && "🎙️ Dùng giọng đã clone"}
        </div>
      )}
    </div>
  );
}