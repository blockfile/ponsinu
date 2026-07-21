'use strict';

const { JsonRpcProvider } = require('ethers');
const config = require('../config');

// The public Robinhood Chain RPC intermittently answers a perfectly valid
// eth_call with `-32601 Method not found` (load-balanced across heterogeneous
// nodes). Retry those transient JSON-RPC errors instead of letting a single
// blip fail a poll/cycle.
const TRANSIENT_CODES = new Set([-32601, -32603, -32005, -32000, -32603]);
const TRANSIENT_RE = /method not found|timeout|rate.?limit|temporar|try again|too many|busy|overloaded/i;

function isTransient(errObj) {
  if (!errObj) return false;
  if (TRANSIENT_CODES.has(errObj.code)) return true;
  return TRANSIENT_RE.test(String(errObj.message || ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RetryJsonRpcProvider extends JsonRpcProvider {
  async _send(payload) {
    let lastErr;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const resp = await super._send(payload);
        const arr = Array.isArray(resp) ? resp : [resp];
        if (arr.some((r) => r && r.error && isTransient(r.error)) && attempt < 4) {
          await sleep(300 * attempt);
          continue;
        }
        return resp;
      } catch (err) {
        lastErr = err;
        if (attempt < 4) {
          await sleep(300 * attempt);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }
}

// A single shared RPC provider. Pinning the chain id skips the eth_chainId
// round-trip; batchMaxCount:1 sends every call as its own request (some RH RPC
// nodes mishandle JSON-RPC batch arrays).
const provider = new RetryJsonRpcProvider(config.rpcUrl, config.chainId, {
  staticNetwork: true,
  batchMaxCount: 1,
});

const wallet = config.wallet.connect(provider);

function walletAddress() {
  return wallet.address;
}

module.exports = { provider, wallet, walletAddress };
