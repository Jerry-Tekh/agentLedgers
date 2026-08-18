import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import {
  AgentLedgerApi,
  type GLClient,
  type AgentSummary,
  type AgentRecord,
  type DealSummary,
  type DealRecord,
  type DealResult,
} from "../lib/contract";
import { connectWallet, onAccountsChanged, onChainChanged, type EIP1193Provider } from "../lib/wallet";
import { loadConfig } from "../lib/env";
import { ConnectWalletBar } from "../components/ConnectWalletBar";
import { ConfigErrorScreen } from "../components/ConfigErrorScreen";
import { Stamp } from "../components/Stamp";
import { RegisterAgentForm } from "../components/RegisterAgentForm";
import { CreateDealForm } from "../components/CreateDealForm";
import { AgentDrawer } from "../components/AgentDrawer";
import { DealDrawer } from "../components/DealDrawer";

type Tab = "directory" | "deals";

export default function AppView({ onBackToLanding }: { onBackToLanding: () => void }) {
  // env vars never change at runtime -- compute once instead of re-parsing
  // and re-allocating a fresh config object on every render, which was
  // silently defeating the useCallback memoization on refreshDirectory/
  // refreshDeals below (a new object reference every render made their
  // `[client, config]` dep array "change" every time even when nothing
  // actually did).
  const { config, error: configError } = useMemo(() => loadConfig(), []);

  const [client, setClient] = useState<GLClient | null>(null);
  const [currentAddress, setCurrentAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const providerRef = useRef<EIP1193Provider | null>(null);

  const [tab, setTab] = useState<Tab>("directory");

  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentsTotal, setAgentsTotal] = useState(0);
  const [deals, setDeals] = useState<DealSummary[]>([]);
  const [dealsTotal, setDealsTotal] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showRegister, setShowRegister] = useState(false);
  const [showCreateDeal, setShowCreateDeal] = useState(false);
  const [presetAgentId, setPresetAgentId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<AgentRecord | null>(null);
  const [selectedDealId, setSelectedDealId] = useState<string | null>(null);
  const [selectedDeal, setSelectedDeal] = useState<DealRecord | null>(null);
  const [selectedDealAgentOwner, setSelectedDealAgentOwner] = useState<string | null>(null);
  const [selectedDealResult, setSelectedDealResult] = useState<DealResult | Record<string, never> | null>(null);
  const [arbiterAddress, setArbiterAddress] = useState<string | null>(null);

  const connected = !!client;

  const refreshDirectory = useCallback(async () => {
    if (!client || !config) return;
    setLoadError(null);
    try {
      const page = await AgentLedgerApi.listAgents(client, config.contractAddress, 0, 50);
      setAgents(page.agents);
      setAgentsTotal(page.total);
    } catch (e: any) {
      setLoadError(e?.message ?? String(e));
    }
  }, [client, config]);

  const refreshDeals = useCallback(async () => {
    if (!client || !config) return;
    setLoadError(null);
    try {
      const page = await AgentLedgerApi.listDeals(client, config.contractAddress, 0, 50);
      setDeals([...page.deals].reverse());
      setDealsTotal(page.total);
    } catch (e: any) {
      setLoadError(e?.message ?? String(e));
    }
  }, [client, config]);

  useEffect(() => {
    if (connected && config) {
      refreshDirectory();
      refreshDeals();
      AgentLedgerApi.getArbiter(client!, config.contractAddress)
        .then(setArbiterAddress)
        .catch(() => setArbiterAddress(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  function handleDisconnect() {
    setClient(null);
    setCurrentAddress(null);
    providerRef.current = null;
    setAgents([]);
    setDeals([]);
    setArbiterAddress(null);
  }

  useEffect(() => {
    if (!providerRef.current) return;
    const provider = providerRef.current;
    const offAccounts = onAccountsChanged(provider, (accounts) => {
      if (!accounts.length) {
        handleDisconnect();
      } else {
        setCurrentAddress(accounts[0]);
      }
    });
    const offChain = onChainChanged(provider, () => {
      setConnectError("Wallet network changed — reconnect to sync with this app's configured network.");
      handleDisconnect();
    });
    return () => {
      offAccounts();
      offChain();
    };
  }, [client]);

  async function handleConnectWallet() {
    if (!config) return;
    setConnectError(null);
    setConnecting(true);
    try {
      const { client: c, address, provider } = await connectWallet(config.chainName);
      setClient(c);
      setCurrentAddress(address);
      providerRef.current = provider;
    } catch (e: any) {
      setConnectError(e?.message ?? String(e));
    } finally {
      setConnecting(false);
    }
  }

  async function openAgent(agentId: string) {
    setSelectedAgentId(agentId);
    setSelectedAgent(null);
    if (!client || !config) return;
    const a = await AgentLedgerApi.getAgent(client, config.contractAddress, agentId);
    setSelectedAgent(a);
  }

  async function openDeal(dealId: string, agentId: string) {
    setSelectedDealId(dealId);
    setSelectedDeal(null);
    setSelectedDealResult(null);
    setSelectedDealAgentOwner(null);
    if (!client || !config) return;
    const [d, r] = await Promise.all([
      AgentLedgerApi.getDeal(client, config.contractAddress, dealId),
      AgentLedgerApi.getDealResult(client, config.contractAddress, agentId, dealId),
    ]);
    setSelectedDeal(d);
    setSelectedDealResult(r);
    try {
      const a = await AgentLedgerApi.getAgent(client, config.contractAddress, d.agent_id);
      setSelectedDealAgentOwner(a.owner);
    } catch {
      setSelectedDealAgentOwner(null);
    }
  }

  if (!config) {
    return <ConfigErrorScreen error={configError!} />;
  }

  return (
    <div className="page">
      <nav className="navbar">
        <button className="brand" onClick={onBackToLanding}>
          <span className="brand-mark">AL</span>
          <span className="brand-name">AgentLedger</span>
        </button>
        <div className="navbar-stats">
          <span>
            <b>{agentsTotal}</b> agents
          </span>
          <span>
            <b>{dealsTotal}</b> deals
          </span>
        </div>
        <ConnectWalletBar
          chainName={config.chainName}
          connected={connected}
          connecting={connecting}
          currentAddress={currentAddress}
          connectError={connectError}
          onConnect={handleConnectWallet}
          onDisconnect={handleDisconnect}
        />
      </nav>

      <div className="tabs">
        <button className={`tab ${tab === "directory" ? "active" : ""}`} onClick={() => setTab("directory")}>
          Directory
        </button>
        <button className={`tab ${tab === "deals" ? "active" : ""}`} onClick={() => setTab("deals")}>
          Deals
        </button>
      </div>

      {loadError && <div className="alert alert-error">{loadError}</div>}

      {!connected && (
        <div className="empty-state">
          Connect a wallet to browse the agent directory and create deals. You'll only be asked to sign
          when you register an agent, create a deal, submit a deliverable, or resolve a dispute.
        </div>
      )}

      {connected && tab === "directory" && (
        <>
          <div className="section-head">
            <div>
              <h2>Agent directory</h2>
              <p className="section-note">
                Every capability claim was checked by an independent validator quorum against a public
                evidence URL before it was accepted.
              </p>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => setShowRegister((s) => !s)}>
              {showRegister ? "Close" : "Register agent"}
            </button>
          </div>

          {showRegister && (
            <RegisterAgentForm
              defaultOwner={currentAddress ?? ""}
              busy={busy}
              onCancel={() => setShowRegister(false)}
              onSubmit={async (args) => {
                if (!client) return;
                setBusy(true);
                try {
                  await AgentLedgerApi.registerAgent(client, config.contractAddress, args);
                  setShowRegister(false);
                  await refreshDirectory();
                } finally {
                  setBusy(false);
                }
              }}
            />
          )}

          <div className="ledger">
            {agents.length === 0 && <div className="empty-state">No agents registered yet.</div>}
            {agents.map((a, i) => (
              <div className="ledger-row" key={a.agent_id} onClick={() => openAgent(a.agent_id)}>
                <span className="ledger-idx">{String(i + 1).padStart(3, "0")}</span>
                <div className="ledger-main">
                  <div className="ledger-id">{a.agent_id}</div>
                  <div className="ledger-desc">{a.capabilities_description}</div>
                </div>
                <Stamp status={a.verification_status} />
                <div>
                  <div className="rep-score">{a.reputation_score}</div>
                  <div className="rep-bar">
                    <div className="rep-bar-fill" style={{ width: `${a.reputation_score}%` }} />
                  </div>
                </div>
                <button
                  className="btn btn-outline btn-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPresetAgentId(a.agent_id);
                    setShowCreateDeal(true);
                    setTab("deals");
                  }}
                >
                  Hire
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {connected && tab === "deals" && (
        <>
          <div className="section-head">
            <div>
              <h2>Deals</h2>
              <p className="section-note">Escrow moves only on a verified outcome — open any deal for its full trail.</p>
            </div>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => {
                setPresetAgentId(undefined);
                setShowCreateDeal((s) => !s);
              }}
            >
              {showCreateDeal ? "Close" : "Create deal"}
            </button>
          </div>

          {showCreateDeal && (
            <CreateDealForm
              key={presetAgentId ?? "no-preset"}
              agents={agents}
              presetAgentId={presetAgentId}
              busy={busy}
              onCancel={() => setShowCreateDeal(false)}
              onSubmit={async (args) => {
                if (!client) return;
                setBusy(true);
                try {
                  await AgentLedgerApi.createDeal(client, config.contractAddress, args);
                  setShowCreateDeal(false);
                  await refreshDeals();
                } finally {
                  setBusy(false);
                }
              }}
            />
          )}

          <div className="ledger">
            {deals.length === 0 && <div className="empty-state">No deals recorded yet.</div>}
            {deals.map((d) => (
              <div className="ledger-row" key={d.deal_id} onClick={() => openDeal(d.deal_id, d.agent_id)}>
                <span className="ledger-idx">{String(d.created_seq).padStart(3, "0")}</span>
                <div className="ledger-main">
                  <div className="ledger-id">{d.deal_id}</div>
                  <div className="ledger-desc">with {d.agent_id}</div>
                </div>
                <Stamp status={d.status} />
                <div className="rep-score">{(d.payment_amount / 1e18).toFixed(2)} GEN</div>
                <span />
              </div>
            ))}
          </div>
        </>
      )}

      {selectedAgentId && (
        <AgentDrawer
          agent={selectedAgent}
          agentId={selectedAgentId}
          onClose={() => setSelectedAgentId(null)}
          onHire={() => {
            setPresetAgentId(selectedAgentId);
            setSelectedAgentId(null);
            setShowCreateDeal(true);
            setTab("deals");
          }}
        />
      )}

      {selectedDealId && (
        <DealDrawer
          deal={selectedDeal}
          dealId={selectedDealId}
          result={selectedDealResult}
          isArbiter={!!currentAddress && !!arbiterAddress && currentAddress.toLowerCase() === arbiterAddress.toLowerCase()}
          isAgentOwner={
            !!currentAddress && !!selectedDealAgentOwner && currentAddress.toLowerCase() === selectedDealAgentOwner.toLowerCase()
          }
          isClient={!!currentAddress && !!selectedDeal && currentAddress.toLowerCase() === selectedDeal.client.toLowerCase()}
          busy={busy}
          onClose={() => setSelectedDealId(null)}
          onSubmitDeliverable={async (args) => {
            if (!client || !selectedDealId) return;
            setBusy(true);
            try {
              await AgentLedgerApi.submitDeliverable(client, config.contractAddress, {
                dealId: selectedDealId,
                ...args,
              });
              await openDeal(selectedDealId, selectedDeal?.agent_id ?? "");
              await refreshDeals();
            } finally {
              setBusy(false);
            }
          }}
          onResolveDispute={async (releaseToAgent) => {
            if (!client || !selectedDealId) return;
            setBusy(true);
            try {
              await AgentLedgerApi.resolveDispute(client, config.contractAddress, {
                dealId: selectedDealId,
                releaseToAgent,
              });
              await openDeal(selectedDealId, selectedDeal?.agent_id ?? "");
              await refreshDeals();
            } finally {
              setBusy(false);
            }
          }}
          onCancelDeal={async () => {
            if (!client || !selectedDealId) return;
            setBusy(true);
            try {
              await AgentLedgerApi.cancelDeal(client, config.contractAddress, { dealId: selectedDealId });
              await openDeal(selectedDealId, selectedDeal?.agent_id ?? "");
              await refreshDeals();
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </div>
  );
}
