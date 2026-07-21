'use strict';

// In-memory simulated creator-fee state, used ONLY in DRY_RUN so the timer can
// be exercised and tested without real funds. It stands in for the locked LP
// position's fee accrual (pending, in the locker) and the wallet's claimed
// balances. LP fees accrue in BOTH pool tokens, so both sides are tracked.
// Live mode never touches this — real fees live on-chain.
const state = {
  pendingWeth: 0, // creator WETH share accrued in the locker, not yet claimed
  pendingTokens: 0, // creator token share accrued in the locker, not yet claimed
  walletWeth: 0, // claimed WETH sitting in the wallet
  walletTokens: 0, // claimed tokens sitting in the wallet (awaiting burn)
};

// Accrue one poll's worth of simulated LP fees into the (simulated) locker.
function accrue(wethRate, tokenRate) {
  state.pendingWeth += Number(wethRate) || 0;
  state.pendingTokens += Number(tokenRate) || 0;
  return peek();
}

// Current simulated state, WITHOUT mutating it.
function peek() {
  return { ...state };
}

// Claim: move all pending fees from the locker into the wallet. Returns what
// was claimed, mirroring collectFees.
function claim() {
  const claimed = { weth: state.pendingWeth, tokens: state.pendingTokens };
  state.walletWeth += state.pendingWeth;
  state.walletTokens += state.pendingTokens;
  state.pendingWeth = 0;
  state.pendingTokens = 0;
  return claimed;
}

// Spend `weth` of the wallet's claimed WETH (a buy), flooring at 0.
function spendWeth(weth) {
  state.walletWeth = Math.max(0, state.walletWeth - (Number(weth) || 0));
  return state.walletWeth;
}

// Remove the wallet's claimed tokens (a burn): return the amount and reset to 0.
function takeTokens() {
  const tokens = state.walletTokens;
  state.walletTokens = 0;
  return tokens;
}

// Test helper — force the state to known values.
function reset(values = {}) {
  state.pendingWeth = Number(values.pendingWeth) || 0;
  state.pendingTokens = Number(values.pendingTokens) || 0;
  state.walletWeth = Number(values.walletWeth) || 0;
  state.walletTokens = Number(values.walletTokens) || 0;
  return peek();
}

module.exports = { accrue, peek, claim, spendWeth, takeTokens, reset };
