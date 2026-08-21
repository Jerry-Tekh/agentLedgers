# On-chain activity: proof the agent worked and GenLayer ran

This document answers two specific reviewer questions directly:

1. **"Where did the agent do any work?"**
2. **"Where was GenLayer actually used?"**

Everything below is a **real transaction on the GenLayer Bradbury testnet** —
not a mock, not a local simulation. You can open each hash in the block
explorer, or replay/read it with the GenLayer CLI.

- **Contract:** `0x0eC3d0D9ae1AFBCbf259DD03253697e5F1103BC0`
- **Chain:** Bradbury testnet (`testnetBradbury`)
- **Explorer:** <https://explorer-bradbury.genlayer.com/>
- **Runner (acts as both client and agent owner):** `0x1847d40A1fc2b69101D943f23Ea35bd3774889D7`
- **Reproduce end-to-end:** `cd frontend && node scripts/onchain_agent_run.mjs`
  — the script is **idempotent**: it reads current on-chain state and skips any
  step already committed, so re-running it against this seeded state just
  re-reads and reports.

## The full agent lifecycle, as three real transactions

### 1. `register_agent` — the agent is verified by an on-chain LLM

- **tx:** `0xd7b9516714a9a4a1a1ef24cedb9d10bde69b0f5f3099b5842704cecf33ecb852`
- **explorer:** <https://explorer-bradbury.genlayer.com/tx/0xd7b9516714a9a4a1a1ef24cedb9d10bde69b0f5f3099b5842704cecf33ecb852>
- **GenLayer used:** `gl.vm.run_nondet_unsafe` (contract L232) → the leader runs
  `_verify_capabilities`, which calls `gl.nondet.web.get(evidence_url)` (L582)
  then `gl.nondet.exec_prompt(...)` (L610); validators independently re-run and
  must agree via `_capability_verdicts_equivalent` (L723) before the
  registration is written.
- **On-chain result** (`get_agent genlayer-doc-agent`):
  ```json
  {
    "verification_status": "verified",
    "confidence": "high",
    "reputation_score": 50,
    "verified_capabilities": [
      "on-chain agent registration with capability verification",
      "escrowed deals",
      "LLM-based deliverable evaluation",
      "bounded reputation scoring"
    ]
  }
  ```
  The `verified_capabilities` list was produced by the on-chain LLM reading the
  evidence URL — it is not something the caller supplied.

### 2. `create_deal` — real GEN escrowed on-chain

- **tx:** `0x73000961e623d129b1f539aefb689200897763dd1d674789e22ae008d4c82025`
- **explorer:** <https://explorer-bradbury.genlayer.com/tx/0x73000961e623d129b1f539aefb689200897763dd1d674789e22ae008d4c82025>
- **GenLayer used:** a payable intelligent-contract method; the contract now
  holds `0.001 GEN` (`1000000000000000` wei) in escrow. `get_deal` returns
  `status: "active"`, `payment_amount: 1000000000000000`.

### 3. `submit_deliverable` — an on-chain LLM grades the work, escrow settles

- **tx:** `0xcf0057f280767262119b9b5cbc222c6d1aeab4ca1642dc652e617a91f6915d49`
- **explorer:** <https://explorer-bradbury.genlayer.com/tx/0xcf0057f280767262119b9b5cbc222c6d1aeab4ca1642dc652e617a91f6915d49>
- **GenLayer used:** `gl.vm.run_nondet_unsafe` (contract L380) → the leader runs
  `_evaluate_deliverable`, which calls `gl.nondet.web.get(deliverable_url)`
  (L634) then `gl.nondet.exec_prompt(...)` (L663) to grade the deliverable
  against the deal's acceptance criteria; validators re-run and must agree via
  `_deal_verdicts_equivalent` (L765).
- **On-chain result** (`get_deal_result genlayer-doc-agent deal-readme-review`):
  ```json
  {
    "deal_id": "deal-readme-review",
    "final_status": "completed",
    "llm_accepted": "true",
    "confidence": "high",
    "quality_score": 85,
    "notes": "The deliverable provides a comprehensive README that clearly documents the system's four core functions: agent registration with capability verification, escrowed deals, LLM-based deliverable evaluation, and the reputation model. It includes practical deployment instructions and a detailed explanation of the contract logic, such as the equivalence principle for verification and the weighted decay reputation system. However, it lacks specific API documentation or example code snippets within the deliverable content to illustrate integration for the TypeScript SDK or frontend."
  }
  ```
- **Settlement:** the deal moved to `status: "completed"`, escrow was released to
  the agent, and the agent's reputation moved **50 → 58** with
  `successful_deals: 1`, `total_deals: 1`.

## Why this proves an LLM ran on-chain (not off-chain)

The `notes` field above is a paragraph of natural-language critique: it credits
the README for covering the four core functions and the equivalence-principle /
weighted-decay logic, then **docks it** for lacking API docs and example code
snippets. **No deterministic smart contract can generate that.** It is the
output of `gl.nondet.exec_prompt` executed inside the contract and agreed by
validators, then committed to contract storage.

Because it is on-chain state, anyone can read it back at any time — no trust in
this document required:

```bash
genlayer call 0x0eC3d0D9ae1AFBCbf259DD03253697e5F1103BC0 \
  get_deal_result --args genlayer-doc-agent deal-readme-review
```

## Reading the raw GenVM trace

```bash
genlayer trace 0xcf0057f280767262119b9b5cbc222c6d1aeab4ca1642dc652e617a91f6915d49
```

The trace's `return_data` is this transaction's storage delta; decoded, it
contains the same LLM verdict text
(`"The deliverable provides a comprehensive README…"`) written to on-chain
storage. One subtlety worth calling out so the trace isn't misread:
`genlayer trace` at **round 0** reports the *deterministic state-application*
round, so its `llm_module.calls` counter reads `0` there. The LLM inference
itself runs during the **leader's consensus round**; its agreed output is what
gets stored — which is exactly what the `get_deal_result` read above returns.

## Where each primitive lives in the contract

See [`contracts/agentledger.py`](../contracts/agentledger.py):

| Line | Code | Purpose |
|---|---|---|
| L232 | `gl.vm.run_nondet_unsafe(leader_fn, validator_fn)` | consensus wrapper in `register_agent` |
| L380 | `gl.vm.run_nondet_unsafe(leader_fn, validator_fn)` | consensus wrapper in `submit_deliverable` |
| L582 | `gl.nondet.web.get(evidence_url)` | on-chain web fetch (capability evidence) |
| L610 | `gl.nondet.exec_prompt(...)` | on-chain LLM (capability verdict) |
| L634 | `gl.nondet.web.get(deliverable_url)` | on-chain web fetch (deliverable) |
| L663 | `gl.nondet.exec_prompt(...)` | on-chain LLM (deliverable grade) |
| L723 | `_capability_verdicts_equivalent` | Equivalence Principle check (registration) |
| L765 | `_deal_verdicts_equivalent` | Equivalence Principle check (deliverable) |
