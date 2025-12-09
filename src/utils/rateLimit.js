import { jsonResponse } from "./response.js";

// Simple KV-backed rate limiter: limit requests per ip per windowSec.
export async function rateLimit(env, ip, limit = 60, windowSec = 60, scope = "global") {
  if (!env?.STOCK_KV || !ip) return { allowed: true };

  const key = `rl:${scope}:${ip}`;
  const current = await env.STOCK_KV.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= limit) {
    return {
      allowed: false,
      response: jsonResponse({ error: "Too Many Requests", scope }, 429)
    };
  }

  await env.STOCK_KV.put(key, String(count + 1), { expirationTtl: windowSec });
  return { allowed: true };
}
