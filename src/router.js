// Lightweight router to classify requests.
export function matchRoute(url) {
  if (url.pathname === "/") return "ui";
  if (url.pathname.startsWith("/v1/")) return "openai";
  if (url.pathname.startsWith("/api/")) return "data";
  if (url.pathname === "/health") return "health";
  return "not_found";
}
