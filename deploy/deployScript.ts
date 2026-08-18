/**
 * Deploy script for AgentLedger.
 *
 * Verified against the actual GenLayer CLI (not guessed): `genlayer deploy`
 * with no --contract flag calls deployScripts(), which globs deploy/*.ts
 * and deploy/*.js (sorted, supporting a leading numeric prefix like
 * "01_deploy.ts" for ordering), dynamically imports each file, and calls
 * its default export as `main(client)` -- confirmed by reading
 * genlayer's compiled CLI source and by scaffolding a real project with
 * `genlayer new` to see its generated deploy/deployScript.ts.
 *
 * Run:
 *   genlayer network set testnet-bradbury   # or studionet / localnet
 *   AGENTLEDGER_ARBITER=0xYourAddress genlayer deploy
 *
 * Or deploy directly without this script:
 *   genlayer deploy --contract contracts/agentledger.py --args 0xYourAddress
 */

import { readFileSync } from "fs";
import path from "path";
import { TransactionHash, TransactionStatus, GenLayerClient } from "genlayer-js/types";

export default async function main(client: GenLayerClient<any>) {
  const filePath = path.resolve(process.cwd(), "contracts/agentledger.py");

  // The constructor takes one argument: the address that resolves disputed
  // (pending_review) deals via resolve_dispute(). Set AGENTLEDGER_ARBITER
  // explicitly -- falling back silently to some default address here would
  // be easy to deploy by accident with the wrong arbiter.
  const arbiterAddress = process.env.AGENTLEDGER_ARBITER;
  if (!arbiterAddress) {
    throw new Error(
      "Set AGENTLEDGER_ARBITER to the address that should resolve disputes before running this deploy script, " +
        'e.g. `AGENTLEDGER_ARBITER=0x... genlayer deploy`.',
    );
  }

  try {
    const contractCode = new Uint8Array(readFileSync(filePath));

    await client.initializeConsensusSmartContract();

    const deployTransaction = await client.deployContract({
      code: contractCode,
      args: [arbiterAddress],
    });

    const receipt = await client.waitForTransactionReceipt({
      hash: deployTransaction as TransactionHash,
      status: TransactionStatus.ACCEPTED,
      retries: 200,
    });

    if (receipt.consensus_data?.leader_receipt[0]?.execution_result !== "SUCCESS") {
      throw new Error(`Deployment failed. Receipt: ${JSON.stringify(receipt)}`);
    }

    console.log("\nAgentLedger deployed successfully.", {
      "Transaction Hash": deployTransaction,
      "Contract Address": receipt.data?.contract_address,
      Arbiter: arbiterAddress,
    });
  } catch (error) {
    throw new Error(`Error during AgentLedger deployment: ${error}`);
  }
}
