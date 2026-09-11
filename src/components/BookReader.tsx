import React from "react";

interface BookReaderProps {
  text: string;
  currentIndex: number;
  onParagraphClick: (index: number) => void;
}

const BookReader: React.FC<BookReaderProps> = ({
  text,
  currentIndex,
  onParagraphClick,
}) => {
  // Tách đoạn đơn giản theo xuống dòng
  const paragraphs = text.split(/\n+/).filter((p) => p.trim());

  return (
    <div className="book-reader" style={{ lineHeight: 1.8, fontSize: 16 }}>
      {paragraphs.map((paragraph, idx) => (
        <p
          key={idx}
          onClick={() => onParagraphClick(idx)}
          style={{
            cursor: "pointer",
            padding: "10px 12px",
            borderRadius: 6,
            margin: "4px 0",
            backgroundColor: idx === currentIndex ? "#fff3cd" : "transparent",
            borderLeft:
              idx === currentIndex
                ? "4px solid #ffc107"
                : "4px solid transparent",
            transition: "all 0.2s ease",
          }}
        >
          {paragraph}
        </p>
      ))}
    </div>
  );
};

export default BookReader;
