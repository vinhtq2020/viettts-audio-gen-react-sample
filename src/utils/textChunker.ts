export interface TextChunk {
  text: string;
  /** Khoảng lặng sau chunk, tính bằng milliseconds. */
  pauseAfterMs: number;
}

const PAUSE = {
  sentence: 180,
  lineBreak: 350,
  paragraph: 750,
  scene: 1200,
};

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[\n\t ]+|[\n\t ]+$/g, "");
}

function splitLongText(text: string, maxLength: number): string[] {
  const result: string[] = [];
  let remaining = text.replace(/[ \t]+$/g, "");

  while (remaining.length > maxLength) {
    let cutAt = remaining.lastIndexOf(" ", maxLength);
    if (cutAt < Math.floor(maxLength * 0.55)) cutAt = maxLength;

    const part = remaining.slice(0, cutAt).replace(/[ \t]+$/g, "");
    if (part) result.push(part);
    remaining = remaining.slice(cutAt).replace(/^[ \t]+/g, "");
  }

  if (remaining) result.push(remaining.replace(/[ \t]+$/g, ""));
  return result;
}

function splitParagraphIntoSentences(paragraph: string): string[] {
  // Giữ cả dấu câu trong câu. Ngoài .!? còn hỗ trợ … và các dấu đóng ngoặc.
  const sentences = paragraph
    .replace(/([.!?…]+[”’"')\]]*)\s+/g, "$1\u0000")
    .split("\u0000")
    .map((s) => s.trim())
    .filter(Boolean);

  return sentences.length > 0 ? sentences : [paragraph.trim()];
}

/**
 * Chia văn bản thành các request TTS nhưng KHÔNG làm mất cấu trúc đoạn.
 *
 * - Câu trong cùng request: để model tự xử lý nhịp theo dấu câu.
 * - Xuống dòng đơn: thêm khoảng nghỉ ngắn.
 * - Xuống dòng kép (đoạn mới): thêm khoảng nghỉ dài.
 * - Nhiều dòng trống (scene break): thêm khoảng nghỉ rất dài.
 */
export function chunkText(text: string, maxLength: number = 500): TextChunk[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const blocks = normalized.split(/(\n+)/);
  const chunks: TextChunk[] = [];
  let current = "";
  let pendingPause = PAUSE.sentence;

  const flushCurrent = (pauseAfterMs: number) => {
    if (!current.replace(/[ \t\n]+/g, "")) return;
    chunks.push({ text: current.replace(/[ \t]+$/g, ""), pauseAfterMs });
    current = "";
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    if (/^\n+$/.test(block)) {
      const newlineCount = block.length;
      const pause = newlineCount >= 3
        ? PAUSE.scene
        : newlineCount === 2
          ? PAUSE.paragraph
          : PAUSE.lineBreak;

      current = current ? `${current}${block}` : block;
      pendingPause = pause;
      continue;
    }

    const sentences = splitParagraphIntoSentences(block);

    for (const sentence of sentences) {
      const separator = current && !current.endsWith("\n") && !current.endsWith(" ") ? " " : "";
      const candidate = current ? `${current}${separator}${sentence}` : sentence;

      if (candidate.length <= maxLength) {
        current = candidate;
        pendingPause = PAUSE.sentence;
        continue;
      }

      if (current) {
        flushCurrent(pendingPause);
      }

      const pieces = splitLongText(sentence, maxLength);
      for (let j = 0; j < pieces.length - 1; j++) {
        chunks.push({ text: pieces[j], pauseAfterMs: PAUSE.sentence });
      }
      current = pieces[pieces.length - 1] || "";
      pendingPause = PAUSE.sentence;
    }
  }

  if (current) {
    // Không thêm khoảng lặng vào cuối toàn bộ văn bản.
    chunks.push({ text: current.replace(/[ \t]+$/g, ""), pauseAfterMs: 0 });
  }

  return chunks;
}

/** Dùng cho phần highlight/progress nơi chỉ cần chuỗi text. */
export function chunkTextStrings(text: string, maxLength: number = 500): string[] {
  return chunkText(text, maxLength).map((chunk) => chunk.text);
}
