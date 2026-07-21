# ponsinu

**Claim, buyback and burn bot for ponsfamily.com tokens on Robinhood Chain (EVM).**

Every 5 minutes, once the creator fees reach 0.01 WETH, claim them from the
Pons locker and spend them buying the token back and burning it:

```
every POLL_SCHEDULE (default */5), once fees ≥ BURN_ETH_PER_CYCLE (default 0.01 WETH):
  claim the creator fees from the PonsLaunchLocker   (arrive as WETH + the token)
    → buy back BURN_ETH_PER_CYCLE of the token       (Uniswap V3, WETH in)
    → BURN the wallet's ENTIRE token balance: what was bought + the claimed
      token fees + any residue           (send to 0x…dEaD — gone forever)
```

When the fees (wallet WETH + pending in the locker) haven't reached 0.01 WETH
yet, the cycle is skipped and retried on the following tick, so fees simply
accumulate until there's a buy's worth — i.e. the burn fires every 0.01 ETH of
fees earned. (Set `BURN_ETH_PER_CYCLE=0` to size the buy in USD via
`BURN_USD_PER_CYCLE` instead.)

Everything runs in `DRY_RUN=true` by default — all on-chain calls are simulated
and no funds are ever touched until you flip it off.

## What "burn" means here

Each cycle the bot sends the dev wallet's **entire balance of the token** — the
tokens it just bought, the token-side fees each claim delivers, and any residue
left over from earlier cycles — to the **dead address** (`0x…dEaD`). The dead
address has no private key, so those tokens can never move again — they're
permanently out of circulation and show up as burned on the explorer.

## How the funding works (verified on-chain)

A ponsfamily.com launch (`PonsLaunchFactory`) mints a **fixed-supply, tax-free
ERC-20** (`PonsLauncherToken`) straight into a **Uniswap V3 pool** paired with
WETH (1% fee tier) and locks the LP position NFT in the **PonsLaunchLocker**.
The pool's trading fees accrue to that locked position **in both tokens**
(WETH + your token).

The token's **deployer wallet** claims the creator share by calling
`collectFees(token)` on the locker (the locker keeps a protocol cut — 10% at
the time of writing — and pays the rest out). So the operating wallet **must be
the wallet that deployed the token** on ponsfamily.com; no other wallet is
allowed to claim. Claimed fees land as **WETH (ERC-20) + the token itself**:
the WETH funds the buyback (via `SwapRouter02.exactInputSingle` on the launch
pool), and the token-side fees are burned directly along with what was bought.

Gas is still paid in native ETH — the bot tops the gas reserve back up by
unwrapping a little WETH whenever the native balance runs low.

### Robinhood Chain reference (defaults in `.env.example`)

| What | Value |
|---|---|
| Chain ID | 4663 |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` |
| Reward currency | WETH + the token (claimed from the locker by the deployer) |
| PonsLaunchLocker (claim path) | `0x31ca5E101941A93A7DD6d0497928700625CF54B5` (override via `LOCKER_ADDRESS`) |
| Uniswap V3 SwapRouter02 (buy path) | `0xCaf681a66D020601342297493863E78C959E5cb2` (override via `SWAP_ROUTER_ADDRESS`) |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |

The token's V3 pool, fee tier and pair token are read straight off the token
contract (`liquidityPool()`, `poolFee()`, `pairToken()`), so `TOKEN_ADDRESS` is
the only per-token setting.

## Config

| Env | Default | Meaning |
|---|---|---|
| `BURN_ETH_PER_CYCLE` | `0.01` | WETH bought back + burned each cycle — the trigger fires every time fees reach this |
| `BURN_USD_PER_CYCLE` | `5` | USD sizing fallback, used only when `BURN_ETH_PER_CYCLE=0` |
| `POLL_SCHEDULE` | `*/5 * * * *` | how often the scheduler ticks (every 5 min) |
| `SLIPPAGE_PCT` | `5` | V3 buy slippage tolerance (on top of the pool fee) |
| `CLAIM_MIN_WETH` | `0.0005` | skip the claim leg while pending WETH is below this (unless the buy needs it) |
| `BURN_CLAIMED_TOKENS` | `true` | burn the wallet's whole token balance each cycle (claimed token fees + residue); `false` = only the buyback |
| `DEAD_ADDRESS` | `0x…dEaD` | burn sink for the bought tokens |
| `GAS_RESERVE_ETH` | `0.005` | native ETH floor for gas (auto topped-up from WETH) |
| `LOCKER_ADDRESS` | RH locker | the PonsLaunchLocker holding the LP + paying the fees |
| `SWAP_ROUTER_ADDRESS` | RH SwapRouter02 | the Uniswap V3 router that buys the token with WETH |

## Quick start

```bash
npm install
cp .env.example .env       # defaults are safe: DRY_RUN=true, ephemeral wallet
npm start                  # needs a local MongoDB (or set MONGODB_URI)
npm test                   # unit + integration tests (in-memory MongoDB)
```

## Going live

1. Deploy your token on **ponsfamily.com** from the wallet the bot will run
   with — the locker only pays creator fees to the token's **deployer**.
2. Fill `.env`: `WALLET_PRIVATE_KEY` (the deployer wallet), `TOKEN_ADDRESS`,
   `MONGODB_URI`, set `DRY_RUN=false`. Keep a little native ETH in the wallet
   for gas.
3. `node scripts/check.js` — read-only preflight (verifies the launch wiring,
   that THIS wallet may claim, pending fees, and the buy quote).
4. Dust-test the legs (`--confirm` to send):
   - `node scripts/claim.js --confirm` — claim the creator fees from the locker
   - `node scripts/buy.js 0.001 --confirm` — buy with 0.001 WETH
   - `node scripts/burn.js 0.001 --confirm` — buys dust and burns it. **Verify on
     the explorer that the tokens landed at the dead address.**
5. `node scripts/run-once.js --confirm` — one full claim → buy → burn cycle,
   then `npm start` for the every-5-minutes loop.

## Scripts

| Script | What it does |
|---|---|
| `scripts/check.js` | Read-only preflight: config, RPC/chain, launch wiring, claim rights, pending fees, buy quote |
| `scripts/claim.js` | Claim the creator fees from the locker (`--confirm` to send; preview otherwise) |
| `scripts/buy.js <weth>` | Buy the token with N WETH via SwapRouter02 (`--confirm` to send) |
| `scripts/burn.js <weth>` | Buy dust + burn it (`--confirm` to send) |
| `scripts/run-once.js` | One full claim → buy → burn cycle (`--confirm`) |

## API

Storage (MongoDB), the Express API (`/activity`, `/stats`, `/summary`,
`/accrual`, `/countdown`, `/api/*`, SSE stream) and the scheduler are shared
infra. `/api/unclaimed` reports the loop's WETH fuel — wallet balance plus the
creator share still pending in the locker — waiting to be spent on the next
buyback.
