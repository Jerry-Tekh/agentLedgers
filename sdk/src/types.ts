/**
 * Types mirroring AgentLedger's on-chain ABI (contracts/agentledger.py).
 * Keep these in sync with the contract's return dicts -- there is no
 * schema-generation step in this repo yet, so a contract change means a
 * manual update here too.
 */

export type VerificationStatus = "verified" | "unverified";
export type DealStatus = "active" | "completed" | "rejected" | "pending_review" | "cancelled";
export type Confidence = "high" | "medium" | "low";
export type LlmAccepted = "true" | "false";

export interface AgentRecord {
  owner: string;
  capabilities_description: string;
  verified_capabilities: string[];
  verification_status: VerificationStatus;
  confidence: Confidence;
  evidence_url: string;
  reputation_score: number;
  total_deals: number;
  successful_deals: number;
}

export interface AgentSummary {
  agent_id: string;
  capabilities_description: string;
  verification_status: VerificationStatus;
  reputation_score: number;
  total_deals: number;
  successful_deals: number;
}

export interface DealRecord {
  client: string;
  agent_id: string;
  task_description: string;
  criteria: string;
  payment_amount: number;
  status: DealStatus;
  deliverable_url: string;
  pending_review: string; // "open" | ""
  created_seq: number;
}

export interface DealSummary {
  deal_id: string;
  agent_id: string;
  status: DealStatus;
  payment_amount: number;
  created_seq: number;
}

export interface DealResult {
  deal_id: string;
  llm_accepted: LlmAccepted;
  final_status: DealStatus;
  quality_score: number;
  confidence: Confidence;
  notes: string;
  evaluation_seq: number;
}

export interface AgentListPage {
  total: number;
  offset: number;
  limit: number;
  agents: AgentSummary[];
}

export interface DealListPage {
  total: number;
  offset: number;
  limit: number;
  deals: DealSummary[];
}

export interface AgentLedgerConfig {
  /** Deployed AgentLedger contract address (0x...). */
  contractAddress: string;
  /**
   * A genlayer-js chain export -- `testnetBradbury`, `testnetAsimov`,
   * `studionet`, or `localnet` as of genlayer-js@1.2.0. Check
   * `genlayer-js/chains` for the current set if you're on a different
   * version, since chain identifiers have moved between SDK releases.
   */
  chain: unknown;
  /** Optional custom RPC endpoint, overriding the chain default. */
  endpoint?: string;
  /**
   * Signing account: either the object returned by genlayer-js's
   * `createAccount()`, or a bare address string to defer signing to an
   * injected wallet (e.g. MetaMask) in a browser context. Omit for
   * read-only usage (views only).
   */
  account?: unknown;
}
