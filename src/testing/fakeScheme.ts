import type { PaymentRequirements } from '@x402/core/types';
import { x402Client } from '@x402/core/client';

export interface FakeEvmSchemeOptions {
  /** The payer address put in the authorization. */
  from?: string;
  now?: () => number;
}

function randomNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return '0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A stand-in for the EVM `exact` scheme with no cryptography. Like the real one, it draws a fresh random nonce on
 * every call and gives the authorization a deadline of `maxTimeoutSeconds`. Use it to test retry behaviour without a wallet.
 */
export function createFakeEvmScheme(options: FakeEvmSchemeOptions = {}) {
  const now = options.now ?? Date.now;
  const from = options.from ?? '0x1111111111111111111111111111111111111111';
  return {
    scheme: 'exact' as const,
    async createPaymentPayload(x402Version: number, requirements: PaymentRequirements) {
      const nowSeconds = Math.floor(now() / 1000);
      return {
        x402Version,
        payload: {
          authorization: {
            from,
            to: requirements.payTo,
            value: requirements.amount,
            validAfter: String(nowSeconds - 60),
            validBefore: String(nowSeconds + requirements.maxTimeoutSeconds),
            nonce: randomNonce(),
          },
          signature: '0x' + '00'.repeat(65),
        },
      };
    },
  };
}

/** An `x402Client` that signs with the fake scheme on the network the simulated seller uses. */
export function createFakeClient(network = 'eip155:84532', options: FakeEvmSchemeOptions = {}): x402Client {
  return x402Client.fromConfig({
    schemes: [{ network: network as `${string}:${string}`, client: createFakeEvmScheme(options) }],
    spendControls: false, // the fake token is not a default asset, so the client's own spend caps would refuse it
  });
}
