'use strict';

// Shared, cached read of the live unclaimed creator-fee balance so /api/unclaimed
// and /api/status don't each hit the RPC on every request.
const { getClaimableEth } = require('../evm/pons');

let cache = { value: null, at: 0 };
const TTL_MS = 20_000;

async function getUnclaimedEth() {
  const now = Date.now();
  if (cache.value !== null && now - cache.at < TTL_MS) {
    return { eth: cache.value, at: cache.at, fresh: false };
  }
  const eth = await getClaimableEth();
  cache = { value: eth, at: now };
  return { eth, at: now, fresh: true };
}

module.exports = { getUnclaimedEth };
