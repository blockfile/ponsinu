'use strict';

const { Contract, formatEther, parseEther } = require('ethers');
const config = require('../config');
const { provider, wallet } = require('./provider');

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

const WETH_ABI = [...ERC20_ABI, 'function deposit() payable', 'function withdraw(uint256 wad)'];

function erc20(address, signer = null) {
  return new Contract(address, ERC20_ABI, signer || provider);
}

function wethContract(signer = null) {
  return new Contract(config.weth, WETH_ABI, signer || provider);
}

/** Fetch a token's decimals (cached per address — decimals never change). */
const decimalsCache = new Map();
async function getDecimals(token) {
  const key = String(token).toLowerCase();
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  const d = Number(await erc20(token).decimals());
  decimalsCache.set(key, d);
  return d;
}

/** Token balance of `owner` in base units (bigint). */
async function readTokenBalance(token, owner) {
  return erc20(token).balanceOf(owner);
}

/** Total supply of `token` in base units. DRY_RUN returns a simulated 1B @ 18 decimals. */
async function getTokenSupplyRaw(token) {
  if (config.dryRun) return 1_000_000_000n * 10n ** 18n;
  return erc20(token).totalSupply();
}

/** The wallet's WETH balance in ETH units. DRY_RUN: 0 (no real WETH exists). */
async function getWethBalanceEth() {
  if (config.dryRun) return 0;
  const bal = await wethContract().balanceOf(wallet.address);
  return Number(formatEther(bal));
}

/**
 * If the wallet holds WETH (e.g. the post-buy remainder of a fee claim), unwrap
 * it to native ETH so gas stays topped up. No-op when the balance is zero.
 */
async function unwrapAllWeth() {
  if (config.dryRun) return null;
  const weth = wethContract(wallet);
  const bal = await weth.balanceOf(wallet.address);
  if (bal === 0n) return null;
  const tx = await weth.withdraw(bal);
  await tx.wait();
  console.log(`[tx] unwrap ${formatEther(bal)} WETH: ${tx.hash}`);
  return tx.hash;
}

/**
 * Unwrap up to `amountEth` of the wallet's WETH to native ETH (for gas top-ups),
 * capped at the WETH balance. Returns the amount unwrapped in ETH units.
 */
async function unwrapWeth(amountEth) {
  if (config.dryRun) return 0;
  const weth = wethContract(wallet);
  const bal = await weth.balanceOf(wallet.address);
  const want = parseEther(String(amountEth));
  const amount = bal < want ? bal : want;
  if (amount <= 0n) return 0;
  const tx = await weth.withdraw(amount);
  await tx.wait();
  console.log(`[tx] unwrap ${formatEther(amount)} WETH for gas: ${tx.hash}`);
  return Number(formatEther(amount));
}

module.exports = {
  ERC20_ABI,
  WETH_ABI,
  erc20,
  wethContract,
  getDecimals,
  readTokenBalance,
  getTokenSupplyRaw,
  getWethBalanceEth,
  unwrapAllWeth,
  unwrapWeth,
};
