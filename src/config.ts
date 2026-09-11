// Cấu hình API tập trung cho toàn bộ app.
// Production/build nên cung cấp VITE_API_URL qua biến môi trường Vite.
// Fallback localhost giúp app vẫn render được khi chạy local mà chưa tạo .env.local.
const configuredApiUrl = (import.meta.env.VITE_API_URL as string | undefined)?.trim();

export const API_URL = (configuredApiUrl || "http://localhost:8000").replace(/\/$/, "");
