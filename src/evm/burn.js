'use strict';

// Burn ERC-20 tokens by transferring them to the dead address. This removes them
// from circulation permanently and irreversibly (the dead address has no private
// key, so they can never be moved again) and shows up as a burn on the explorer.
// Works for any ERC-20 — no burn() function required on the token.

const { formatUnits } = require('ethers');
const config = require('../config');
const { erc20, getDecimals } = require('./erc20');
const { wallet } = require('./provider');

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Burn `amountRaw` base units of `token` by sending them to DEAD_ADDRESS.
 * @returns {Promise<{signature, burnedRaw, burned, deadAddress, simulated}>}
 */
async function burnToken(token, amountRaw) {
  const amount = BigInt(amountRaw || '0');
  if (config.dryRun) {
    const decimals = 18;
    return {
      signature: fakeSig('burn'),
      burnedRaw: amount.toString(),
      burned: Number(amount) / 10 ** decimals,
      deadAddress: config.deadAddress,
      simulated: true,
    };
  }
  if (amount <= 0n) throw new Error(`nothing to burn (amount ${amountRaw})`);

  const decimals = await getDecimals(token);
  const tx = await erc20(token, wallet).transfer(config.deadAddress, amount);
  await tx.wait();
  console.log(`[tx] burn ${formatUnits(amount, decimals)} tokens → ${config.deadAddress}: ${tx.hash}`);
  return {
    signature: tx.hash,
    burnedRaw: amount.toString(),
    burned: Number(formatUnits(amount, decimals)),
    deadAddress: config.deadAddress,
    simulated: false,
  };
}

module.exports = { burnToken };
