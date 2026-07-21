'use strict';
const test = require('node:test');
const assert = require('node:assert');
const simvault = require('./simvault');

test('simvault accrues two-sided fees, claims into the wallet, spends and burns', () => {
  simvault.reset();
  assert.deepStrictEqual(simvault.peek(), { pendingWeth: 0, pendingTokens: 0, walletWeth: 0, walletTokens: 0 });

  // LP fees accrue in the locker in BOTH tokens.
  simvault.accrue(0.5, 1000);
  simvault.accrue(0.5, 1000);
  assert.deepStrictEqual(simvault.peek(), { pendingWeth: 1, pendingTokens: 2000, walletWeth: 0, walletTokens: 0 });
  assert.deepStrictEqual(simvault.peek(), simvault.peek()); // peek does not mutate

  // Claim moves everything pending into the wallet.
  const claimed = simvault.claim();
  assert.deepStrictEqual(claimed, { weth: 1, tokens: 2000 });
  assert.deepStrictEqual(simvault.peek(), { pendingWeth: 0, pendingTokens: 0, walletWeth: 1, walletTokens: 2000 });

  // A buy spends wallet WETH (floored at 0); a burn takes the wallet tokens.
  assert.strictEqual(simvault.spendWeth(0.4), 0.6);
  assert.strictEqual(simvault.spendWeth(99), 0);
  assert.strictEqual(simvault.takeTokens(), 2000);
  assert.strictEqual(simvault.peek().walletTokens, 0);
});

test('simvault.reset forces a known state', () => {
  const s = simvault.reset({ pendingWeth: 2.5, walletWeth: 1, pendingTokens: 10, walletTokens: 5 });
  assert.deepStrictEqual(s, { pendingWeth: 2.5, pendingTokens: 10, walletWeth: 1, walletTokens: 5 });
  simvault.reset();
  assert.deepStrictEqual(simvault.peek(), { pendingWeth: 0, pendingTokens: 0, walletWeth: 0, walletTokens: 0 });
});
