import { createClient } from "genlayer-js";
import * as chains from "genlayer-js/chains";

export type ChainName = keyof typeof chains;
export const AVAILABLE_CHAINS = Object.keys(chains) as ChainName[];

/**
 * This is genlayer-js's real wallet-signing path, verified by reading the
 * compiled SDK (node_modules/genlayer-js/dist/index.js):
 *
 *   - createClient({ account: "0x...", provider? }) stores `account` as a
 *     plain address string (not a local signer object).
 *   - Every write (register_agent, create_deal, submit_deliverable,
 *     resolve_dispute all go through the same consensus-call path) checks
 *     `validatedAccount.type === "local"`. A plain address is NOT local, so
 *     it falls through to `client.request({ method: "eth_sendTransaction", ... })`.
 *   - The client's custom transport intercepts wallet-only methods
 *     (eth_accounts, eth_requestAccounts, eth_sendTransaction,
 *     eth_signTransaction, personal_sign, eth_signTypedData_v4) and forwards
 *     them straight to `config.provider ?? window.ethereum`.
 *   - Before any eth_sendTransaction it calls `assertChainMatch`, which
 *     throws a clear "switch your wallet to chain X" error if MetaMask is
 *     on the wrong network -- surfaced verbatim to the UI below.
 *
 * In short: pass the connected wallet address as `account` and the injected
 * provider as `provider`, and every write in this app will pop a real
 * MetaMask signature/transaction prompt. No custom signing code needed.
 */

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export interface EIP1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<any>;
  on?: (event: string, handler: (...args: any[]) => void) => void;
  removeListener?: (event: string, handler: (...args: any[]) => void) => void;
  isMetaMask?: boolean;
}

export function hasInjectedWallet(): boolean {
  return typeof window !== "undefined" && !!window.ethereum;
}

export interface WalletConnection {
  client: ReturnType<typeof createClient>;
  address: string;
  provider: EIP1193Provider;
}

/**
 * Full connect flow: request account access, add/switch MetaMask to the
 * target GenLayer chain (installing the GenLayer snap if the wallet
 * supports/needs one), then build a client that signs through the wallet.
 */
export async function connectWallet(chainName: ChainName): Promise<WalletConnection> {
  if (!hasInjectedWallet()) {
    throw new Error(
      "No injected wallet found. Install MetaMask (or another EIP-1193 wallet extension) and reload the page.",
    );
  }
  const provider = window.ethereum!;

  const accounts: string[] = await provider.request({ method: "eth_requestAccounts" });
  if (!accounts?.length) {
    throw new Error("Wallet connection was rejected or returned no accounts.");
  }
  const address = accounts[0];

  const chain = (chains as Record<string, unknown>)[chainName];
  const client = createClient({
    chain: chain as any,
    account: address as `0x${string}`,
    provider: provider as any,
  });

  // Adds the chain to MetaMask if missing, switches to it, and installs the
  // GenLayer snap if the wallet supports snaps. Best-effort: some injected
  // wallets don't implement wallet_addEthereumChain / snaps at all, and the
  // plain eth_sendTransaction path above still works without it as long as
  // the wallet is already on the right chain -- so a failure here is a
  // warning, not a hard stop.
  try {
    await (client as any).connect(chainName);
  } catch (err) {
    console.warn("client.connect() network setup step failed (non-fatal):", err);
  }

  return { client, address, provider };
}

export function onAccountsChanged(provider: EIP1193Provider, cb: (accounts: string[]) => void) {
  provider.on?.("accountsChanged", cb);
  return () => provider.removeListener?.("accountsChanged", cb);
}

export function onChainChanged(provider: EIP1193Provider, cb: (chainIdHex: string) => void) {
  provider.on?.("chainChanged", cb);
  return () => provider.removeListener?.("chainChanged", cb);
}
