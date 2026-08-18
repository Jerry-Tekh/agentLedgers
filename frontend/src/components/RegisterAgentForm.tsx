import React, { useState } from "react";

export function RegisterAgentForm({
  defaultOwner,
  onSubmit,
  onCancel,
  busy,
}: {
  defaultOwner: string;
  onSubmit: (args: { agentId: string; capabilities: string; evidenceUrl: string; ownerAddress: string }) => Promise<void>;
  onCancel: () => void;
  busy: boolean;
}) {
  const [agentId, setAgentId] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Owner is NOT user-editable: the contract requires the calling wallet to
  // equal owner_address exactly (see register_agent's access-control check),
  // so an editable field here would let someone type in a mismatched address,
  // sign a real transaction, and have it guaranteed-revert. It's always the
  // connected wallet.
  const ownerAddress = defaultOwner;

  return (
    <div className="panel">
      <h3 style={{ marginTop: 0, fontWeight: 600 }}>
        Register an agent
      </h3>
      <p className="hint">
        Capability claims are checked against your evidence URL by an independent validator quorum before the
        registration is accepted — a public README, deployed API docs, or transaction log all work. Use a
        namespaced ID (e.g. <code>yourorg/agent-name</code>) since agent IDs are a single global namespace.
      </p>

      <div className="form-grid">
        <div className="config-field span-2">
          <label>Agent ID</label>
          <input className="field-input" value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="myorg/research-agent-v1" />
        </div>

        <div className="config-field span-2">
          <label>Claimed capabilities (plain English)</label>
          <textarea
            className="field-textarea"
            value={capabilities}
            onChange={(e) => setCapabilities(e.target.value)}
            placeholder="I can search the web, summarise academic papers, and generate structured JSON reports"
          />
        </div>

        <div className="config-field span-2">
          <label>Evidence URL</label>
          <input
            className="field-input"
            value={evidenceUrl}
            onChange={(e) => setEvidenceUrl(e.target.value)}
            placeholder="https://github.com/yourorg/agent/blob/main/README.md"
          />
        </div>

        <div className="config-field span-2">
          <label>Owner address</label>
          <input className="field-input" value={ownerAddress} readOnly disabled />
          <p className="hint">
            Always your connected wallet — the contract requires the registering account to be the owner, so
            this can't be changed here.
          </p>
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className="form-actions">
        <button className="btn btn-outline" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={busy || !agentId || !capabilities || !evidenceUrl || !ownerAddress}
          onClick={async () => {
            setError(null);
            try {
              await onSubmit({ agentId, capabilities, evidenceUrl, ownerAddress });
            } catch (e: any) {
              setError(e?.message ?? String(e));
            }
          }}
        >
          {busy ? "Verifying against evidence…" : "Register agent"}
        </button>
      </div>
    </div>
  );
}
