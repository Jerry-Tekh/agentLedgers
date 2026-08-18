import { createClient } from "genlayer-js";
import { TransactionStatus } from "genlayer-js/types";
import type { CalldataEncodable } from "genlayer-js/types";
import type {
  AgentLedgerConfig,
  AgentRecord,
  AgentListPage,
  DealRecord,
  DealListPage,
  DealResult,
} from "./types.js";

/** GEN uses 18 decimals, same as ETH -- amounts in this SDK are in whole GEN. */
const GEN_DECIMALS = 18n;
export function toWei(gen: number): bigint {
  // Avoid float rounding on the multiply by working in integer-scaled steps.
  return BigInt(Math.round(gen * 1e6)) * 10n ** (GEN_DECIMALS - 6n);
}
export function fromWei(wei: number | bigint): number {
  return Number(BigInt(wei)) / 10 ** Number(GEN_DECIMALS);
}

export interface WriteOptions {
  /** Which lifecycle status to wait for. Defaults to "ACCEPTED" (faster than FINALIZED). */
  waitFor?: "ACCEPTED" | "FINALIZED";
}

/**
 * Thin, typed wrapper around a deployed AgentLedger contract. Every write
 * method submits the transaction and waits for a receipt before resolving --
 * AI agent runtimes generally want a definite before/after, not a bare tx
 * hash to poll themselves. Pass `{ waitFor: "FINALIZED" }` if you need the
 * stronger consensus-final guarantee instead of the default "ACCEPTED".
 *
 * Non-deterministic writes (register_agent, submit_deliverable,
 * resolve_dispute) call out to an LLM and often a web fetch inside contract
 * execution, so validators take noticeably longer to reach consensus than a
 * plain state write. Callers integrating this into a UI should show a
 * loading state, not assume near-instant confirmation.
 */
export class AgentLedgerClient {
  private client: ReturnType<typeof createClient>;
  private address: `0x${string}`;

  constructor(config: AgentLedgerConfig) {
    this.address = config.contractAddress as `0x${string}`;
    this.client = createClient({
      chain: config.chain as any,
      endpoint: config.endpoint,
      account: config.account as any,
    });
  }

  private async write(
    functionName: string,
    args: CalldataEncodable[],
    value: bigint,
    opts?: WriteOptions,
  ) {
    const hash = await this.client.writeContract({
      address: this.address,
      functionName,
      args,
      value,
    });
    const status =
      opts?.waitFor === "FINALIZED" ? TransactionStatus.FINALIZED : TransactionStatus.ACCEPTED;
    return this.client.waitForTransactionReceipt({ hash, status, retries: 100, interval: 5000 });
  }

  private read<T>(functionName: string, args: CalldataEncodable[] = []): Promise<T> {
    return this.client.readContract({
      address: this.address,
      functionName,
      args,
    }) as Promise<T>;
  }

  async getArbiter(): Promise<string> {
    return this.read<string>("get_arbiter");
  }

  // -------------------------------------------------------------------
  // Agent registration
  // -------------------------------------------------------------------

  /** Register an agent's identity + capability claim, evidenced by a public URL. */
  async registerAgent(
    params: {
      agentId: string;
      capabilities: string;
      evidenceUrl: string;
      ownerAddress: string;
    },
    opts?: WriteOptions,
  ) {
    return this.write(
      "register_agent",
      [params.agentId, params.capabilities, params.evidenceUrl, params.ownerAddress],
      0n,
      opts,
    );
  }

  async getAgent(agentId: string): Promise<AgentRecord> {
    return this.read<AgentRecord>("get_agent", [agentId]);
  }

  /** Browse the agent directory in pages of up to 50. */
  async listAgents(offset = 0, limit = 20): Promise<AgentListPage> {
    return this.read<AgentListPage>("list_agents", [offset, limit]);
  }

  // -------------------------------------------------------------------
  // Deals
  // -------------------------------------------------------------------

  /** Create a deal, escrowing `paymentGen` GEN in the contract until settlement. */
  async createDeal(
    params: {
      dealId: string;
      agentId: string;
      taskDescription: string;
      criteria: string;
      paymentGen: number;
    },
    opts?: WriteOptions,
  ) {
    const paymentWei = toWei(params.paymentGen);
    return this.write(
      "create_deal",
      [params.dealId, params.agentId, params.taskDescription, params.criteria, paymentWei],
      paymentWei,
      opts,
    );
  }

  async getDeal(dealId: string): Promise<DealRecord> {
    return this.read<DealRecord>("get_deal", [dealId]);
  }

  async listDeals(offset = 0, limit = 20): Promise<DealListPage> {
    return this.read<DealListPage>("list_deals", [offset, limit]);
  }

  /** Submit a deliverable. Must be called by the agent's registered owner address. */
  async submitDeliverable(
    params: { dealId: string; deliverableUrl: string; notes: string },
    opts?: WriteOptions,
  ) {
    return this.write(
      "submit_deliverable",
      [params.dealId, params.deliverableUrl, params.notes],
      0n,
      opts,
    );
  }

  async getDealResult(agentId: string, dealId: string): Promise<DealResult | Record<string, never>> {
    return this.read("get_deal_result", [agentId, dealId]);
  }

  /** Arbiter-only: resolve a deal stuck in pending_review. */
  async resolveDispute(
    params: { dealId: string; releaseToAgent: boolean },
    opts?: WriteOptions,
  ) {
    return this.write("resolve_dispute", [params.dealId, params.releaseToAgent], 0n, opts);
  }

  /**
   * Client-only: reclaim escrow for a deal the agent never responded to.
   * Only works while the deal is still "active" -- once a deliverable has
   * been submitted, settlement is out of the client's hands.
   */
  async cancelDeal(params: { dealId: string }, opts?: WriteOptions) {
    return this.write("cancel_deal", [params.dealId], 0n, opts);
  }
}
