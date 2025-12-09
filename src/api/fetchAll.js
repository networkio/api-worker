import { fetchStock } from "./fetchStock.js";
import { fetchCrypto } from "./fetchCrypto.js";
import { fetchForex } from "./fetchForex.js";

export async function fetchAll(env, query) {
  const result = {};

  if (query.symbol) {
    result.stock = await fetchStock(query.symbol, env);
  }

  if (query.crypto) {
    result.crypto = await fetchCrypto(query.crypto);
  }

  if (query.forex) {
    result.forex = await fetchForex(query.forex, env);
  }

  return result;
}
