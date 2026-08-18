import React from "react";
import type { ChainName } from "../lib/contract";
import { hasInjectedWallet } from "../lib/wallet";

const CHAIN_LABELS: Record<string, string> = {
  testnetBradbury: "Testnet Bradbury",
  testnetAsimov: "Testnet Asimov",
  studionet: "Studionet",
  localnet: "Localnet",
};

export function ConnectWalletBar({
  chainName,
  connected,
  connecting,
  currentAddress,
  connectError,
  onConnect,
  onDisconnect,
}: {
  chainName: ChainName;
  connected: boolean;
  connecting: boolean;
  currentAddress: string | null;
  connectError: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const walletAvailable = hasInjectedWallet();
  const chainLabel = CHAIN_LABELS[chainName] ?? chainName;

  if (connected) {
    return (
      <div className="wallet-bar wallet-bar--connected">
        <div className="wallet-chip">
          <span className="wallet-dot" />
          <span className="wallet-address">{shortenAddress(currentAddress)}</span>
        </div>
        <span className="network-chip">{chainLabel}</span>
        <button className="btn btn-outline btn-sm" onClick={onDisconnect}>
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="wallet-bar">
      <span className="network-chip">{chainLabel}</span>
      <button className="btn btn-primary" disabled={connecting} onClick={onConnect}>
        {connecting ? "Confirm in wallet…" : "Connect wallet"}
      </button>
      {!walletAvailable && (
        <span className="wallet-hint">
          No wallet extension detected —{" "}
          <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">
            install MetaMask
          </a>{" "}
          to continue.
        </span>
      )}
      {connectError && <span className="wallet-error">{connectError}</span>}
    </div>
  );
}

function shortenAddress(address: string | null): string {
  if (!address) return "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
