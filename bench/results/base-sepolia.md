# Benchmark: Base Sepolia (84532), public x402.org facilitator, real USDC

Run 2026-11-27T06:43:45.751Z. 20 purchases per row, 2 retries on a dropped connection or 5xx, fault seed `bench-1`, price 0.001 USDC.

## No faults (sanity check)

| Client | Delivered | Transfers on chain | Items charged twice | Extra transfers | Paid, not delivered | …and told so | Median ms |
|---|---|---|---|---|---|---|---|
| stock @x402/fetch | 20/20 | 20 | 0 | 0 | 0 | 0 | 995 |
| x402-once | 20/20 | 20 | 0 | 0 | 0 | 0 | 985 |

## 30% of paid requests hit a fault; seller does not replay

| Client | Delivered | Transfers on chain | Items charged twice | Extra transfers | Paid, not delivered | …and told so | Median ms |
|---|---|---|---|---|---|---|---|
| stock @x402/fetch | 19/20 | 28 | 6 | 8 | 1 | 0 | 1032 |
| x402-once | 14/20 | 20 | 0 | 0 | 6 | 6 | 1000 |

## 30% of paid requests hit a fault; seller replays a settled payment

| Client | Delivered | Transfers on chain | Items charged twice | Extra transfers | Paid, not delivered | …and told so | Median ms |
|---|---|---|---|---|---|---|---|
| stock @x402/fetch | 17/20 | 26 | 6 | 8 | 1 | 0 | 1007 |
| x402-once | 18/20 | 18 | 0 | 0 | 0 | 0 | 982 |
