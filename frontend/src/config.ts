const API_KEY = "probe20.apiEndpoint";

/** Resolve backend API base URL: localStorage override, then Vite env. */
export function getApiEndpoint(): string {
  try {
    const saved = localStorage.getItem(API_KEY)?.trim();
    if (saved) return saved.replace(/\/$/, "");
  } catch {
    /* ignore */
  }
  return (import.meta.env.VITE_API_ENDPOINT || "").replace(/\/$/, "");
}

export function setApiEndpoint(url: string) {
  const cleaned = url.trim().replace(/\/$/, "");
  if (!cleaned) {
    localStorage.removeItem(API_KEY);
    return;
  }
  localStorage.setItem(API_KEY, cleaned);
}

export function clearApiEndpoint() {
  localStorage.removeItem(API_KEY);
}
