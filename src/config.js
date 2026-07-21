'use strict';

require('dotenv').config();

const { Wallet } = require('ethers');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function num(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const DRY_RUN = bool(process.env.DRY_RUN, true);

/**
 * Load the signing wallet (0x-prefixed hex private key). It MUST be the wallet
 * that DEPLOYED the token on ponsfamily.com — the locker only lets the token's
 * deployer (or its fee-redirect target) call collectFees, so any other wallet
 * cannot claim the creator fees. In DRY_RUN with no key configured, an
 * ephemeral wallet is generated so the server runs out of the box.
 */
function loadWallet() {
  const raw = process.env.WALLET_PRIVATE_KEY;
  if (!raw) {
    if (!DRY_RUN) {
      throw new Error('WALLET_PRIVATE_KEY is required when DRY_RUN=false');
    }
    return { wallet: Wallet.createRandom(), ephemeral: true };
  }
  try {
    const key = raw.trim().startsWith('0x') ? raw.trim() : `0x${raw.trim()}`;
    return { wallet: new Wallet(key), ephemeral: false };
  } catch (err) {
    throw new Error(`Could not parse WALLET_PRIVATE_KEY: ${err.message}`);
  }
}

const { wallet, ephemeral: walletIsEphemeral } = loadWallet();

const lowerOrNull = (v) => (v ? String(v).trim().toLowerCase() : null);

const config = {
  port: num(process.env.PORT, 3000),
  dryRun: DRY_RUN,

  // Robinhood Chain mainnet defaults.
  rpcUrl: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  chainId: num(process.env.CHAIN_ID, 4663),
  explorerApi: (process.env.EXPLORER_API || 'https://robinhoodchain.blockscout.com').replace(/\/$/, ''),

  wallet,
  walletIsEphemeral,

  // Pons launchpad infra (ponsfamily.com) on Robinhood Chain. A launch pairs the
  // token with WETH in a Uniswap V3 pool and locks the LP position in the
  // PonsLaunchLocker; the creator's share of the pool's trading fees is claimed
  // from the locker via collectFees(token). The pool + fee tier are read straight
  // off the token contract at runtime (see src/evm/pons.js).
  weth: lowerOrNull(process.env.WETH_ADDRESS) || '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  locker: lowerOrNull(process.env.LOCKER_ADDRESS) || '0x31ca5e101941a93a7dd6d0497928700625cf54b5',
  // Uniswap V3 SwapRouter02 on Robinhood Chain — the buy path (WETH → token).
  swapRouter: lowerOrNull(process.env.SWAP_ROUTER_ADDRESS) || '0xcaf681a66d020601342297493863e78c959e5cb2',

  // Your ponsfamily.com token. The creator share of its locked-LP trading fees
  // funds the cycle; the bot claims, buys the token back, and burns it.
  tokenAddress: lowerOrNull(process.env.TOKEN_ADDRESS),
  tokenSymbol: process.env.TOKEN_SYMBOL || 'TOKEN',

  // ── Claim → buyback → burn loop ──────────────────────────────────────────
  // Every POLL_SCHEDULE, claim the creator fees from the locker (WETH + tokens),
  // spend BURN_USD_PER_CYCLE worth of WETH buying the token, and burn what was
  // bought PLUS the token-side fees (send to DEAD_ADDRESS — gone forever).
  burnUsdPerCycle: num(process.env.BURN_USD_PER_CYCLE, 5), // USD spent buying + burning each cycle
  slippagePct: num(process.env.SLIPPAGE_PCT, 5), // V3 buy-swap slippage, percent
  gasReserveEth: num(process.env.GAS_RESERVE_ETH, 0.005), // native ETH floor for gas; topped up by unwrapping WETH
  // Skip the claim leg when the pending creator WETH is below this (saves gas on
  // dust claims); the claim always runs when it's needed to fund the buy.
  claimMinWeth: num(process.env.CLAIM_MIN_WETH, 0.0005),
  // Burn the token-side fees that arrive with each claim (default true) — LP fees
  // accrue in BOTH pool tokens, so the token half can be burned without a swap.
  burnClaimedTokens: bool(process.env.BURN_CLAIMED_TOKENS, true),
  // Burn sink for the bought tokens. Default is the canonical EVM dead address.
  deadAddress: lowerOrNull(process.env.DEAD_ADDRESS) || '0x000000000000000000000000000000000000dead',

  // Trigger — the scheduler ticks on this timer (default every 5 minutes) and
  // runs a cycle when wallet WETH + pending creator WETH covers at least
  // BURN_USD_PER_CYCLE; otherwise it waits for more fees to accrue.
  pollSchedule: process.env.POLL_SCHEDULE || '*/5 * * * *',
  // DRY_RUN only: simulated creator fees accrued per tick, so cycles have
  // something to claim and spend without real rewards.
  dryRunFeePerPoll: num(process.env.DRY_RUN_FEE_PER_POLL, 0.01), // WETH side
  dryRunTokenFeePerPoll: num(process.env.DRY_RUN_TOKEN_FEE_PER_POLL, 25000), // token side

  // DexScreener chain slug for /stats market data (graceful nulls until listed).
  dexscreenerChainId: process.env.DEXSCREENER_CHAIN_ID || 'robinhood',

  // Storage (MongoDB)
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  mongoDb: process.env.MONGODB_DB || 'ponsinu',

  // CORS allowlist (comma-separated). Default: localhost dev origins. Set to your
  // frontend domain(s) in production, or "*" to allow any origin.
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Secret protecting the POST control endpoints. Blank = open (dev); set in prod.
  apiKey: process.env.API_KEY || null,
};

module.exports = config;
