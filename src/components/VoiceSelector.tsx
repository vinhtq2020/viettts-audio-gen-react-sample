import React from 'react';

interface Voice {
  id: string;
  name: string;
  type?: 'preset' | 'cloned';
}

interface VoiceSelectorProps {
  voices: Voice[];
  clonedVoices: Voice[];
  voice: string;
  onChange: (voiceId: string) => void;
  disabled?: boolean;
}

const VoiceSelector: React.FC<VoiceSelectorProps> = ({ voices, clonedVoices, voice, onChange, disabled = false }) => {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <label>🎙️ Giọng đọc:</label>
      <select
        value={voice}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        style={{ padding: '4px 8px', borderRadius: 4, minWidth: 180 }}
      >
        <optgroup label="Giọng có sẵn">
          {voices.map(v => (
            <option key={v.id} value={v.id}>{v.name}</option>
          ))}
        </optgroup>
        {clonedVoices.length > 0 && (
          <optgroup label="Giọng đã clone">
            {clonedVoices.map(v => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  );
};

export default VoiceSelector;