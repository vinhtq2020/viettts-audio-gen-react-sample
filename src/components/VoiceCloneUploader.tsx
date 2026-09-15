import React, { useState } from 'react';
import { API_URL } from '../config';
import { useToast } from './Toast';
import type { TTSEngine } from '../hooks/useTTS';

interface ClonedVoiceInfo {
  id: string;
  name: string;
}

interface VoiceCloneUploaderProps {
  onVoiceCloned: (voiceId: string, voiceName: string, engine: TTSEngine) => void;
  clonedVoices?: ClonedVoiceInfo[];
  onVoiceRemoved?: (voiceId: string) => Promise<boolean> | void;
  disabled?: boolean;
  engine: TTSEngine;
}

const VoiceCloneUploader: React.FC<VoiceCloneUploaderProps> = ({
  onVoiceCloned,
  clonedVoices = [],
  onVoiceRemoved,
  disabled = false,
  engine
}) => {
  const [isUploading, setIsUploading] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const { showToast } = useToast();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (engine === 'vieneu' && !file.type.startsWith('audio/')) {
      showToast('Vui lòng chọn file audio.', 'warning');
      return;
    }
    if (engine === 'zerotts' && !file.name.toLowerCase().endsWith('.npz')) {
      showToast('Vui lòng chọn file .npz.', 'warning');
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      showToast('File quá lớn (tối đa 50MB).', 'warning');
      return;
    }

    setIsUploading(true);
    try {
      const formData = new FormData();
      const voiceId = `cloned_${Date.now()}`;
      formData.append('voice_id', voiceId);
      formData.append('name', file.name.replace(/\.[^/.]+$/, ''));
      const endpoint = engine === 'vieneu' ? 'clone-voice' : 'zerotts-voice';
      formData.append(engine === 'vieneu' ? 'audio_file' : 'npz_file', file);

      const res = await fetch(`${API_URL}/${endpoint}`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Clone failed');
      }

      const data = await res.json();
      onVoiceCloned(data.voice_id, data.name, engine);
      showToast(`Đã clone giọng: ${data.name}`, "success");
    } catch (err: any) {
      showToast('Lỗi: ' + (err.message || 'Clone failed'), 'error');
    } finally {
      setIsUploading(false);
      e.target.value = ''; // Reset input
    }
  };

  const handleRemove = async (voiceId: string, displayName: string) => {
    if (!onVoiceRemoved) return;
    if (!window.confirm(`Xoá giọng "${displayName}"? Không thể hoàn tác — phải clone lại từ đầu nếu muốn dùng lại.`)) {
      return;
    }
    setRemovingId(voiceId);
    try {
      await onVoiceRemoved(voiceId);
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div style={{
      padding: 16,
      border: '2px dashed #dee2e6',
      borderRadius: 8,
      textAlign: 'center',
      background: '#f8f9fa',
    }}>
      <p style={{ margin: '0 0 8px', fontWeight: 600 }}>
        {engine === 'vieneu' ? '🎙️ Clone giọng nói' : '🎙️ Thêm giọng ZeroTTS'}
      </p>
      <p style={{ fontSize: 12, color: '#6c757d', margin: '0 0 12px' }}>
        {engine === 'vieneu'
          ? 'Upload WAV/MP3 3-30 giây, giọng rõ, không nhiễu'
          : <>Upload file .npz giọng ZeroTTS từ <a href="https://platform.zeroweight.ai/audio" target="_blank" rel="noreferrer">platform.zeroweight.ai/audio</a></>}
      </p>
      <input
        type="file"
        accept={engine === 'vieneu' ? 'audio/wav,audio/mp3,audio/mpeg,audio/x-wav' : '.npz,application/octet-stream'}
        onChange={handleFileChange}
        disabled={isUploading || disabled}
      />
      {isUploading && <p style={{ margin: '8px 0 0', color: '#fd7e14' }}>⏳ Đang xử lý...</p>}

      {clonedVoices.length > 0 && (
        <div style={{ marginTop: 14, textAlign: 'left' }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: '#495057', margin: '0 0 6px' }}>
            Giọng đã clone ({clonedVoices.length}):
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {clonedVoices.map((v) => (
              <div
                key={v.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '6px 10px',
                  background: '#fff',
                  border: '1px solid #dee2e6',
                  borderRadius: 6,
                  fontSize: 13,
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {v.name}
                </span>
                <button
                  onClick={() => handleRemove(v.id, v.name)}
                  disabled={disabled || removingId === v.id}
                  title="Xoá giọng đã clone này (xoá cả trên server)"
                  style={{
                    flexShrink: 0,
                    padding: '3px 10px',
                    fontSize: 11,
                    fontWeight: 600,
                    border: '1px solid #dc3545',
                    borderRadius: 4,
                    background: '#fff',
                    color: disabled || removingId === v.id ? '#adb5bd' : '#dc3545',
                    cursor: disabled || removingId === v.id ? 'not-allowed' : 'pointer',
                  }}
                >
                  {removingId === v.id ? '⏳' : '🗑️ Xoá'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default VoiceCloneUploader;
