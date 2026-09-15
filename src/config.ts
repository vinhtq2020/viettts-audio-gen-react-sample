// Cấu hình API tập trung cho toàn bộ app.
// Production/build nên cung cấp VITE_API_URL qua biến môi trường Vite.
// Same-origin fallback avoids CORS when Vite proxies /api to the local backend.
const configuredApiUrl = (import.meta.env.VITE_API_URL as string | undefined)?.trim();

export const API_URL = (configuredApiUrl || "/api").replace(/\/$/, "");
