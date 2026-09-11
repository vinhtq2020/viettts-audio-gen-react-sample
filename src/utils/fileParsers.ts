import * as pdfjsLib from "pdfjs-dist";
import mammoth from "mammoth";

pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

export interface ParsedPage {
  pageNum: number;
  text: string;
  charCount: number;
}

export interface ParsedDocument {
  title: string;
  pages: ParsedPage[];
  totalPages: number;
  batchSize: number;
}

const PAGE_SIZE = 3000;
const BATCH_SIZE = 10;

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function normalizeTextBreaks(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function countNewlines(text: string): number {
  return (text.match(/\n/g) || []).length;
}

function splitLongTextPreservingWords(text: string, maxLen: number): string[] {
  const parts: string[] = [];
  const tokens = text.split(/(\s+)/);
  let current = "";

  for (const token of tokens) {
    if (!token) continue;
    if (/\s+/.test(token)) {
      const candidate = current + token;
      if (candidate.length <= maxLen) {
        current = candidate;
      } else {
        if (current.trim()) parts.push(current.trimEnd());
        current = token;
      }
      continue;
    }

    if (token.length >= maxLen) {
      if (current.trim()) {
        parts.push(current.trimEnd());
        current = "";
      }
      let remainder = token;
      while (remainder.length > maxLen) {
        parts.push(remainder.slice(0, maxLen));
        remainder = remainder.slice(maxLen);
      }
      if (remainder) current = remainder;
      continue;
    }

    const candidate = current + token;
    if (candidate.length <= maxLen) {
      current = candidate;
    } else {
      if (current.trim()) parts.push(current.trimEnd());
      current = token;
    }
  }

  if (current.trim()) parts.push(current.trimEnd());
  return parts.filter((part) => part.length > 0);
}

function buildPagesPreservingLineBreaks(text: string): ParsedPage[] {
  const normalized = normalizeTextBreaks(text);
  if (!normalized) return [];

  const pages: ParsedPage[] = [];
  let pageNum = 1;
  const rawLines = normalized.split("\n");
  let currentBlock: string[] = [];

  const flushCurrentBlock = () => {
    if (currentBlock.length === 0) return;

    const blockText = currentBlock.join("\n");
    if (blockText) {
      pages.push({ pageNum, text: blockText, charCount: blockText.length });
      pageNum += 1;
    }
    currentBlock = [];
  };

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const nextCandidate = currentBlock.length === 0 ? line : `${currentBlock.join("\n")}\n${line}`;

    if (line === "") {
      currentBlock.push("");
      continue;
    }

    if (nextCandidate.length <= PAGE_SIZE) {
      currentBlock.push(line);
      continue;
    }

    if (currentBlock.length > 0) {
      flushCurrentBlock();
    }

    const chunks = splitLongTextPreservingWords(line, PAGE_SIZE);
    if (chunks.length === 0) continue;

    for (let j = 0; j < chunks.length; j++) {
      const chunk = chunks[j];
      const chunkCandidate = currentBlock.length === 0 ? chunk : `${currentBlock.join("\n")}\n${chunk}`;
      if (chunkCandidate.length > PAGE_SIZE && currentBlock.length > 0) {
        flushCurrentBlock();
      }
      currentBlock.push(chunk);
    }
  }

  flushCurrentBlock();
  return pages;
}

export async function parsePDF(file: File): Promise<ParsedDocument> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const pages: ParsedPage[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const text = reconstructPdfPageText(textContent.items as PdfTextItem[]);

    pages.push({ pageNum: i, text, charCount: text.length });

    if (i % 5 === 0) {
      await yieldToBrowser();
    }
  }

  return {
    title: file.name.replace(".pdf", ""),
    pages,
    totalPages: pdf.numPages,
    batchSize: BATCH_SIZE,
  };
}

interface PdfTextItem {
  str: string;
  transform: number[];
  height?: number;
}

/**
 * pdf.js KHÔNG cho biết trực tiếp đâu là ngắt dòng/ngắt đoạn trong PDF — chỉ trả
 * về từng mẩu text kèm toạ độ (transform[5] = vị trí Y trên trang). Phải tự suy ra:
 * - Y đổi 1 chút (~chiều cao 1 dòng) -> xuống dòng thường (nối bằng \n)
 * - Y đổi nhiều hơn hẳn (>1.5x chiều cao dòng, ví dụ cách đoạn/tiêu đề) -> ngắt đoạn (\n\n)
 * - Y gần như không đổi -> vẫn cùng 1 dòng (nối bằng dấu cách)
 * Nhờ vậy TTS sẽ có khoảng ngắt tự nhiên giữa các đoạn thay vì đọc dính liền cả trang.
 */
function reconstructPdfPageText(items: PdfTextItem[]): string {
  let text = "";
  let lastY: number | null = null;
  let lastHeight = 0;

  for (const item of items) {
    if (!item.str) continue;

    const currentY = item.transform?.[5] ?? null;
    const currentHeight = item.height || lastHeight;

    if (lastY !== null && currentY !== null) {
      const gap = Math.abs(currentY - lastY);
      const lineHeight = lastHeight || currentHeight || 1;

      if (gap > lineHeight * 0.4) {
        // Đổi dòng — khoảng cách lớn hơn hẳn 1 dòng thường thì coi là ngắt đoạn
        text += gap > lineHeight * 1.5 ? "\n\n" : "\n";
      } else if (text && !text.endsWith(" ")) {
        text += " ";
      }
    }

    text += item.str;
    lastY = currentY;
    if (currentHeight) lastHeight = currentHeight;
  }

  // Chuẩn hoá: chỉ gộp khoảng trắng NGANG thừa, tuyệt đối không đụng vào \n vừa dựng lại
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n");
}

export async function parseWord(file: File): Promise<ParsedDocument> {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  const rawText = normalizeTextBreaks(result.value);
  const fullText = rawText
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n");

  console.debug("[parseWord]", {
    file: file.name,
    rawNewlines: countNewlines(rawText),
    cleanedNewlines: countNewlines(fullText),
    preview: fullText.slice(0, 220),
  });

  const pages = buildPagesPreservingLineBreaks(fullText);

  return {
    title: file.name.replace(/\.(docx|doc)$/i, ""),
    pages,
    totalPages: pages.length,
    batchSize: BATCH_SIZE,
  };
}

export async function parseTXT(file: File): Promise<ParsedDocument> {
  const text = normalizeTextBreaks(await file.text());
  console.debug("[parseTXT]", {
    file: file.name,
    rawNewlines: countNewlines(text),
    preview: text.slice(0, 220),
  });

  const pages = buildPagesPreservingLineBreaks(text);

  return {
    title: file.name.replace(/\.(txt|md)$/i, ""),
    pages,
    totalPages: pages.length,
    batchSize: BATCH_SIZE,
  };
}

export async function parseDocument(file: File): Promise<ParsedDocument> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) return parsePDF(file);
  if (name.endsWith(".docx") || name.endsWith(".doc")) return parseWord(file);
  if (name.endsWith(".txt") || name.endsWith(".md")) return parseTXT(file);
  throw new Error("Định dạng không hỗ trợ. Chỉ: .pdf, .docx, .txt, .md");
}
