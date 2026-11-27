# Security policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Please do not open a public issue or pull request for a suspected vulnerability.

Include the affected version, a minimal reproduction and the impact (for example: a payment signed twice, a stored payment sent to the wrong place, a record readable by another user).

## Supported versions

Only the latest published minor version receives fixes while the package is below 1.0. Please upgrade first.

## Scope

In scope: the published `x402-once` package (main, `/node` and `/testing` entry points) and this repository's build and release workflows. Examples: double payment or replay, payment-store integrity or permission problems, signed payment headers leaking into logs or errors, a payment sent over an unsafe channel, supply-chain problems in how the package is built or published.

## Out of scope

- Vulnerabilities in `@x402/core`, `@x402/evm`, `@x402/fetch`, viem or other dependencies. Report them to those projects; tell us if we need to change a version range.
- Behaviour of a seller, facilitator or chain you chose to pay, including a seller or facilitator that settles one payment twice.
- Attackers who already control the machine, the Node process or the payment store directory.
- The `bench/` harness and its throwaway test wallets, and the `/testing` simulated seller.
- Denial of service through very large inputs you chose to pass in, social engineering, and automated scanner output with no demonstrated impact.

## Response times (best effort, one maintainer)

Acknowledgement within 3 working days, first assessment within 7 days. Fix or mitigation target: 30 days for high severity, 90 days otherwise. Coordinated disclosure through a GitHub security advisory; reporters are credited unless they prefer not to be.
