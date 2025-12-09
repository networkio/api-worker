// Fetch forex rate using exchangerate.host (free, no key) or override via env.FOREX_API_URL.
export async function fetchForex(pair, env) {
  if (!pair) throw new Error("Missing forex pair");
  const [from, to] = pair.includes("/")
    ? pair.split("/")
    : [pair.slice(0, 3), pair.slice(3)];

  const base = env?.FOREX_API_URL || "https://api.exchangerate.host/convert";
  const url = `${base}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Forex API error (${res.status}): ${text}`);
  }
  return await res.json();
}
