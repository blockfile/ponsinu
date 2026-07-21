'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  toPublicSummary,
  buildUnclaimedPayload,
  toActivityRow,
  toPublicActivityRow,
  toPublicStats,
} = require('./format');

test('buildUnclaimedPayload reports the live balance and the USD claim threshold', () => {
  const out = buildUnclaimedPayload(0.5, 3000);
  assert.deepStrictEqual(Object.keys(out).sort(), ['claimThresholdUsd', 'ethPriceUsd', 'unclaimedEth', 'unclaimedUsd']);
  assert.strictEqual(out.unclaimedEth, 0.5);
  assert.strictEqual(out.unclaimedUsd, 1500);
  assert.strictEqual(out.ethPriceUsd, 3000);
  assert.strictEqual(typeof out.claimThresholdUsd, 'number');
  assert.strictEqual(buildUnclaimedPayload(null, 3000).unclaimedEth, null);
});

test('toActivityRow maps buy + burn steps', () => {
  const buy = toActivityRow({ name: 'buy', detail: { ethSpent: 0.4, tokensBought: 1000 }, signature: 'sig', created_at: 'x' }, 100);
  assert.strictEqual(buy.type, 'Buy');
  assert.strictEqual(buy.amountEth, 0.4);
  assert.strictEqual(buy.tokens, 1000);

  const burn = toActivityRow({ name: 'burn', detail: { tokensBurned: 1000 }, created_at: 'x' }, 100);
  assert.strictEqual(burn.type, 'Burn');
  assert.strictEqual(burn.status, 'Burned');
  assert.strictEqual(burn.tokens, 1000);
});

test('toPublicActivityRow maps buy + burn steps', () => {
  const row = toPublicActivityRow({ name: 'buy', detail: { ethSpent: 0.2, tokensBought: 500 }, signature: 's', created_at: '2026-07-11T00:00:00Z' }, 100);
  assert.strictEqual(row.type, 'buy');
  assert.strictEqual(row.amountEth, 0.2);
  assert.strictEqual(typeof row.usdtValue, 'number'); // never null

  const burn = toPublicActivityRow({ name: 'burn', detail: { tokensBurned: 500 }, signature: 's', created_at: '2026-07-11T00:00:00Z' }, 100);
  assert.strictEqual(burn.type, 'burn');
  assert.strictEqual(burn.status, 'burned');
  assert.strictEqual(burn.tokens, 500);
});

test('toPublicStats emits the flat frontend stats object', () => {
  const out = toPublicStats({
    stats: { total_eth_claimed: 12, total_eth_spent_buy: 9.6, total_tokens_bought: 1000, total_tokens_burned: 1000, burns: 6 },
    unclaimedEth: 0.5,
    operatingWallet: '0xwallet',
    market: { marketCap: 100 },
  });
  assert.strictEqual(out.totalCreatorFeesClaimed, 12);
  assert.strictEqual(out.ethSpentBuying, 9.6);
  assert.strictEqual(out.tokensBurned, 1000);
  assert.strictEqual(out.burns, 6);
  assert.strictEqual(out.operatingWallet, '0xwallet');
  assert.strictEqual(out.unclaimedFeesEth, 0.5);
  assert.strictEqual(out.marketCap, 100);
});

test('toPublicSummary reports claimed fees and burned totals', () => {
  const out = toPublicSummary({
    stats: { total_eth_claimed: 10, total_eth_spent_buy: 8, total_tokens_bought: 1234, total_tokens_burned: 1234, burns: 8, completed: 8 },
    price: 3000,
    marketCapUsd: 55_620_000,
  });
  assert.strictEqual(out.creatorFeesClaimedEth, 10);
  assert.strictEqual(out.creatorFeesClaimedUsd, 30000);
  assert.strictEqual(out.ethSpentBuying, 8);
  assert.strictEqual(out.ethSpentBuyingUsd, 24000);
  assert.strictEqual(out.tokensBurned, 1234);
  assert.strictEqual(out.burns, 8);
  assert.strictEqual(out.marketCapUsd, 55_620_000);
});

test('toPublicSummary marketCapUsd defaults to null when not provided', () => {
  const out = toPublicSummary({ stats: {}, price: 0 });
  assert.strictEqual(out.marketCapUsd, null);
});
