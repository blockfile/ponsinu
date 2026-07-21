'use strict';
const test = require('node:test');
const assert = require('node:assert');

process.env.DRY_RUN = 'true';
process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000a1b69';
delete require.cache[require.resolve('../config')];
const { burnToken } = require('./burn');

test('burnToken (DRY_RUN) simulates a burn to the dead address', async () => {
  const raw = (1234n * 10n ** 18n).toString();
  const burn = await burnToken('0x00000000000000000000000000000000000a1b69', raw);
  assert.strictEqual(burn.simulated, true);
  assert.strictEqual(burn.burnedRaw, raw);
  assert.strictEqual(burn.burned, 1234);
  assert.strictEqual(burn.deadAddress, '0x000000000000000000000000000000000000dead');
  assert.ok(burn.signature.startsWith('burn_'));
});

test('burnToken (DRY_RUN) handles a zero amount without throwing', async () => {
  const burn = await burnToken('0x00000000000000000000000000000000000a1b69', '0');
  assert.strictEqual(burn.burnedRaw, '0');
  assert.strictEqual(burn.burned, 0);
});
