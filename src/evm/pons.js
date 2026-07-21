'use strict';

// Pons launchpad (ponsfamily.com) infra discovery + creator-fee handling, for
// the claim → buyback → burn loop.
//
// A ponsfamily launch mints a fixed-supply ERC-20 straight into a Uniswap V3
// pool (paired with WETH) and locks the LP position in the PonsLaunchLocker.
// The pool's trading fees accrue to that locked position in BOTH tokens, and
// the token's DEPLOYER claims the creator share (locker keeps a protocol cut,
// 10% at deployment) by calling collectFees(token) on the locker. The claimed
// fees land in the deployer wallet as WETH + the token itself.
//
// Everything the bot needs (pool, fee tier, pair token) is read straight off
// TOKEN_ADDRESS, so pointing it at any ponsfamily token is enough.

const { Contract, formatEther, formatUnits } = require('ethers');
const config = require('../config');
const { provider, wallet } = require('./provider');
const { getDecimals, readTokenBalance, wethContract } = require('./erc20');
const simvault = require('./simvault');

// Getters the PonsLauncherToken exposes for its launch wiring (all immutable).
const PONS_TOKEN_ABI = [
  'function launchFactory() view returns (address)',
  'function dexFactory() view returns (address)',
  'function positionManager() view returns (address)',
  'function pairToken() view returns (address)',
  'function poolFee() view returns (uint24)',
  'function liquidityPool() view returns (address)',
  'function deployer() view returns (address)',
  'function restrictionEndBlock() view returns (uint256)',
  'function symbol() view returns (string)',
];

const LOCKER_ABI = [
  'function collectFees(address token) returns (uint256 amount0, uint256 amount1)',
  'function feeRedirects(address token) view returns (address)',
  'function protocolFeeShare() view returns (uint256)',
  'function tokenProtocolFeeShares(address token) view returns (uint256)',
];

// PonsLaunchFactory — only used to discover which locker holds the launch LP.
const FACTORY_ABI = ['function locker() view returns (address)'];

const POOL_ABI = [
  'function token0() view returns (address)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

// Cache the discovered launch wiring per token — these values are immutable for
// a given deployment, so one read per process is enough.
let infoCache = null;

/**
 * Resolve the launch wiring for `token`: its V3 pool, fee tier, pair token
 * (WETH), deployer, the LOCKER that holds the LP (read from the token's own
 * launchFactory().locker() unless LOCKER_ADDRESS overrides it), and whether
 * WETH is token0 in the pool (needed to map the locker's (amount0, amount1)
 * fee split). Live mode only.
 * @returns {Promise<{token, pool, poolFee, pairToken, deployer, locker, restrictionEndBlock, wethIsToken0}>}
 */
async function getLaunchInfo(token = config.tokenAddress) {
  if (!token) throw new Error('TOKEN_ADDRESS is required');
  const key = String(token).toLowerCase();
  if (infoCache && infoCache.token === key) return infoCache;

  const t = new Contract(token, PONS_TOKEN_ABI, provider);
  // Discovery reads can hit transient public-RPC errors (e.g. -32601). Retry a
  // few times; on success we cache and never read these again.
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const [pool, poolFee, pairToken, deployer, launchFactory, restrictionEndBlock] = await Promise.all([
        t.liquidityPool(),
        t.poolFee(),
        t.pairToken(),
        t.deployer(),
        t.launchFactory(),
        t.restrictionEndBlock().catch(() => null),
      ]);
      if (!pool || pool === '0x0000000000000000000000000000000000000000') {
        throw new Error(`token ${token} has no V3 pool yet (liquidityPool() is zero)`);
      }
      // The locker moves between factory deployments — never trust a hardcoded
      // address unless the operator explicitly overrides it.
      let locker = config.locker;
      if (!locker) {
        locker = String(
          await new Contract(launchFactory, FACTORY_ABI, provider).locker()
        ).toLowerCase();
        console.log(`[pons] locker auto-discovered from factory ${launchFactory}: ${locker}`);
      }
      const token0 = await new Contract(pool, POOL_ABI, provider).token0();
      infoCache = {
        token: key,
        pool: String(pool).toLowerCase(),
        poolFee: Number(poolFee),
        pairToken: String(pairToken).toLowerCase(),
        deployer: String(deployer).toLowerCase(),
        locker,
        restrictionEndBlock: restrictionEndBlock == null ? null : Number(restrictionEndBlock),
        wethIsToken0: String(token0).toLowerCase() === String(pairToken).toLowerCase(),
      };
      return infoCache;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

/**
 * The locker to claim from: LOCKER_ADDRESS override, else the address
 * discovered by getLaunchInfo() — which must have run first (every live caller
 * does; this throws loudly rather than claiming against the wrong contract).
 */
function lockerContract(signer = null) {
  const address = config.locker || (infoCache && infoCache.locker);
  if (!address) throw new Error('locker unknown — call getLaunchInfo() first (or set LOCKER_ADDRESS)');
  return new Contract(address, LOCKER_ABI, signer || provider);
}

// The locker's protocol cut for our token, percent (the creator receives the
// remaining 100 - share). Cached per process; falls back to 10 (the value at
// deployment) if the read fails.
let protocolSharePctCache = null;
async function getProtocolFeeSharePct() {
  if (protocolSharePctCache != null) return protocolSharePctCache;
  try {
    const share = Number(await lockerContract().tokenProtocolFeeShares(config.tokenAddress));
    protocolSharePctCache = Number.isFinite(share) && share >= 0 && share <= 100 ? share : 10;
  } catch (_err) {
    protocolSharePctCache = 10;
  }
  return protocolSharePctCache;
}

/**
 * The creator fees currently pending in the locker for our token, WITHOUT
 * claiming them: a static call of collectFees from the wallet. Reverts from
 * unauthorized wallets — reported as { authorized: false } so callers can
 * surface "this wallet is not the token's deployer" loudly instead of silently
 * showing 0 forever.
 * @returns {Promise<{weth:number, tokens:number, authorized:boolean, error?:string}>}
 */
async function getPendingCreatorFees() {
  if (config.dryRun) {
    const s = simvault.peek();
    return { weth: s.pendingWeth, tokens: s.pendingTokens, authorized: true };
  }
  const info = await getLaunchInfo();
  try {
    const [amount0, amount1] = await lockerContract().collectFees.staticCall(config.tokenAddress, {
      from: wallet.address,
    });
    const [wethRaw, tokensRaw] = info.wethIsToken0 ? [amount0, amount1] : [amount1, amount0];
    // collectFees pulls the position's fees and keeps the locker's protocol cut
    // before paying the creator, so haircut the estimate to the creator share.
    // Conservative either way: if the return were already net, we'd merely
    // undercount ~10% and wait one extra tick before spending.
    const protocolPct = await getProtocolFeeSharePct();
    const creatorShare = (raw) => (BigInt(raw) * BigInt(Math.round((100 - protocolPct) * 100))) / 10000n;
    const decimals = await getDecimals(config.tokenAddress);
    return {
      weth: Number(formatEther(creatorShare(wethRaw))),
      tokens: Number(formatUnits(creatorShare(tokensRaw), decimals)),
      authorized: true,
    };
  } catch (err) {
    // Zero-fee claims may also revert on some locker builds; treat a revert as
    // "nothing claimable now" but flag it so preflight can tell authorization
    // failures (persistent) from empty-fee reverts (transient).
    return { weth: 0, tokens: 0, authorized: false, error: err.shortMessage || err.message };
  }
}

/**
 * Claim the creator fees: locker.collectFees(token), sent by the wallet (which
 * must be the token's deployer). What actually landed is measured via WETH +
 * token balance deltas — robust against fee redirects and return-order drift.
 * @returns {Promise<{signature, wethClaimed, tokensClaimed, tokensClaimedRaw, simulated}>}
 */
async function collectCreatorFees() {
  if (config.dryRun) {
    const claimed = simvault.claim();
    return {
      signature: `claim_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
      wethClaimed: claimed.weth,
      tokensClaimed: claimed.tokens,
      tokensClaimedRaw: (BigInt(Math.round(claimed.tokens)) * 10n ** 18n).toString(),
      simulated: true,
    };
  }

  const token = config.tokenAddress;
  await getLaunchInfo(); // resolves the locker (auto-discovery) before claiming
  const decimals = await getDecimals(token);
  const weth = wethContract();
  const [wethBefore, tokensBefore] = await Promise.all([
    weth.balanceOf(wallet.address),
    readTokenBalance(token, wallet.address),
  ]);

  const tx = await lockerContract(wallet).collectFees(token);
  await tx.wait();

  const [wethAfter, tokensAfter] = await Promise.all([
    weth.balanceOf(wallet.address),
    readTokenBalance(token, wallet.address),
  ]);
  const wethDelta = wethAfter - wethBefore;
  const tokensDelta = tokensAfter - tokensBefore;
  console.log(
    `[tx] collectFees: +${formatEther(wethDelta)} WETH, +${formatUnits(tokensDelta, decimals)} tokens: ${tx.hash}`
  );
  return {
    signature: tx.hash,
    wethClaimed: Number(formatEther(wethDelta)),
    tokensClaimed: Number(formatUnits(tokensDelta, decimals)),
    tokensClaimedRaw: tokensDelta.toString(),
    simulated: false,
  };
}

/**
 * The wallet's claimed-but-unspent WETH (the buy fuel already in hand).
 * @returns {Promise<number>} WETH in ETH units
 */
async function getWalletWeth() {
  if (config.dryRun) return simvault.peek().walletWeth;
  const bal = await wethContract().balanceOf(wallet.address);
  return Number(formatEther(bal));
}

/**
 * Total ETH-denominated fuel available to the loop: WETH already in the wallet
 * plus the creator WETH share still pending in the locker. This gates the
 * timer and feeds the "unclaimed fees" card.
 * @returns {Promise<number>}
 */
async function getClaimableEth() {
  const [pending, walletWeth] = await Promise.all([getPendingCreatorFees(), getWalletWeth()]);
  return walletWeth + pending.weth;
}

/**
 * Advance the simulated fee accrual by one poll's worth. DRY_RUN only — in
 * live mode fees accrue on-chain in the locked LP position, so this is a
 * no-op. Called once per scheduler poll so cycles have something to claim.
 */
function simulateFeeAccrual() {
  if (config.dryRun) simvault.accrue(config.dryRunFeePerPoll, config.dryRunTokenFeePerPoll);
}

module.exports = {
  PONS_TOKEN_ABI,
  LOCKER_ABI,
  POOL_ABI,
  getLaunchInfo,
  lockerContract,
  getProtocolFeeSharePct,
  getPendingCreatorFees,
  collectCreatorFees,
  getWalletWeth,
  getClaimableEth,
  simulateFeeAccrual,
};
