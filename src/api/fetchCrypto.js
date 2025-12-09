// Fetch crypto price from Binance public API by symbol (e.g., BTCUSDT).
export async function fetchCrypto(symbol) {
  if (!symbol) throw new Error("Missing crypto symbol");
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Crypto API error (${res.status}): ${text}`);
  }
  return await res.json();
}
