import type { PaymentRecord, SettlementFinding } from './types.js';

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
  /**
   * How many blocks back to look for the transaction that used the authorization, so the error can name it.
   * Best effort: when the RPC refuses the range, the verdict is still returned, just without a transaction. Default 5000.
   */
  lookbackBlocks?: number;
}

const AUTHORIZATION_STATE = '0xe94a0102'; // authorizationState(address,bytes32), the EIP-3009 view function
const AUTHORIZATION_USED = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5'; // keccak256("AuthorizationUsed(address,bytes32)")

const pad32 = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

/**
 * Asks the token contract whether an EIP-3009 authorization was used (`authorizationState`).
 * `true` means the payment settled. `false` means it can never settle only once the latest block's timestamp is past
 * the authorization's `validBefore`; before that, or if the chain time cannot be read, the answer is `unknown`. Any doubt returns `unknown`.
 * Read-only: no key, no signature, no transaction.
 */
export function evmAuthorizationResolver(options: EvmAuthorizationResolverOptions): (record: PaymentRecord) => Promise<SettlementFinding> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const lookback = options.lookbackBlocks ?? 5000;

  async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!response.ok) throw new Error(`RPC ${method} answered ${response.status}`);
    const body = (await response.json()) as { result?: unknown; error?: unknown };
    if (body.error || body.result === undefined) throw new Error(`RPC ${method} failed`);
    return body.result;
  }

  /** The transaction that emitted AuthorizationUsed for this authorization, or undefined when it cannot be found. */
  async function findTransaction(url: string, asset: string, from: string, nonce: string, at: string): Promise<string | undefined> {
    try {
      const latest = at === 'latest' ? BigInt((await rpc(url, 'eth_blockNumber', [])) as string) : BigInt(at);
      const first = latest > BigInt(lookback) ? latest - BigInt(lookback) : 0n;
      const logs = (await rpc(url, 'eth_getLogs', [
        { address: asset, fromBlock: '0x' + first.toString(16), toBlock: at, topics: [AUTHORIZATION_USED, '0x' + pad32(from), '0x' + pad32(nonce)] },
      ])) as Array<{ transactionHash?: unknown }>;
      const hash = logs[0]?.transactionHash;
      return typeof hash === 'string' ? hash : undefined;
    } catch {
      return undefined;
    }
  }

  return async (record: PaymentRecord): Promise<SettlementFinding> => {
    const accepted = record.payload.accepted;
    const url = Object.hasOwn(options.rpcUrls, accepted.network) ? options.rpcUrls[accepted.network] : undefined;
    const auth = authorizationOf(record.payload.payload);
    if (!url || !auth || typeof auth.from !== 'string' || typeof auth.nonce !== 'string') return { verdict: 'unknown' };
    if (!/^0x[0-9a-fA-F]{64}$/.test(auth.nonce) || !/^0x[0-9a-fA-F]{40}$/.test(auth.from)) return { verdict: 'unknown' };

    try {
      // Read the state and the chain's clock at the SAME block, so a settlement mined in between cannot be missed.
      const block = (await rpc(url, 'eth_getBlockByNumber', ['latest', false])) as { number?: unknown; timestamp?: unknown } | null;
      const at = typeof block?.number === 'string' && /^0x[0-9a-f]+$/i.test(block.number) ? block.number : 'latest';
      const chainTime = typeof block?.timestamp === 'string' ? Number(BigInt(block.timestamp)) : NaN;

      const result = await rpc(url, 'eth_call', [{ to: accepted.asset, data: AUTHORIZATION_STATE + pad32(auth.from) + pad32(auth.nonce) }, at]);
      // Exactly one 32-byte word. "0x" (no contract at that address, wrong chain, odd RPC) is NOT "never used".
      if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) return { verdict: 'unknown' };
      if (/^0x0{63}1$/.test(result)) {
        const transaction = await findTransaction(url, accepted.asset, auth.from, auth.nonce, at);
        return transaction ? { verdict: 'settled', transaction } : { verdict: 'settled' };
      }
      if (/^0x0{64}$/.test(result)) {
        // "Not used" is only final once the chain itself has passed the deadline. The buyer's clock can be fast and an
        // RPC node can lag, so compare against the block's own timestamp, not against our clock.
        const validBefore = Number(auth.validBefore);
        if (!Number.isFinite(validBefore) || validBefore <= 0) return { verdict: 'unknown' };
        return chainTime >= validBefore ? { verdict: 'unsettled' } : { verdict: 'unknown' };
      }
      return { verdict: 'unknown' };
    } catch {
      return { verdict: 'unknown' };
    }
  };
}
