// Makes the two throwaway Base Sepolia wallets the benchmark needs and saves them to bench/.wallet.json (git-ignored, mode 0600).
// It prints addresses only. Never prints a key. Fund the BUYER address with test USDC at https://faucet.circle.com
// (network: Base Sepolia, token: USDC). Test tokens have no value. The buyer needs no ETH: the facilitator pays gas.
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const path = fileURLToPath(new URL('./.wallet.json', import.meta.url));
if (!existsSync(path)) {
  const buyerKey = generatePrivateKey();
  const payToKey = generatePrivateKey();
  const wallet = {
    note: 'Throwaway Base Sepolia test wallets for the x402-once benchmark. Never put real funds here.',
    buyer: { address: privateKeyToAccount(buyerKey).address, privateKey: buyerKey },
    payTo: { address: privateKeyToAccount(payToKey).address, privateKey: payToKey },
  };
  writeFileSync(path, JSON.stringify(wallet, null, 2), { mode: 0o600 });
  console.log('Created bench/.wallet.json');
}
const wallet = JSON.parse(readFileSync(path, 'utf8'));
console.log(`Buyer (fund this with test USDC): ${wallet.buyer.address}`);
console.log(`Seller receives at:               ${wallet.payTo.address}`);
