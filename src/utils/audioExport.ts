export async function mergeWavBlobs(
  blobs: Blob[],
  pausesAfterMs: number[] = [],
): Promise<Blob> {
  if (blobs.length === 0) throw new Error("Không có audio");
  if (blobs.length === 1 && !pausesAfterMs.some((ms) => ms > 0)) return blobs[0];

  const buffers = await Promise.all(blobs.map((b) => b.arrayBuffer()));
  const firstView = new DataView(buffers[0]);

  // VieNeu-TTS trả WAV PCM chuẩn. Giữ nguyên format của chunk đầu tiên.
  const sampleRate = firstView.getUint32(24, true);
  const numChannels = firstView.getUint16(22, true);
  const bitsPerSample = firstView.getUint16(34, true);
  const blockAlign = firstView.getUint16(32, true);
  const byteRate = sampleRate * blockAlign;

  const pauseBytes = (pauseMs: number) => {
    if (!pauseMs) return 0;
    const samples = Math.round((sampleRate * pauseMs) / 1000);
    return samples * blockAlign;
  };

  const pauseSizes = buffers.map((_, index) => {
    // Không cần silence sau chunk cuối cùng.
    if (index === buffers.length - 1) return 0;
    return pauseBytes(Math.max(0, pausesAfterMs[index] || 0));
  });

  const pcmSizes = buffers.map((buf) => Math.max(0, buf.byteLength - 44));
  const dataSize = pcmSizes.reduce((sum, size) => sum + size, 0)
    + pauseSizes.reduce((sum, size) => sum + size, 0);
  const totalSize = 44 + dataSize;

  const merged = new ArrayBuffer(totalSize);
  const mergedView = new DataView(merged);
  const mergedBytes = new Uint8Array(merged);
  const encoder = new TextEncoder();

  mergedBytes.set(encoder.encode("RIFF"), 0);
  mergedView.setUint32(4, totalSize - 8, true);
  mergedBytes.set(encoder.encode("WAVE"), 8);
  mergedBytes.set(encoder.encode("fmt "), 12);
  mergedView.setUint32(16, 16, true);
  mergedView.setUint16(20, 1, true);
  mergedView.setUint16(22, numChannels, true);
  mergedView.setUint32(24, sampleRate, true);
  mergedView.setUint32(28, byteRate, true);
  mergedView.setUint16(32, blockAlign, true);
  mergedView.setUint16(34, bitsPerSample, true);
  mergedBytes.set(encoder.encode("data"), 36);
  mergedView.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < buffers.length; i++) {
    const pcm = new Uint8Array(buffers[i], 44);
    mergedBytes.set(pcm, offset);
    offset += pcm.byteLength;

    const silence = pauseSizes[i];
    if (silence > 0) {
      // PCM silence = zero samples.
      mergedBytes.fill(0, offset, offset + silence);
      offset += silence;
    }
  }

  return new Blob([merged], { type: "audio/wav" });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
