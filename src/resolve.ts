import type { PaymentRecord, SettlementResolver } from './types.js';

interface Eip3009Authorization {
  from?: unknown;
  nonce?: unknown;
  validBefore?: unknown;
}

function authorizationOf(payload: Record<string, unknown>): Eip3009Authorization | undefined {
  const auth = payload['authorization'];
  return auth && typeof auth === 'object' ? (auth as Eip3009Authorization) : undefined;
}

/**
 * When a signed payment stops being valid, in ms since the epoch.
 * EVM `exact` payments carry `authorization.validBefore` (seconds). Anything else falls back to the signing time plus
 * the seller's `maxTimeoutSeconds`.
 */
export function expiryOf(payload: Record<string, unknown>, maxTimeoutSeconds: number, signedAt: number): number {
  const validBefore = Number(authorizationOf(payload)?.validBefore);
  if (Number.isFinite(validBefore) && validBefore > 0) return validBefore * 1000;
  return signedAt + maxTimeoutSeconds * 1000;
}

export interface EvmAuthorizationResolverOptions {
  /** JSON-RPC URL per network, keyed by the CAIP-2 id the seller uses, for example `eip155:8453`. */
  rpcUrls: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

const AUTHORIZATION_STATE = '0xe94a0102'; // authorizationState(address,bytes32), the EIP-3009 view function

const pad32 = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

/**
 * Asks the token contract whether an EIP-3009 authorization was used (`authorizationState`).
 * `true` means the payment settled. `false` after the deadline means it can never settle. Any doubt returns `unknown`.
 * Read-only: no key, no signature, no transaction.
 */
export function evmAuthorizationResolver(options: EvmAuthorizationResolverOptions): SettlementResolver {
  const doFetch = options.fetch ?? globalThis.fetch;
  return async (record: PaymentRecord) => {
    const accepted = record.payload.accepted;
    const url = options.rpcUrls[accepted.network];
    const auth = authorizationOf(record.payload.payload);
    if (!url || !auth || typeof auth.from !== 'string' || typeof auth.nonce !== 'string') return 'unknown';
    if (!/^0x[0-9a-fA-F]{64}$/.test(auth.nonce) || !/^0x[0-9a-fA-F]{40}$/.test(auth.from)) return 'unknown';

    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to: accepted.asset, data: AUTHORIZATION_STATE + pad32(auth.from) + pad32(auth.nonce) }, 'latest'],
        }),
      });
      if (!response.ok) return 'unknown';
      const body = (await response.json()) as { result?: unknown; error?: unknown };
      if (typeof body.result !== 'string' || body.error) return 'unknown';
      if (/^0x0*1$/.test(body.result)) return 'settled';
      if (/^0x0*$/.test(body.result)) return 'unsettled';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  };
}
