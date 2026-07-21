'use strict';

const { toUsd } = require('../evm/price');
const config = require('../config');

const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL || 'TOKEN';

// The cycle emits these step types: claim, buy, burn (+ error). Map a stored
// step to the activity-row shape the dashboard renders.
function toActivityRow(s, price) {
  const d = s.detail || {};
  let type;
  let amountEth = null;
  let tokens = null;
  let status = 'Completed';

  switch (s.name) {
    case 'claim':
      type = 'Auto Claim';
      amountEth = d.ethClaimed ?? null;
      status = 'Claimed';
      break;
    case 'buy':
      type = 'Buy';
      amountEth = d.ethSpent ?? null;
      tokens = d.tokensBought ?? null;
      break;
    case 'burn':
      type = 'Burn';
      tokens = d.tokensBurned ?? null;
      status = 'Burned';
      break;
    default:
      type = s.name;
  }
  if (s.status === 'failed') status = 'Failed';

  return {
    id: s.id ?? null,
    cycleId: s.cycle_id,
    type,
    rawType: s.name,
    amountEth,
    usdValue: toUsd(amountEth, price),
    tokens,
    status,
    txHash: s.signature ?? null,
    at: s.created_at,
  };
}

// ── Public (frontend-facing) shapes ──────────────────────────────────────────

// rawType (stored step name) -> the frontend's lowercase activity enum.
const PUBLIC_TYPE = {
  claim: 'claim',
  buy: 'buy',
  burn: 'burn',
};

// Map a stored step to the ActivityRow shape the frontend table renders.
// Caller passes steps newest-first (repo.getAllSteps already sorts desc).
function toPublicActivityRow(s, price) {
  const d = s.detail || {};

  let amountEth = null;
  let tokens = null;
  let status = 'completed';
  switch (s.name) {
    case 'claim':
      amountEth = d.ethClaimed ?? null;
      status = 'claimed';
      break;
    case 'buy':
      amountEth = d.ethSpent ?? null;
      tokens = d.tokensBought ?? null;
      break;
    case 'burn':
      tokens = d.tokensBurned ?? null;
      status = 'burned';
      break;
    default:
      break;
  }
  if (s.status === 'failed') status = 'failed';

  return {
    id: s.id != null ? String(s.id) : s.signature ?? null,
    type: PUBLIC_TYPE[s.name] ?? s.name,
    amountEth,
    // usdtValue MUST be a number — the frontend table calls .toLocaleString()
    // on it with no null guard.
    usdtValue: toUsd(amountEth, price) ?? 0,
    tokens,
    status,
    txHash: s.signature ?? null,
    timestamp: Date.parse(s.created_at) || null, // ISO -> epoch ms
  };
}

// Map the backend aggregates to the frontend's flat /stats object. tokenInLp and
// marketCap have no backend source until the token is listed -> null.
// The hero (SoftieClone) reads exactly: { marketCap, totalBurned, buybackEth,
// buybackTarget } — keep those four stable; the rest is extra detail.
function toPublicStats({ stats, unclaimedEth, operatingWallet, market = {} }) {
  return {
    tokenInLp: market.tokenInLp ?? null, // tokens in the LP (DexScreener); null until listed
    marketCap: market.marketCap ?? null, // USD market cap (DexScreener); null until listed
    totalBurned: stats.total_tokens_burned || 0, // hero "Total Burned" card
    // Progress toward the next burn: WETH in the wallet + creator fees pending
    // in the locker, vs the per-cycle trigger (0.01 ETH). Frontend renders
    // buybackEth / buybackTarget as the "Next buyback & burn" bar.
    buybackEth: unclaimedEth == null ? 0 : +unclaimedEth.toFixed(9),
    buybackTarget: config.burnEthPerCycle > 0 ? config.burnEthPerCycle : null,
    unclaimedFeesEth: unclaimedEth == null ? null : +unclaimedEth.toFixed(9),
    totalCreatorFeesClaimed: stats.total_eth_claimed,
    // ETH spent buying the token, and how much of it has been burned.
    ethSpentBuying: +(stats.total_eth_spent_buy || 0).toFixed(9),
    tokensBought: stats.total_tokens_bought || 0,
    tokensBurned: stats.total_tokens_burned || 0,
    burns: stats.burns || 0,
    // The signer that performs claim/buy/burn.
    operatingWallet: operatingWallet ?? null,
  };
}

// The rewards-available card payload (used by /api/unclaimed and the SSE stream).
// `unclaimedEth` is now the spendable ETH rewards in the wallet, waiting to be
// spent on the next buyback; the claimThreshold* fields carry the per-cycle burn
// size (ETH-denominated by default; USD when BURN_ETH_PER_CYCLE=0).
function buildUnclaimedPayload(eth, price) {
  const ethMode = config.burnEthPerCycle > 0;
  return {
    unclaimedEth: eth == null ? null : +eth.toFixed(9),
    unclaimedUsd: toUsd(eth, price),
    ethPriceUsd: price,
    claimThresholdEth: ethMode ? config.burnEthPerCycle : null,
    claimThresholdUsd: ethMode ? toUsd(config.burnEthPerCycle, price) : config.burnUsdPerCycle,
  };
}

// Headline numbers for the frontend hero.
function toPublicSummary({ stats, price, marketCapUsd = null }) {
  const claimedEth = stats.total_eth_claimed || 0;
  const buyEth = stats.total_eth_spent_buy || 0;
  return {
    creatorFeesClaimedEth: claimedEth,
    creatorFeesClaimedUsd: +(claimedEth * (price || 0)).toFixed(2),
    marketCapUsd: marketCapUsd ?? null,
    // buyback-and-burn totals funded from fees
    ethSpentBuying: +buyEth.toFixed(9),
    ethSpentBuyingUsd: +(buyEth * (price || 0)).toFixed(2),
    tokensBought: stats.total_tokens_bought || 0,
    tokensBurned: stats.total_tokens_burned || 0,
    burns: stats.burns || 0,
    cycles: stats.completed || 0,
  };
}

module.exports = {
  toActivityRow,
  toPublicActivityRow,
  toPublicStats,
  toPublicSummary,
  buildUnclaimedPayload,
  TOKEN_SYMBOL,
};
