# Benchmark: Base Sepolia (84532), public x402.org facilitator, real USDC

Run 2026-11-27T06:48:39.145Z. 20 purchases per row, 2 retries on a dropped connection or 5xx, fault seed `bench-1`, price 0.001 USDC.

## No faults (sanity check)

| Client | Delivered | Transfers on chain | Items charged twice | Extra transfers | Paid, not delivered | …and told so | Median ms |
|---|---|---|---|---|---|---|---|
| stock @x402/fetch | 20/20 | 20 | 0 | 0 | 0 | 0 | 966 |
| x402-once | 20/20 | 20 | 0 | 0 | 0 | 0 | 964 |

## 30% of paid requests hit a fault; seller does not replay

| Client | Delivered | Transfers on chain | Items charged twice | Extra transfers | Paid, not delivered | …and told so | Median ms |
|---|---|---|---|---|---|---|---|
| stock @x402/fetch | 16/20 | 23 | 4 | 5 | 2 | 0 | 992 |
| x402-once | 13/20 | 19 | 0 | 0 | 6 | 6 | 1013 |

## 30% of paid requests hit a fault; seller replays a settled payment

| Client | Delivered | Transfers on chain | Items charged twice | Extra transfers | Paid, not delivered | …and told so | Median ms |
|---|---|---|---|---|---|---|---|
| stock @x402/fetch | 17/20 | 26 | 5 | 7 | 2 | 0 | 1035 |
| x402-once | 19/20 | 19 | 0 | 0 | 0 | 0 | 991 |
