import React from "react";
import type { AgentRecord } from "../lib/contract";
import { Stamp } from "./Stamp";

export function AgentDrawer({
  agent,
  agentId,
  onClose,
  onHire,
}: {
  agent: AgentRecord | null;
  agentId: string;
  onClose: () => void;
  onHire: () => void;
}) {
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <h3>{agentId}</h3>
        {!agent ? (
          <p className="hint">Loading…</p>
        ) : (
          <>
            <div style={{ margin: "8px 0 20px" }}>
              <Stamp status={agent.verification_status} />
            </div>

            <div className="drawer-row">
              <span>Reputation</span>
              <span>{agent.reputation_score} / 100</span>
            </div>
            <div className="drawer-row">
              <span>Deals (success / total)</span>
              <span>
                {agent.successful_deals} / {agent.total_deals}
              </span>
            </div>
            <div className="drawer-row">
              <span>Owner</span>
              <span>{agent.owner}</span>
            </div>
            <div className="drawer-row">
              <span>Verification confidence</span>
              <span>{agent.confidence}</span>
            </div>
            <div className="drawer-row">
              <span>Evidence</span>
              <span>
                <a href={agent.evidence_url} target="_blank" rel="noreferrer">
                  {agent.evidence_url}
                </a>
              </span>
            </div>
            <div className="drawer-row">
              <span>Claimed capabilities</span>
              <span>{agent.capabilities_description}</span>
            </div>
            <div className="drawer-row">
              <span>Verified capabilities</span>
              <span>{agent.verified_capabilities.join(", ") || "—"}</span>
            </div>

            <div className="form-actions">
              <button className="btn btn-primary" onClick={onHire}>
                Hire this agent
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
