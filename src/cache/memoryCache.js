// In-memory TTL cache for hot data (Cloudflare runtime-local, per isolate).
const cache = new Map();

export function getCache(key) {
  const record = cache.get(key);
  if (!record) return null;
  if (Date.now() > record.expireAt) {
    cache.delete(key);
    return null;
  }
  return record.value;
}

export function setCache(key, value, ttlMs = 60_000) {
  cache.set(key, { value, expireAt: Date.now() + ttlMs });
}

export function deleteCache(key) {
  cache.delete(key);
}
