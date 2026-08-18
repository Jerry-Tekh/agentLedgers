import { createClient } from "genlayer-js";
import { TransactionStatus } from "genlayer-js/types";
import type { CalldataEncodable } from "genlayer-js/types";
import { AVAILABLE_CHAINS, type ChainName } from "./wallet";

export { AVAILABLE_CHAINS };
export type { ChainName };

export type GLClient = ReturnType<typeof createClient>;

async function write(
  client: GLClient,
  address: string,
  functionName: string,
  args: CalldataEncodable[],
  value: bigint,
) {
  const hash = await client.writeContract({
    address: address as `0x${string}`,
    functionName,
    args,
    value,
  });
  return client.waitForTransactionReceipt({
    hash,
    status: TransactionStatus.ACCEPTED,
    retries: 100,
    interval: 5000,
  });
}

function read<T>(client: GLClient, address: string, functionName: string, args: CalldataEncodable[] = []) {
  return client.readContract({
    address: address as `0x${string}`,
    functionName,
    args,
  }) as Promise<T>;
}

const GEN_DECIMALS = 18n;
export function toWei(gen: number): bigint {
  return BigInt(Math.round(gen * 1e6)) * 10n ** (GEN_DECIMALS - 6n);
}
export function fromWei(wei: number | bigint): number {
  return Number(BigInt(wei)) / 10 ** Number(GEN_DECIMALS);
}

// ---- Typed contract calls ----

export interface AgentSummary {
  agent_id: string;
  capabilities_description: string;
  verification_status: "verified" | "unverified";
  reputation_score: number;
  total_deals: number;
  successful_deals: number;
}

export interface AgentRecord extends AgentSummary {
  owner: string;
  verified_capabilities: string[];
  confidence: string;
  evidence_url: string;
}

export interface DealSummary {
  deal_id: string;
  agent_id: string;
  status: "active" | "completed" | "rejected" | "pending_review" | "cancelled";
  payment_amount: number;
  created_seq: number;
}

export interface DealRecord extends Omit<DealSummary, "payment_amount"> {
  client: string;
  task_description: string;
  criteria: string;
  payment_amount: number;
  deliverable_url: string;
  pending_review: string;
}

export interface DealResult {
  deal_id: string;
  llm_accepted: "true" | "false";
  final_status: DealSummary["status"];
  quality_score: number;
  confidence: string;
  notes: string;
  evaluation_seq: number;
}

export const AgentLedgerApi = {
  getArbiter: (client: GLClient, address: string) => read<string>(client, address, "get_arbiter", []),

  listAgents: (client: GLClient, address: string, offset = 0, limit = 20) =>
    read<{ total: number; offset: number; limit: number; agents: AgentSummary[] }>(
      client,
      address,
      "list_agents",
      [offset, limit],
    ),

  getAgent: (client: GLClient, address: string, agentId: string) =>
    read<AgentRecord>(client, address, "get_agent", [agentId]),

  registerAgent: (
    client: GLClient,
    address: string,
    args: { agentId: string; capabilities: string; evidenceUrl: string; ownerAddress: string },
  ) =>
    write(client, address, "register_agent", [
      args.agentId,
      args.capabilities,
      args.evidenceUrl,
      args.ownerAddress,
    ], 0n),

  listDeals: (client: GLClient, address: string, offset = 0, limit = 20) =>
    read<{ total: number; offset: number; limit: number; deals: DealSummary[] }>(
      client,
      address,
      "list_deals",
      [offset, limit],
    ),

  getDeal: (client: GLClient, address: string, dealId: string) =>
    read<DealRecord>(client, address, "get_deal", [dealId]),

  getDealResult: (client: GLClient, address: string, agentId: string, dealId: string) =>
    read<DealResult | Record<string, never>>(client, address, "get_deal_result", [agentId, dealId]),

  createDeal: (
    client: GLClient,
    address: string,
    args: { dealId: string; agentId: string; taskDescription: string; criteria: string; paymentGen: number },
  ) => {
    const wei = toWei(args.paymentGen);
    return write(
      client,
      address,
      "create_deal",
      [args.dealId, args.agentId, args.taskDescription, args.criteria, wei],
      wei,
    );
  },

  submitDeliverable: (
    client: GLClient,
    address: string,
    args: { dealId: string; deliverableUrl: string; notes: string },
  ) =>
    write(client, address, "submit_deliverable", [args.dealId, args.deliverableUrl, args.notes], 0n),

  resolveDispute: (client: GLClient, address: string, args: { dealId: string; releaseToAgent: boolean }) =>
    write(client, address, "resolve_dispute", [args.dealId, args.releaseToAgent], 0n),

  cancelDeal: (client: GLClient, address: string, args: { dealId: string }) =>
    write(client, address, "cancel_deal", [args.dealId], 0n),
};
