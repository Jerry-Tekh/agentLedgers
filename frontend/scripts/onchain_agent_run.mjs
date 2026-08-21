/**
 * REAL on-chain AgentLedger activity against the deployed Bradbury contract.
 *
 * This is NOT a mock or a local simulation. Every call below is a real
 * transaction submitted to the live GenLayer Bradbury testnet, signed by the
 * wallet in ../.env, against the deployed contract at CONTRACT_ADDRESS. The
 * intelligent methods it invokes each run GenLayer's distinguishing features
 * *inside the contract, on chain*:
 *
 *   register_agent    -> gl.nondet.web.get(evidence_url)   (real web fetch)
 *                        gl.nondet.exec_prompt(...)         (real LLM call)
 *                        gl.vm.run_nondet_unsafe(...)       (validator consensus,
 *                                                            Equivalence Principle)
 *   submit_deliverable -> same three, to grade the deliverable against criteria.
 *
 * The tx hashes this prints are verifiable with `genlayer trace <hash>` (shows
 * the on-chain LLM output + GenVM logs) and `genlayer receipt <hash>`.
 *
 * Run from the frontend/ dir (where genlayer-js resolves):
 *   node scripts/onchain_agent_run.mjs
 * Optional unique tag to avoid id collisions on re-runs:
 *   node scripts/onchain_agent_run.mjs mytag
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const CONTRACT_ADDRESS = "0x0eC3d0D9ae1AFBCbf259DD03253697e5F1103BC0";
const EVIDENCE_URL = "https://raw.githubusercontent.com/Jerry-Tekh/agentLedgers/main/README.md";
const DELIVERABLE_URL = "https://raw.githubusercontent.com/Jerry-Tekh/agentLedgers/main/README.md";

const TAG = process.argv[2] ? `-${process.argv[2]}` : "";
const AGENT_ID = `genlayer-doc-agent${TAG}`;
const DEAL_ID = `deal-readme-review${TAG}`;
const PAYMENT_WEI = 1_000_000_000_000_000n; // 0.001 GEN (18 decimals)

// --- load ../.env (WALLET_ADDRESS, PRIVATE_KEY) without a dotenv dependency ---
const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(here, "../../.env");
const env = {};
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!env.PRIVATE_KEY) throw new Error("PRIVATE_KEY missing from ../.env");

const account = createAccount(env.PRIVATE_KEY.startsWith("0x") ? env.PRIVATE_KEY : `0x${env.PRIVATE_KEY}`);
const OWNER = account.address;
console.log(`signer address: ${OWNER}`);
if (env.WALLET_ADDRESS && env.WALLET_ADDRESS.toLowerCase() !== OWNER.toLowerCase()) {
  console.warn(`WARN: WALLET_ADDRESS (${env.WALLET_ADDRESS}) != derived signer (${OWNER})`);
}

const client = createClient({ chain: testnetBradbury, account });

const hashes = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The public Bradbury RPC rate-limits bursts ("node is at capacity, retry in
// ~Nms" / "gas rate limit exceeded"). That is transient, not a real failure --
// retry the submit a few times before giving up.
function isTransientRpc(err) {
  const m = String(err?.message || err).toLowerCase();
  return m.includes("at capacity") || m.includes("rate limit") || m.includes("exceeds defined limit");
}

async function write(label, functionName, args, value = 0n) {
  console.log(`\n=== ${label}: ${functionName} ===`);
  let hash;
  for (let attempt = 1; ; attempt++) {
    try {
      hash = await client.writeContract({ address: CONTRACT_ADDRESS, functionName, args, value });
      break;
    } catch (err) {
      if (isTransientRpc(err) && attempt <= 8) {
        console.log(`  transient RPC limit (attempt ${attempt}), retrying in 4s...`);
        await sleep(4000);
        continue;
      }
      throw err;
    }
  }
  hashes[label] = hash;
  console.log(`  tx hash: ${hash}`);
  console.log(`  waiting for ACCEPTED (LLM + web + consensus run on chain here)...`);
  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: TransactionStatus.ACCEPTED,
    retries: 150,
    interval: 5000,
  });
  const lr = receipt?.consensus_data?.leader_receipt?.[0];
  console.log(`  status: ${receipt?.status ?? "?"}  execution_result: ${lr?.execution_result ?? "?"}`);
  if (lr?.execution_result && lr.execution_result !== "SUCCESS") {
    console.log(`  !! non-SUCCESS execution -- receipt dump:`);
    console.log(JSON.stringify(receipt, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2).slice(0, 4000));
    throw new Error(`${functionName} did not execute SUCCESS`);
  }
  return receipt;
}

async function read(functionName, args = []) {
  return client.readContract({ address: CONTRACT_ADDRESS, functionName, args });
}

// Non-existent agents/deals make the view revert; treat that as "absent" so
// the script is idempotent and safe to re-run against an already-seeded state.
async function readOrNull(functionName, args = []) {
  try {
    return await read(functionName, args);
  } catch {
    return null;
  }
}

async function main() {
  console.log(`contract: ${CONTRACT_ADDRESS}  chain: testnetBradbury`);
  console.log(`agent_id: ${AGENT_ID}  deal_id: ${DEAL_ID}`);

  // 1. Register the agent. The contract fetches EVIDENCE_URL and asks an LLM
  //    (on chain, under validator consensus) whether it supports the claim.
  //    Skip if this agent_id is already registered (re-registration reverts).
  const existingAgent = await readOrNull("get_agent", [AGENT_ID]);
  if (existingAgent && existingAgent.owner) {
    console.log(`\n=== register_agent: SKIPPED (agent already registered on chain) ===`);
    console.log("  get_agent =>", JSON.stringify(existingAgent));
  } else {
    await write("register_agent", "register_agent", [
      AGENT_ID,
      "Authoring and documenting GenLayer Intelligent Contracts: on-chain agent registration with capability verification, escrowed deals, LLM-based deliverable evaluation, and bounded reputation scoring.",
      EVIDENCE_URL,
      OWNER,
    ]);
    console.log("  get_agent =>", JSON.stringify(await read("get_agent", [AGENT_ID])));
  }

  // 2. Client creates a deal, escrowing real GEN in the contract.
  //    Skip if this deal_id already exists (duplicate create reverts).
  const existingDeal = await readOrNull("get_deal", [DEAL_ID]);
  if (existingDeal && existingDeal.client) {
    console.log(`\n=== create_deal: SKIPPED (deal already exists, status: ${existingDeal.status}) ===`);
    console.log("  get_deal =>", JSON.stringify(existingDeal));
  } else {
    await write(
      "create_deal",
      "create_deal",
      [
        DEAL_ID,
        AGENT_ID,
        "Produce clear technical documentation for the AgentLedger GenLayer intelligent contract.",
        "Documentation must explain agent registration with capability verification, escrowed deals, LLM-based deliverable evaluation, and the reputation model.",
        PAYMENT_WEI,
      ],
      PAYMENT_WEI,
    );
    console.log("  get_deal =>", JSON.stringify(await read("get_deal", [DEAL_ID])));
  }

  // 3. Agent submits the deliverable. The contract fetches DELIVERABLE_URL and
  //    an LLM grades it against the criteria, on chain, under consensus.
  //    Only submit if the deal is still awaiting one (active, no deliverable).
  const dealBeforeSubmit = await readOrNull("get_deal", [DEAL_ID]);
  if (dealBeforeSubmit && dealBeforeSubmit.status === "active" && !dealBeforeSubmit.deliverable_url) {
    await write("submit_deliverable", "submit_deliverable", [
      DEAL_ID,
      DELIVERABLE_URL,
      "Delivered the AgentLedger README, which documents registration, escrow, LLM-based verification, and the reputation model.",
    ]);
  } else {
    console.log(`\n=== submit_deliverable: SKIPPED (deal not awaiting a deliverable) ===`);
    console.log("  get_deal =>", JSON.stringify(dealBeforeSubmit));
  }

  const deal = await read("get_deal", [DEAL_ID]);
  const result = await read("get_deal_result", [AGENT_ID, DEAL_ID]);
  const agent = await read("get_agent", [AGENT_ID]);
  console.log("\n--- final on-chain state ---");
  console.log("  get_deal        =>", JSON.stringify(deal));
  console.log("  get_deal_result =>", JSON.stringify(result));
  console.log("  get_agent       =>", JSON.stringify(agent));

  console.log("\n=== TX HASHES (verify with `genlayer trace <hash>`) ===");
  for (const [k, v] of Object.entries(hashes)) console.log(`  ${k}: ${v}`);
}

main()
  .then(() => {
    console.log("\nDONE: real on-chain agent activity completed.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nON-CHAIN RUN FAILED:", err?.message || err);
    console.error("tx hashes so far:", JSON.stringify(hashes));
    process.exit(1);
  });
