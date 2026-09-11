import React, { useState } from "react";
import BookReaderApp from "./BookReaderApp"; // Đổi tên file cũ
import TextToSpeechPage from "./pages/TextToSpeechPage";
import { ToastProvider } from "./components/Toast";

const App: React.FC = () => {
  const [currentPage, setCurrentPage] = useState<"book" | "tts">("book");

  return (
    <ToastProvider>
      <div>
      {/* Navigation */}
      <nav
        style={{
          padding: "12px 24px",
          background: "#343a40",
          color: "#fff",
          display: "flex",
          gap: 20,
          alignItems: "center",
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 18 }}>📚 VieNeu-TTS</span>
        <button
          onClick={() => setCurrentPage("book")}
          style={{
            background: currentPage === "book" ? "#495057" : "transparent",
            color: "#fff",
            border: "none",
            padding: "6px 16px",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          📖 Đọc sách
        </button>
        <button
          onClick={() => setCurrentPage("tts")}
          style={{
            background: currentPage === "tts" ? "#495057" : "transparent",
            color: "#fff",
            border: "none",
            padding: "6px 16px",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          📝 Text to Speech
        </button>
      </nav>

      {/* Page Content */}
      {currentPage === "book" ? <BookReaderApp /> : <TextToSpeechPage />}
      </div>
    </ToastProvider>
  );
};

export default App;
