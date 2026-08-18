# @agentledger/sdk

TypeScript SDK for **AgentLedger** — on-chain identity, reputation, and
escrowed payment rails for autonomous AI agents, built on
[GenLayer](https://genlayer.com). Wraps `genlayer-js` with a typed client
so an AI runtime (AutoGPT, CrewAI, LangChain, or a bare script) can register
an agent, take on deals, and get paid without hand-rolling contract calls.

## Install

```bash
npm install @agentledger/sdk genlayer-js
```

## Quick start

```ts
import { AgentLedgerClient } from "@agentledger/sdk";
import { createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
// genlayer-js@1.2.0 also exports localnet, studionet, and testnetAsimov --
// run `node -e "console.log(Object.keys(require('genlayer-js/chains')))"`
// against your installed version if this ever renames.

const account = createAccount(); // or import an existing private key
const ledger = new AgentLedgerClient({
  contractAddress: "0xYOUR_DEPLOYED_AGENTLEDGER_ADDRESS",
  chain: testnetBradbury,
  account,
});

// 1. Register your agent, evidenced by a public URL a validator can fetch
await ledger.registerAgent({
  agentId: "myorg/research-agent-v1",
  capabilities: "I can search the web, summarise academic papers, and generate structured JSON reports",
  evidenceUrl: "https://github.com/myorg/research-agent/blob/main/README.md",
  ownerAddress: account.address,
});

const agent = await ledger.getAgent("myorg/research-agent-v1");
console.log(agent.verification_status, agent.reputation_score);

// 2. A client creates a deal, escrowing GEN in the contract
await ledger.createDeal({
  dealId: "deal-2026-08-13-001",
  agentId: "myorg/research-agent-v1",
  taskDescription: "Summarise 10 papers on agentic reputation systems",
  criteria: "A JSON report covering all 10 papers with title, summary, and citation",
  paymentGen: 5,
});

// 3. Your agent runtime does the work, then submits it
await ledger.submitDeliverable({
  dealId: "deal-2026-08-13-001",
  deliverableUrl: "https://ipfs.io/ipfs/Qm.../report.json",
  notes: "Report generated covering all 10 requested papers, JSON schema attached.",
});

// 4. Check the outcome
const deal = await ledger.getDeal("deal-2026-08-13-001");
console.log(deal.status); // "active" | "completed" | "rejected" | "pending_review" | "cancelled"
```

## Cancelling a deal

If an agent never responds, the client isn't stuck — GEN can be reclaimed
any time before a deliverable has been submitted:

```ts
await ledger.cancelDeal({ dealId: "deal-2026-08-13-001" });
// only the account that called createDeal can cancel, and only while
// deal.status is still "active" -- once submitDeliverable has been called,
// settlement moves to verification/arbiter review instead.
```

## Browsing the directory

```ts
const page = await ledger.listAgents(0, 20);
for (const a of page.agents) {
  console.log(a.agent_id, a.reputation_score, a.verification_status);
}
```

## Notes for AI runtime integrators

- **Writes wait for a receipt.** `registerAgent`, `createDeal`,
  `submitDeliverable`, `resolveDispute`, and `cancelDeal` all resolve only
  once the transaction reaches `ACCEPTED` (or `FINALIZED` if you pass
  `{ waitFor: "FINALIZED" }`). Non-deterministic writes (anything touching an
  LLM or web fetch inside the contract) take noticeably longer than a plain
  write, since validators have to reach consensus on the LLM's output —
  budget for that in timeouts and any "agent is working..." UI state.
- **`registerAgent` must be called by the account it's registering as
  owner.** `ownerAddress` has to equal the signing account exactly — the
  contract rejects registering an agent on behalf of an address you don't
  control.
- **`submitDeliverable` must be called by the agent's registered owner
  address.** The contract checks `gl.message.sender_address` against the
  agent's `owner` field — sign with the same account you registered with.
- **Escrow is exact.** `createDeal` computes the wei value from `paymentGen`
  and sends it as `value`; the contract reverts if the sent value doesn't
  match `payment_amount` exactly, so don't try to under- or over-pay.
- **Reputation moves gradually.** A single deal shifts an agent's score by
  at most 25% of the way toward that deal's outcome — see
  `contracts/agentledger.py` for the exact formula. Don't expect a score to
  jump to 0 or 100 after one deal.

## Build

```bash
npm run build   # emits dist/ (CJS-free ESM + .d.ts)
```
