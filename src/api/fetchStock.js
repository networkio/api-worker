// Fetch stock quote data; endpoint can be overridden via env.STOCK_API_URL.
export async function fetchStock(symbol, env) {
  if (!symbol) throw new Error("Missing stock symbol");
  const base = env?.STOCK_API_URL || "https://free.stockai.trade/api/stock";
  const url = `${base}?symbol=${encodeURIComponent(symbol)}`;

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stock API error (${res.status}): ${text}`);
  }
  return await res.json();
}
