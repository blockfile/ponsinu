'use strict';

// ETH→USD price, cached so the dashboard can poll freely without hammering the source.
let cache = { value: null, at: 0 };
const TTL_MS = 60_000;

async function getEthPriceUsd() {
  const now = Date.now();
  if (cache.value !== null && now - cache.at < TTL_MS) return cache.value;
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      { signal: AbortSignal.timeout(5000) }
    );
    const j = await res.json();
    const px = j && j.ethereum && j.ethereum.usd;
    if (typeof px === 'number' && px > 0) {
      cache = { value: px, at: now };
      return px;
    }
  } catch (_err) {
    // fall through to stale/null
  }
  return cache.value; // last known price, or null if never fetched
}

/** Last fetched price without triggering a fetch (null until first fetch). */
function getCachedEthPriceUsd() {
  return cache.value;
}

/** Convert an ETH amount to USD (rounded to cents), or null if no price. */
function toUsd(eth, price) {
  if (eth == null || price == null) return null;
  return +(eth * price).toFixed(2);
}

/** Test helper — prime the cache so tests never hit the network. */
function _prime(value) {
  cache = { value, at: Date.now() };
}

module.exports = { getEthPriceUsd, getCachedEthPriceUsd, toUsd, _prime };
