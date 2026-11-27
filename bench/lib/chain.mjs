// A local EVM chain (anvil) with a USDC stand-in deployed on it. Real transactions, real signatures, real nonce state.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export const LOCAL_CHAIN_ID = 31337;
// Compiled from bench/contracts/TestUSDC.sol with Foundry (forge build); the artifact is committed so running the benchmark needs only anvil.
const artifactPath = fileURLToPath(new URL('../contracts/TestUSDC.artifact.json', import.meta.url));

export function chainFor(id, rpcUrl) {
  return defineChain({
    id,
    name: id === LOCAL_CHAIN_ID ? 'local-anvil' : `chain-${id}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export async function startAnvil(port = 8645) {
  // One-second blocks, like a real chain. Instant mining makes anvil's block clock race ahead of the wall clock,
  // and the token then rejects every authorization as expired.
  const child = spawn('anvil', ['--port', String(port), '--chain-id', String(LOCAL_CHAIN_ID), '--block-time', '1', '--silent'], { stdio: 'ignore' });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const chain = chainFor(LOCAL_CHAIN_ID, rpcUrl);
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  for (let i = 0; i < 100; i++) {
    try {
      await client.getChainId();
      return { rpcUrl, chain, stop: () => child.kill('SIGTERM') };
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  child.kill('SIGTERM');
  throw new Error('anvil did not start. Is it installed (brew install foundry)?');
}

/** Gives a fresh throwaway account some gas money on the local chain. */
export async function fundWithGas(rpcUrl, address) {
  await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_setBalance', params: [address, '0x56BC75E2D63100000'] }),
  });
}

export function newAccount() {
  return privateKeyToAccount(generatePrivateKey());
}

export async function deployToken({ rpcUrl, chain }) {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const deployer = newAccount();
  await fundWithGas(rpcUrl, deployer.address);
  const wallet = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 200 });
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { address: receipt.contractAddress, abi: artifact.abi, wallet, publicClient };
}
