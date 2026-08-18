import React, { useState } from "react";
import type { AgentSummary } from "../lib/contract";

export function CreateDealForm({
  agents,
  presetAgentId,
  onSubmit,
  onCancel,
  busy,
}: {
  agents: AgentSummary[];
  presetAgentId?: string;
  onSubmit: (args: {
    dealId: string;
    agentId: string;
    taskDescription: string;
    criteria: string;
    paymentGen: number;
  }) => Promise<void>;
  onCancel: () => void;
  busy: boolean;
}) {
  const [dealId, setDealId] = useState(`deal-${Date.now()}`);
  const [agentId, setAgentId] = useState(presetAgentId ?? "");
  const [taskDescription, setTaskDescription] = useState("");
  const [criteria, setCriteria] = useState("");
  const [paymentGen, setPaymentGen] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="panel">
      <h3 style={{ marginTop: 0, fontWeight: 600 }}>Create a deal</h3>
      <p className="hint">
        Payment is escrowed in the contract the moment you create this deal. It only moves once — either to
        the agent on a verified accept, or back to you on a clean reject. Anything ambiguous is held for the
        arbiter, funds don't move either way until then.
      </p>

      <div className="form-grid">
        <div className="config-field">
          <label>Deal ID</label>
          <input className="field-input" value={dealId} onChange={(e) => setDealId(e.target.value)} />
        </div>

        <div className="config-field">
          <label>Agent</label>
          <select className="field-select" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Select an agent…</option>
            {agents.map((a) => (
              <option key={a.agent_id} value={a.agent_id}>
                {a.agent_id} · rep {a.reputation_score}
              </option>
            ))}
          </select>
        </div>

        <div className="config-field span-2">
          <label>Task description</label>
          <textarea className="field-textarea" value={taskDescription} onChange={(e) => setTaskDescription(e.target.value)} />
        </div>

        <div className="config-field span-2">
          <label>Acceptance criteria</label>
          <textarea
            className="field-textarea"
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            placeholder="Be specific — this is what the validator checks the deliverable against."
          />
        </div>

        <div className="config-field">
          <label>Payment (GEN)</label>
          <input
            className="field-input"
            type="number"
            min="0"
            step="0.01"
            value={paymentGen}
            onChange={(e) => setPaymentGen(e.target.value)}
          />
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className="form-actions">
        <button className="btn btn-outline" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={busy || !dealId || !agentId || !taskDescription || !criteria || !paymentGen}
          onClick={async () => {
            setError(null);
            try {
              await onSubmit({
                dealId,
                agentId,
                taskDescription,
                criteria,
                paymentGen: parseFloat(paymentGen),
              });
            } catch (e: any) {
              setError(e?.message ?? String(e));
            }
          }}
        >
          {busy ? "Escrowing…" : "Create deal & escrow GEN"}
        </button>
      </div>
    </div>
  );
}
