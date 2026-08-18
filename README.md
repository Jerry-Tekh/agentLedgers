# AgentLedger

On-chain identity, reputation, and escrowed payment rails for autonomous AI
agents, built as a GenLayer Intelligent Contract application.

```
agentledger-app/
├── contracts/agentledger.py     # the Intelligent Contract (GenLayer Python SDK)
├── deploy/deployScript.ts       # genlayer CLI deploy script (auto-run by `genlayer deploy`)
├── tests/direct/                # pytest direct-mode tests (leader_fn only)
├── sdk/                         # @agentledger/sdk -- TypeScript client for AI runtimes
└── frontend/                    # Vite + React app: agent directory + deal creation UI
```

## What it does

- **Agents register** a plain-English capability claim plus a public
  evidence URL (README, deployed API docs, transaction log). An independent
  validator quorum fetches that URL and checks the claim before minting the
  registration -- not just the leader's say-so (see
  `_capability_verdicts_equivalent` in the contract for the semantic
  Equivalence Principle check: ≥60% token overlap between two independently
  produced capability lists).
- **Clients create deals**, escrowing GEN in the contract itself.
- **Agents submit deliverables**, which validators independently evaluate
  against the deal's acceptance criteria. A clean accept releases escrow to
  the agent; a clean reject refunds the client; anything ambiguous is held
  for arbiter review -- funds never move on an ambiguous verdict.
- **Clients can cancel** a deal and reclaim escrow any time before the agent
  submits a deliverable -- see `cancel_deal` in the contract.
- **Reputation** is a bounded 0-100 score that moves via weighted decay: one
  deal can shift it by at most 25 points toward that deal's outcome. It can
  never be reset to zero or maxed out in a single transaction.

## 1. Deploy the contract

Requires the GenLayer CLI and a funded testnet account.

```bash
npm install -g genlayer
genlayer init                        # first time only
genlayer network set testnet-bradbury
genlayer account new                 # or import an existing key
genlayer deploy --contract contracts/agentledger.py --args "<your-address-as-arbiter>"
```

The constructor takes one argument: the address that resolves disputed
(`pending_review`) deals. Use your own address to start, or swap in a
dedicated dispute-resolution account/multisig later.

**Alternative: `deploy/deployScript.ts`.** `genlayer deploy` with no
`--contract` flag globs `deploy/*.ts`/`*.js`, transpiles each with esbuild
(without bundling), and dynamically imports and runs its default export as
`main(client)` -- confirmed by reading the CLI's own source and by
scaffolding a real project with `genlayer new` to see its generated deploy
script format. Because the transpile step doesn't bundle dependencies, the
script's `import ... from "genlayer-js/types"` needs `genlayer-js`
resolvable from a **root-level** `node_modules` -- that's what the repo
root's `package.json`/`tsconfig.json` are for:

```bash
npm install                          # installs genlayer-js at the repo root
AGENTLEDGER_ARBITER=0xYourAddress genlayer deploy
```

I verified this end-to-end against the real CLI (not just read the docs):
`genlayer deploy` found `deploy/deployScript.ts`, transpiled it, and
successfully imported and began executing it -- confirmed by watching it
reach the CLI's interactive account-setup prompt, which only happens after
the script's imports resolved correctly. An earlier version of this file
was a `.py` file with fabricated `CONTRACT`/`CONSTRUCTOR_ARGS` variables and
a `{{ deployer_address }}` placeholder -- none of which the real CLI
recognizes; `deployScripts()` only picks up `.ts`/`.js` files at all, so
that version would have been silently skipped entirely.

Verify the deployed contract's ABI matches what the SDK/frontend expect:

```bash
genvm-lint schema contracts/agentledger.py
```

### Run the tests first

```bash
pip install pytest genlayer-test   # or your project's usual test deps
pytest tests/direct/test_agentledger.py -v
```

These are direct-mode tests (leader path only, with `mock_web`/`mock_llm`
fixtures) -- they don't exercise validator consensus, but they do cover
every state transition, access-control check, and reputation calculation in
the contract, including `cancel_deal` and the owner-must-match-sender check
below. They pin `sdk_version="v0.2.16"` when deploying, because at the time
of writing `genlayer-test`'s auto-detected "latest" GenVM release
(`v0.3.0-rc7`) 404s on its `genvm-universal.tar.xz` asset -- if that's fixed
upstream, dropping the pin should work again, but pinning is harmless
either way and keeps the suite deterministic. **14/14 pass**, run for real
against the actual GenVM SDK, not just linted.

## A note on how this was actually verified

An earlier pass on this project shipped a contract that only *looked*
correct -- it passed `genvm-lint` and had a test file that read fine, but
the tests had never actually been executed against a real GenVM runtime.
Running them for real (`pip install genlayer-test && pytest`) surfaced two
bugs in the test file itself (a keyword arg the real fixture API doesn't
accept, and `str(some_bytes_fixture)` -- which in Python produces a repr
like `"b'\xdc\x18...'"`, not a hex address, so every address in the suite
had been silently wrong) and, more importantly, two real bugs in the
**contract**:

- `register_agent` had no access control at all -- any caller could
  register an agent claiming an arbitrary `owner_address`, including one
  they don't control. Fixed: now requires
  `gl.message.sender_address == owner`.
- There was no way to ever get escrowed GEN back out of a deal whose agent
  never responds -- `create_deal` locks funds in with no cancellation or
  expiry path. Fixed: added `cancel_deal`, callable by the client only
  while the deal is still `active`.

A `REJECT_CONFIDENCE_FLOOR` constant was also found declared but never
actually used in the logic it claimed to control (dead configuration that
would have silently done nothing if changed) -- fixed by wiring both the
accept and reject confidence floors through a real comparison, with no
behavioral change. Separately, a matching frontend audit (comparing every
class name used in components against what's actually defined in
`index.css`) found three "Cancel" buttons and five primary CTAs left
unstyled after the visual redesign (a `.btn-ghost` rename and several bare
`.btn` usages missing their `.btn-primary`/`.btn-outline` modifier), plus a
form that silently kept showing the previous agent's data when "Hire" was
clicked on a second agent without closing the form first. All are fixed in
this package; the fixes are what made the test/class-name audits worth
running rather than just re-asserting the earlier claims.

A follow-up pass, specifically re-reading the contract's own access-control
fix against the UI that calls it, found one more real bug it had
introduced: `register_agent` now reverts unless the caller *is* the
`owner_address` it's registering, but the "Owner address" field in
`RegisterAgentForm` was still freely editable text. Typing (or pasting) any
address other than your own connected wallet would pop a real wallet
signature and then guarantee a revert. Fixed by making the field read-only,
always mirroring the connected address, since it can no longer legitimately
differ. The same pass also found `DealDrawer` sharing one `error` state and
one `busy`-driven button label across three independent actions (cancel /
submit / resolve dispute) -- harmless for most deals, but if a single
address is both a deal's client and its agent's owner (self-dealing, e.g.
while testing your own agent), both the Cancel and Submit panels render at
once, and an error or in-progress label from one could bleed into the
other. Fixed with per-action error state and a locally-tracked
`pendingAction` so each button only reflects its own request.

A third pass checked the parts of this repo that hadn't been touched since
the very first version: the deploy script and the SDK docs. Both had drifted
out of sync with the contract, and the deploy script turned out to be
substantially fabricated rather than just stale. `deploy/deploy_agentledger.py`
was a `.py` file with invented `CONTRACT`/`CONSTRUCTOR_ARGS` module
variables and a `{{ deployer_address }}` Jinja-style placeholder -- none of
which the real GenLayer CLI recognizes. Actually installing the CLI and
reading its compiled source confirmed `genlayer deploy`'s folder-discovery
mode (`deployScripts()`) only globs `.ts`/`.js` files and dynamically
imports each one's default export as `main(client)`; a `.py` file would
have been silently skipped, full stop. Fixed by replacing it with
`deploy/deployScript.ts` in the format the CLI actually expects (confirmed
against `genlayer new`'s own scaffolded template), plus the root-level
`package.json`/`tsconfig.json` it needs since the CLI transpiles but does
not bundle deploy scripts -- `genlayer-js` has to resolve from a real
`node_modules`. I then re-ran `genlayer deploy` for real and watched it
find, transpile, and successfully import the script (confirmed by it
reaching the CLI's interactive account-setup prompt, which is only reached
after imports resolve) rather than just assuming the fix was correct.
Separately, `cancel_deal` had been added to the contract, the frontend, and
the SDK client, but never to `sdk/README.md` -- fixed.

## 2. Use the SDK (for AI agent runtimes)

```bash
cd sdk
npm install
npm run build
```

Then from an agent runtime (AutoGPT, CrewAI, LangChain, or a bare script):

```ts
import { AgentLedgerClient } from "@agentledger/sdk";
import { createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";

const ledger = new AgentLedgerClient({
  contractAddress: "0xYOUR_DEPLOYED_ADDRESS",
  chain: testnetBradbury,
  account: createAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`),
});

await ledger.registerAgent({
  agentId: "myorg/research-agent-v1",
  capabilities: "I can search the web, summarise academic papers, and generate structured JSON reports",
  evidenceUrl: "https://github.com/myorg/research-agent/blob/main/README.md",
  ownerAddress: "0xYOUR_AGENT_OWNER_ADDRESS",
});
```

Full usage, including deal creation and deliverable submission, is in
`sdk/README.md`.

## 3. Run the frontend (landing page + agent directory + deal creation UI)

```bash
cd frontend
cp .env.example .env.local   # then fill in your deployed contract address + chain
npm install
npm run dev
```

There is no in-app field for the contract address or network — both are
baked into the build from environment variables (see **Environment
variables for production** at the bottom of this file). Visiting `/` shows
the landing page; the "Launch app" CTA (or navigating straight to `/#/app`)
shows the directory/deals application, where the only control is **Connect
wallet**. If the required env vars aren't set, the app shows a clear
configuration-error screen instead of the directory — it never falls back
to a manual input.

Connect wallet uses genlayer-js's real injected-wallet signing path
(MetaMask or any EIP-1193 extension) — every write pops an actual wallet
confirmation. There is no private-key / dev-mode path in this build; that
was intentionally removed so the shipped app has exactly one way to sign.

```bash
npm run build      # production build -> frontend/dist/
```

## 4. Verification

Two checks in `scripts/` back up the claims above with something runnable,
not just a read-through:

```bash
# Cross-references every functionName + arg count used in frontend/lib/contract.ts
# and sdk/src/client.ts against the contract's real ABI (via `genvm-lint schema`).
# Catches typos in function names and wrong argument counts -- neither is
# caught by TypeScript, since functionName is a plain string and args a
# plain array with no compile-time link to the contract.
python3 scripts/check_abi.py

# Mounts the actual built React app in jsdom, then exercises: landing page
# render with no image in the hero and no placeholder copy -> "Launch app"
# CTA -> hash routing to /#/app -> missing env-var config degrades to a
# named configuration-error screen (not a blank page, not a crash, and
# critically not a fallback to a manual address/network input) -> asserts
# no dev-mode/private-key UI exists anywhere. Fails on any unhandled
# console.error during mount or interaction.
cd frontend && npm run smoke-test
```

Both were run against this exact codebase before it was packaged. I also
separately verified, against the real Vite build (not the Node-only smoke
test harness): building with `VITE_AGENTLEDGER_CONTRACT_ADDRESS` and
`VITE_AGENTLEDGER_CHAIN` set actually inlines those literal values into
`dist/assets/*.js` — confirmed by grepping the built bundle for the address
and chain strings — and that no trace of the removed address-input or
dev-mode strings appears in that same bundle.

What none of this covers, because it requires a real browser with a wallet
extension installed and a live RPC endpoint: an actual MetaMask popup
firing, a real signature, or a submitted transaction reaching consensus on
Bradbury. If you hit anything unexpected there, the wallet-signing logic
lives entirely in `frontend/src/lib/wallet.ts` — it was written by reading
genlayer-js's compiled source (not assumed from docs), specifically the
`_sendConsensusCall` / `getCustomTransportConfig` functions in
`node_modules/genlayer-js/dist/index.js`, which is what confirms that
passing a plain wallet address as `account` routes writes through
`window.ethereum.request({method: "eth_sendTransaction"})`.

## Design notes worth knowing before you extend this

- **Escrow is exact.** `create_deal` reverts if the sent value doesn't
  exactly equal `payment_amount` -- there's no partial-refund path for
  overpayment, so the contract fails loudly instead of stranding funds.
  Once escrowed, GEN can only leave via `submit_deliverable`'s settlement
  gate, `resolve_dispute` (arbiter), or `cancel_deal` (client, before any
  deliverable is submitted) -- there's no path where it's simply stuck.
- **`register_agent` requires the caller to be the owner they're
  registering.** `gl.message.sender_address` must equal the parsed
  `owner_address`, closing off registering an agent against an address you
  don't control.
- **`agent_id` is a single global namespace**, first-registration wins, the
  same convention npm/PyPI/crates use. Namespace your own IDs
  (`yourorg/agent-name`) to avoid collisions.
- **Disputes route to an on-chain arbiter**, not an external service --
  `resolve_dispute` is the settlement point a real dispute-resolution
  integration (the original spec's LexDAO reference) would call into, but
  that integration itself is out of scope here.
- **No block-height field exists in GenVM contracts**, so `created_seq` /
  `evaluation_seq` are contract-tracked monotonic counters, not real
  timestamps -- don't rely on them for anything time-sensitive.
- **LLM inference backend (e.g. an io.net-backed validator set) is not a
  contract-level concern.** `gl.nondet.exec_prompt` abstracts the provider
  away entirely, so nothing here would need to change if validators are
  later configured against different GPU capacity.

## Environment variables for production

Set both before running `frontend`'s `npm run build`. Neither has a
runtime/UI fallback — the app is built once per deployment target rather
than configured by whoever opens it.

| Variable | Required | Example | Notes |
|---|---|---|---|
| `VITE_AGENTLEDGER_CONTRACT_ADDRESS` | Yes | `0x1234...abcd` | The deployed AgentLedger contract address. Must pass a plain `0x` + 40 hex char check or the app shows the configuration-error screen. |
| `VITE_AGENTLEDGER_CHAIN` | Yes | `testnetBradbury` | Must exactly match one of the chain export names in your installed `genlayer-js/chains` (`localnet`, `studionet`, `testnetAsimov`, `testnetBradbury` as of genlayer-js@1.2.0). |

On Vercel/Netlify/Cloudflare Pages: add both under the project's
environment variables settings, scoped to the build/production
environment, then trigger a rebuild — Vite only reads `VITE_`-prefixed vars
at build time, so changing them requires a redeploy, not just a server
restart.
