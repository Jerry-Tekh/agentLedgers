# Deploying AgentLedger to GenLayer Bradbury

This is the runbook for deploying `contracts/agentledger.py` to the GenLayer
**Bradbury** testnet and verifying that the deploy actually succeeded (not just
that the transaction was accepted). Read the "Root cause" section before
changing the constructor — it explains a non-obvious failure mode that cost a
full debugging session to isolate.

## TL;DR

```bash
# 1. one-time: install CLI, create/import an account, fund it, point at Bradbury
npm install -g genlayer            # provides the `genlayer` CLI
genlayer network set testnet-bradbury

# 2. deploy — the arg is the arbiter address (the account that resolves disputes)
genlayer deploy --contract contracts/agentledger.py --args 0xYOUR_ARBITER_ADDRESS

# 3. verify EXECUTION success, not just acceptance (see "Two kinds of success")
genlayer code    <deployed-address>          # code present  => executed OK
genlayer call    <deployed-address> get_arbiter   # => your arbiter address
genlayer receipt <tx-hash> --status FINALIZED     # wait for finalization
```

## Root cause: the arbiter argument must be typed `Address`, not `str`

The constructor is:

```python
def __init__(self, arbiter_address: Address):
    ...
```

It used to be annotated `arbiter_address: str`, and that annotation silently
broke every real deploy. Here is why.

`genlayer deploy --args` (and the genlayer-js calldata encoder used by
`deploy/deployScript.ts`) **infer the calldata type from the value**. Per
`genlayer deploy --help`:

```
--args <args...>   Contract arguments. Supported types:
    int: 42, -1, 0x1a         (large values auto-use BigInt)
    str: hello, "multi word"
    address: 0x6857...a0 (40 hex chars) or addr#6857...a0
    ...
```

A 40-hex-character `0x…` value is encoded as the **`address`** calldata type.
When the constructor parameter was annotated `str`, GenVM tried to decode an
`address`-typed argument into a `str` parameter, and that decode fails **before
`__init__` ever runs**. The result was maddening to diagnose because the deploy
transaction still came back "successful":

- `genlayer deploy` printed `✔ Contract deployed successfully.`
- …but the receipt's execution result was `FINISHED_WITH_ERROR`,
- every validator voted `DISAGREE`,
- and **no code was written on chain** (`genlayer code <addr>` returned empty).

Annotating the parameter `Address` makes the declared type match what the CLI
actually sends, and the deploy executes cleanly. Direct-mode pytest tests call
the constructor with a hex `str`, so `__init__` also accepts a `str` and wraps
it in `Address(...)` — see the comment in `contracts/agentledger.py`.

## Two kinds of "success" — don't confuse them

GenLayer separates a transaction's **lifecycle status** from its **execution
result**. A deploy can be `ACCEPTED`/`FINALIZED` and still have *failed*:

| Signal | Where | Success looks like | Failure looks like |
|---|---|---|---|
| Lifecycle status | `genlayer receipt` `status_name` | `ACCEPTED` → `FINALIZED` | stuck / reverted |
| Execution result | receipt `txExecutionResultName` | `FINISHED_WITH_RETURN` | `FINISHED_WITH_ERROR` |
| Validator consensus | receipt `validatorVotesName` | all `AGREE` | any/all `DISAGREE` |
| On-chain code | `genlayer code <addr>` | contract source returned | empty |

Always check the bottom three, not just the CLI's `✔ deployed successfully`
line. The single most reliable one-shot check is `genlayer code <addr>`: a
deploy that errored out leaves nothing there.

## Runner is pinned

Line 1 of `contracts/agentledger.py` pins the GenVM runner:

```python
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
```

Keep this header on the first line. It fixes the GenVM/SDK build the contract is
validated against, so deploys stay reproducible instead of drifting with
whatever runner the network defaults to.

## Verifying a deploy end to end

```bash
# execution result + consensus (should be FINISHED_WITH_RETURN, all AGREE)
genlayer receipt <tx-hash> --status ACCEPTED

# on-chain code (should print the contract source)
genlayer code <deployed-address>

# a read call round-trips through the deployed ABI
genlayer call <deployed-address> get_arbiter     # => the arbiter address you passed

# then wait for the finality window to close
genlayer receipt <tx-hash> --status FINALIZED
```

## Production environment variables

The frontend is built once per deployment target — it reads the contract
address and chain from build-time env vars (there is no runtime UI to set
them). Set these in your host's environment (Vercel/Netlify/etc.) **before**
`npm run build`. For the canonical Bradbury deployment recorded in
[`deploy/deployments.json`](../deploy/deployments.json):

```bash
VITE_AGENTLEDGER_CONTRACT_ADDRESS=0x0eC3d0D9ae1AFBCbf259DD03253697e5F1103BC0
VITE_AGENTLEDGER_CHAIN=testnetBradbury
```

`VITE_AGENTLEDGER_CHAIN` must exactly match a chain export name in your
installed `genlayer-js/chains` (`testnetBradbury` as of genlayer-js@1.2.0).
`VITE_AGENTLEDGER_CONTRACT_ADDRESS` must pass a `0x` + 40-hex check or the app
renders its configuration-error screen instead of the directory UI.
