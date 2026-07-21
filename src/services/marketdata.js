'use strict';

// Live market data (market cap + tokens-in-LP) for the configured token, pulled
// from DexScreener's public API and cached. Powers the /stats fields tokenInLp
// and marketCap. Returns nulls (not an error) when the token isn't listed yet or
// the API is unreachable, so /stats never breaks. The chain slug is configurable
// (DEXSCREENER_CHAIN_ID) since newly-supported chains get their slug over time.

const config = require('../config');

const TTL_MS = 30_000;
const EMPTY = { tokenInLp: null, marketCap: null, priceUsd: null };
let cache = { value: EMPTY, at: 0 };

async function fetchDexScreener(token) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${token}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`dexscreener HTTP ${res.status}`);
  const data = await res.json();
  const pairs = Array.isArray(data.pairs) ? data.pairs : [];

  // Pairs on our chain where our token is the base side; pick the deepest liquidity.
  const ours = pairs
    .filter(
      (p) =>
        p.chainId === config.dexscreenerChainId &&
        p.baseToken &&
        p.baseToken.address &&
        p.baseToken.address.toLowerCase() === token
    )
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));

  const p = ours[0];
  if (!p) return EMPTY;
  return {
    tokenInLp: p.liquidity && p.liquidity.base != null ? Number(p.liquidity.base) : null, // token count in pool
    marketCap: p.marketCap != null ? Number(p.marketCap) : p.fdv != null ? Number(p.fdv) : null, // USD
    priceUsd: p.priceUsd != null ? Number(p.priceUsd) : null,
  };
}

// Cached read; refreshes at most every TTL_MS. Keeps the last good value on error.
async function getMarketData() {
  if (!config.tokenAddress) return EMPTY;
  const now = Date.now();
  if (now - cache.at < TTL_MS && cache.at !== 0) return cache.value;
  try {
    cache = { value: await fetchDexScreener(config.tokenAddress), at: now };
  } catch (_err) {
    cache = { value: cache.value, at: now }; // keep last value; don't break /stats
  }
  return cache.value;
}

module.exports = { getMarketData };
