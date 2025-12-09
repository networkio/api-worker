// Cloudflare KV cache helpers for warm data.
export async function getKV(env, key) {
  if (!env?.STOCK_KV) return null;
  return await env.STOCK_KV.get(key, { type: "json" });
}

export async function setKV(env, key, value, ttlSec = 600) {
  if (!env?.STOCK_KV) return;
  await env.STOCK_KV.put(key, JSON.stringify(value), { expirationTtl: ttlSec });
}
