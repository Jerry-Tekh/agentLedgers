import React, { useState } from "react";
import type { DealRecord, DealResult } from "../lib/contract";
import { Stamp } from "./Stamp";

export function DealDrawer({
  deal,
  dealId,
  result,
  isArbiter,
  isAgentOwner,
  isClient,
  onClose,
  onSubmitDeliverable,
  onResolveDispute,
  onCancelDeal,
  busy,
}: {
  deal: DealRecord | null;
  dealId: string;
  result: DealResult | Record<string, never> | null;
  isArbiter: boolean;
  isAgentOwner: boolean;
  isClient: boolean;
  onClose: () => void;
  onSubmitDeliverable: (args: { deliverableUrl: string; notes: string }) => Promise<void>;
  onResolveDispute: (releaseToAgent: boolean) => Promise<void>;
  onCancelDeal: () => Promise<void>;
  busy: boolean;
}) {
  const [deliverableUrl, setDeliverableUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [disputeError, setDisputeError] = useState<string | null>(null);
  // `busy` from the parent correctly disables every button at once (so two
  // actions can't fire concurrently), but it's one shared flag -- without
  // tracking locally which specific button was pressed, every panel's
  // loading label would flip to its "in progress" text together, even the
  // ones the user didn't click. Only relevant when a single address is both
  // the deal's client and the agent's owner (self-dealing), since that's the
  // only case where more than one action panel renders at once.
  const [pendingAction, setPendingAction] = useState<"cancel" | "submit" | "dispute" | null>(null);

  const hasResult = result && "final_status" in result;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <h3>{dealId}</h3>
        {!deal ? (
          <p className="hint">Loading…</p>
        ) : (
          <>
            <div style={{ margin: "8px 0 20px" }}>
              <Stamp status={deal.status} />
            </div>

            <div className="drawer-row">
              <span>Agent</span>
              <span>{deal.agent_id}</span>
            </div>
            <div className="drawer-row">
              <span>Client</span>
              <span>{deal.client}</span>
            </div>
            <div className="drawer-row">
              <span>Escrowed payment</span>
              <span>{(deal.payment_amount / 1e18).toFixed(4)} GEN</span>
            </div>
            <div className="drawer-row">
              <span>Task</span>
              <span>{deal.task_description}</span>
            </div>
            <div className="drawer-row">
              <span>Acceptance criteria</span>
              <span>{deal.criteria}</span>
            </div>
            {deal.deliverable_url && (
              <div className="drawer-row">
                <span>Deliverable</span>
                <span>
                  <a href={deal.deliverable_url} target="_blank" rel="noreferrer">
                    {deal.deliverable_url}
                  </a>
                </span>
              </div>
            )}

            {hasResult && "quality_score" in result! && (
              <>
                <div className="drawer-row">
                  <span>Quality score</span>
                  <span>{result.quality_score} / 100</span>
                </div>
                <div className="drawer-row">
                  <span>Reviewer notes</span>
                  <span>{result.notes}</span>
                </div>
              </>
            )}

            {deal.status === "active" && isClient && (
              <div className="panel" style={{ marginTop: 20 }}>
                <h4 style={{ margin: "0 0 8px", fontWeight: 600 }}>Cancel this deal</h4>
                <p className="hint">
                  No deliverable has been submitted yet. Cancelling refunds your escrowed GEN immediately —
                  once the agent submits, this option disappears and settlement moves to verification instead.
                </p>
                {cancelError && <div className="form-error">{cancelError}</div>}
                <div className="form-actions">
                  <button
                    className="btn btn-outline"
                    disabled={busy}
                    onClick={async () => {
                      setCancelError(null);
                      setPendingAction("cancel");
                      try {
                        await onCancelDeal();
                      } catch (e: any) {
                        setCancelError(e?.message ?? String(e));
                      } finally {
                        setPendingAction(null);
                      }
                    }}
                  >
                    {busy && pendingAction === "cancel" ? "Cancelling…" : "Cancel & refund"}
                  </button>
                </div>
              </div>
            )}

            {deal.status === "active" && isAgentOwner && (
              <div className="panel" style={{ marginTop: 20 }}>
                <h4 style={{ margin: "0 0 8px", fontWeight: 600 }}>
                  Submit deliverable
                </h4>
                <div className="config-field" style={{ marginBottom: 10 }}>
                  <label>Deliverable URL</label>
                  <input className="field-input" value={deliverableUrl} onChange={(e) => setDeliverableUrl(e.target.value)} />
                </div>
                <div className="config-field">
                  <label>Completion notes</label>
                  <textarea className="field-textarea" value={notes} onChange={(e) => setNotes(e.target.value)} />
                </div>
                {submitError && <div className="form-error">{submitError}</div>}
                <div className="form-actions">
                  <button
                    className="btn btn-primary"
                    disabled={busy || !deliverableUrl}
                    onClick={async () => {
                      setSubmitError(null);
                      setPendingAction("submit");
                      try {
                        await onSubmitDeliverable({ deliverableUrl, notes });
                      } catch (e: any) {
                        setSubmitError(e?.message ?? String(e));
                      } finally {
                        setPendingAction(null);
                      }
                    }}
                  >
                    {busy && pendingAction === "submit" ? "Verifying against criteria…" : "Submit for verification"}
                  </button>
                </div>
              </div>
            )}

            {deal.status === "pending_review" && isArbiter && (
              <div className="panel" style={{ marginTop: 20 }}>
                <h4 style={{ margin: "0 0 8px", fontWeight: 600 }}>
                  Resolve dispute
                </h4>
                <p className="hint">
                  The independent validator quorum couldn't reach a clean auto-accept or auto-reject on this
                  deliverable. As arbiter, decide where the escrow goes.
                </p>
                {disputeError && <div className="form-error">{disputeError}</div>}
                <div className="form-actions">
                  <button
                    className="btn btn-outline"
                    disabled={busy}
                    onClick={async () => {
                      setDisputeError(null);
                      try {
                        await onResolveDispute(false);
                      } catch (e: any) {
                        setDisputeError(e?.message ?? String(e));
                      }
                    }}
                  >
                    Refund client
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={async () => {
                      setDisputeError(null);
                      try {
                        await onResolveDispute(true);
                      } catch (e: any) {
                        setDisputeError(e?.message ?? String(e));
                      }
                    }}
                  >
                    Release to agent
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
