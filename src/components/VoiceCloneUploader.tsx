import React, { useState } from 'react';
import { API_URL } from '../config';
import { useToast } from './Toast';

interface VoiceCloneUploaderProps {
  onVoiceCloned: (voiceId: string, voiceName: string) => void;
  disabled?: boolean;
}

const VoiceCloneUploader: React.FC<VoiceCloneUploaderProps> = ({ onVoiceCloned, disabled = false }) => {
  const [isUploading, setIsUploading] = useState(false);
  const { showToast } = useToast();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('audio/')) {
      showToast('Vui lòng chọn file audio.', 'warning');
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
      formData.append('audio_file', file);

      const res = await fetch(`${API_URL}/clone-voice`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Clone failed');
      }

      const data = await res.json();
      onVoiceCloned(data.voice_id, data.name);
      showToast(`Đã clone giọng: ${data.name}`, "success");
    } catch (err: any) {
      showToast('Lỗi: ' + (err.message || 'Clone failed'), 'error');
    } finally {
      setIsUploading(false);
      e.target.value = ''; // Reset input
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
      <p style={{ margin: '0 0 8px', fontWeight: 600 }}>🎙️ Clone giọng nói</p>
      <p style={{ fontSize: 12, color: '#6c757d', margin: '0 0 12px' }}>
        Upload WAV/MP3 3-30 giây, giọng rõ, không nhiễu
      </p>
      <input
        type="file"
        accept="audio/wav,audio/mp3,audio/mpeg,audio/x-wav"
        onChange={handleFileChange}
        disabled={isUploading || disabled}
      />
      {isUploading && <p style={{ margin: '8px 0 0', color: '#fd7e14' }}>⏳ Đang xử lý...</p>}
    </div>
  );
};

export default VoiceCloneUploader;