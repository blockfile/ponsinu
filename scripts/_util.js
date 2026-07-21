'use strict';

// Shared helpers for the live test scripts.
require('dotenv').config();

const config = require('../src/config');
const { provider, wallet } = require('../src/evm/provider');

function hr(title) {
  console.log(`\n=== ${title} ===`);
}

function eth(wei) {
  return Number(wei) / 1e18;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

/** First non-flag CLI arg (e.g. an amount or an address), or undefined. */
function arg(index = 0) {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  return positional[index];
}

/**
 * Gate a mutating action behind --confirm. Without it, prints a preview and
 * returns false. With it, returns true (and pauses 3s first if this is a REAL
 * live send, so you can Ctrl+C).
 */
async function requireConfirm(actionDesc) {
  if (!hasFlag('--confirm')) {
    console.log(`\n[preview only] would: ${actionDesc}`);
    console.log(
      `Re-run with --confirm to execute. ${
        config.dryRun
          ? '(DRY_RUN=true → simulated, no funds touched)'
          : '(DRY_RUN=false → REAL on-chain transaction)'
      }`
    );
    return false;
  }
  if (!config.dryRun) {
    console.log(`\n⚠️  LIVE — ${actionDesc}. Sending a REAL transaction in 3s… (Ctrl+C to abort)`);
    await new Promise((r) => setTimeout(r, 3000));
  } else {
    console.log(`\n[DRY_RUN] simulating: ${actionDesc}`);
  }
  return true;
}

module.exports = { config, provider, wallet, hr, eth, hasFlag, arg, requireConfirm };
