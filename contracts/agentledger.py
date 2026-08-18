# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""
AgentLedger — On-chain identity, reputation, and escrowed payment rails for
autonomous AI agents.
GenLayer Intelligent Contract (Bradbury testnet)

Implements:
  - Agent registration with web-evidenced capability attestation, verified via
    the Equivalence Principle using a SEMANTIC comparative validator (>=60%
    overlap in verified_capabilities, not a leader-output-only format check).
  - Escrowed deals: GEN is held in THIS contract from create_deal() until a
    deliverable is independently verified. It is never paid out to the agent
    before verification.
  - Reputation as a bounded (0-100) weighted-decay score. A single bad deal
    can only pull the score down by REPUTATION_DECAY_WEIGHT percentage points
    toward the new signal -- it can never be reset to zero in one transaction.
  - A three-way settlement gate per deliverable (completed / pending_review /
    rejected), with an arbiter-resolved dispute path for anything ambiguous.
    "pending_review" NEVER auto-releases funds in either direction.

Storage note: ordered/list-like data (verified_capabilities) is kept as a
JSON-encoded `str` field rather than `DynArray[str]` inside the Agent
dataclass. Nested `DynArray` fields inside custom dataclasses cannot
currently be built with `gl.storage.inmem_allocate` on the pinned SDK build
this contract targets (py-genlayer / genvm v0.2.12) -- `TreeMap[...]`
allocates fine, JSON strings are simplest and calldata-safe, so both are used
instead, following the same pattern GrantOS uses for its milestone lists.
Re-check this on newer SDK releases before switching back to DynArray.

io.net note: the spec's GPU-inference partnership (io.net) is an
infrastructure concern for whichever LLM backend answers `gl.nondet.exec_prompt`,
not a contract-level integration point -- GenVM abstracts the model provider
away from contract code. Nothing here hard-codes an inference backend, so the
contract runs unmodified on testnet today and would keep running unmodified
if validators are later configured against io.net-backed capacity. Flagging
this explicitly per session rule #7: there is no fallback code needed because
there is no direct dependency to fall back from.
"""

from genlayer import *
from dataclasses import dataclass
import json

# ---------------------------------------------------------------------------
# Named constants (no magic numbers)
# ---------------------------------------------------------------------------
CAPABILITY_OVERLAP_THRESHOLD_PCT = 60   # Equivalence Principle: semantic overlap required (spec rule #4)
CONFIDENCE_LEVELS = ("high", "medium", "low")

QUALITY_AUTO_ACCEPT_THRESHOLD = 65      # 0-100. Below this -> never auto-completed.
CONFIDENCE_RANK = {"low": 0, "medium": 1, "high": 2}
ACCEPT_CONFIDENCE_FLOOR = "medium"      # auto-accept needs at least this confidence
REJECT_CONFIDENCE_FLOOR = "high"        # a clean "not accepted" needs at least this confidence to auto-refund

REPUTATION_MIN = 0
REPUTATION_MAX = 100
REPUTATION_DECAY_WEIGHT_PCT = 25        # weight given to the NEW signal each deal (spec rule #3: bounded, incremental)
REPUTATION_INITIAL_VERIFIED = 50
REPUTATION_INITIAL_UNVERIFIED = 20

MAX_EVIDENCE_CHARS = 3000

AGENT_STATUS_VERIFIED = "verified"
AGENT_STATUS_UNVERIFIED = "unverified"

DEAL_STATUS_ACTIVE = "active"
DEAL_STATUS_COMPLETED = "completed"
DEAL_STATUS_REJECTED = "rejected"
DEAL_STATUS_PENDING_REVIEW = "pending_review"
DEAL_STATUS_CANCELLED = "cancelled"

REVIEW_NONE = ""
REVIEW_OPEN = "open"

# Deterministic-error tags (see write-contract skill: error classification)
ERR_EXPECTED = "[EXPECTED]"    # business logic -- exact match required
ERR_EXTERNAL = "[EXTERNAL]"    # external API 4xx -- exact match required
ERR_TRANSIENT = "[TRANSIENT]"  # network/5xx -- agree if both sides hit transient
ERR_LLM = "[LLM_ERROR]"        # LLM misbehavior -- always disagree, force rotation


# ---------------------------------------------------------------------------
# Storage dataclasses (@allow_storage required to live inside TreeMap values).
# Every field is a primitive (str / u256 / Address) -- no nested generics --
# so these can be constructed directly with normal Python syntax.
# ---------------------------------------------------------------------------
@allow_storage
@dataclass
class Agent:
    owner: Address
    capabilities_description: str          # claimed, plain English
    verified_capabilities_json: str        # JSON-encoded list[str]
    verification_status: str               # "verified" | "unverified"
    confidence: str
    evidence_url: str
    reputation_score: u256                 # bounded 0-100, weighted-decay updates only
    total_deals: u256
    successful_deals: u256


@allow_storage
@dataclass
class Deal:
    client: Address
    agent_id: str
    task_description: str
    criteria: str
    payment_amount: u256                   # exact GEN escrowed in this contract
    status: str
    deliverable_url: str
    pending_review: str                    # REVIEW_OPEN while awaiting arbiter, else REVIEW_NONE
    created_seq: u256                      # monotonic counter, NOT a block number:
                                            # GenVM's gl.message exposes no block-height field,
                                            # so a real "created_at_block" isn't available to an IC.


@allow_storage
@dataclass
class DealResult:
    deal_id: str
    llm_accepted: str                      # raw LLM verdict: "true" / "false"
    final_status: str                      # what actually happened after the settlement gate
    quality_score: u256
    confidence: str
    notes: str
    evaluation_seq: u256


# ---------------------------------------------------------------------------
# Contract
# ---------------------------------------------------------------------------
class AgentLedger(gl.Contract):
    arbiter: Address                        # resolves pending_review deals (spec's LexDAO hook, stubbed)
    agents: TreeMap[str, Agent]
    agent_ids: DynArray[str]                # registration order, for paginated directory browsing
    deals: TreeMap[str, Deal]
    deal_ids: DynArray[str]                 # creation order, for paginated deal browsing
    deal_results: TreeMap[str, DealResult]
    next_eval_seq: u256
    next_deal_seq: u256

    def __init__(self, arbiter_address: Address):
        # `genlayer deploy --args <0x…-40-hex>` (and genlayer-js calldata
        # encoding) type a 40-hex value as the `address` calldata type, so
        # on-chain this argument arrives already decoded as an `Address`.
        # Annotating it `str` -- as an earlier revision did -- makes calldata
        # decoding fail BEFORE __init__ runs: the deploy tx is ACCEPTED, but
        # its execution result is FINISHED_WITH_ERROR, every validator
        # DISAGREEs, and no code is written on chain. Direct-mode tests still
        # call the constructor with a hex `str`, so accept either form here.
        if isinstance(arbiter_address, Address):
            self.arbiter = arbiter_address
        else:
            try:
                self.arbiter = Address(arbiter_address)
            except Exception:
                raise gl.vm.UserError(f"{ERR_EXPECTED} '{arbiter_address}' is not a valid arbiter address")
        self.next_eval_seq = u256(0)
        self.next_deal_seq = u256(0)

    # -------------------------------------------------------------------
    # Agent registration -- capability attestation verified against web
    # evidence via a semantic comparative validator.
    # -------------------------------------------------------------------
    @gl.public.write
    def register_agent(
        self,
        agent_id: str,
        capabilities_description: str,   # plain English: "I can write Python, call REST APIs, summarise PDFs"
        evidence_url: str,               # public log / portfolio / GitHub / deployed API docs
        owner_address: str,
    ) -> None:
        if agent_id in self.agents:
            raise gl.vm.UserError(f"{ERR_EXPECTED} agent_id already registered")

        # agent_id is used verbatim inside "agent_id:deal_id"-style result keys
        # elsewhere in this contract (see submit_deliverable). Reject ':' so two
        # different agent_id/deal_id pairs can never collide on the same key --
        # e.g. agent_id="foo:bar" + deal "baz" vs agent_id="foo" + deal "bar:baz".
        if ":" in agent_id:
            raise gl.vm.UserError(f"{ERR_EXPECTED} agent_id must not contain ':'")

        # Collision-risk note (spec rule #5): identity is (owner_address, agent_id).
        # agent_id itself is a single GLOBAL namespace here -- first registration
        # wins, exactly like an npm/crates package name. That means a second
        # owner cannot register the same agent_id (no squatting *overwrite* is
        # possible since the write above already reverts on a duplicate key),
        # but it also means two unrelated developers who both like the name
        # "research-agent-v1" will race for it. This contract does not scope
        # agent_id by owner, because the SDK/spec examples address agents by a
        # bare agent_id string. Callers should namespace their own agent_ids
        # (e.g. "myorg/research-agent-v1") to make collisions vanishingly rare
        # in practice, the same convention npm/crates/PyPI rely on.
        try:
            owner = Address(owner_address)
        except Exception:
            raise gl.vm.UserError(f"{ERR_EXPECTED} '{owner_address}' is not a valid owner address")

        # Without this check, anyone could register an agent claiming an
        # arbitrary owner_address -- including an address they don't control.
        # That's a real impersonation/squatting vector: a griefer could
        # register "well-known-org/flagship-agent" pointing at a victim's
        # address the victim never agreed to, or clients could create deals
        # against an identity nobody who holds that key intends to fulfil,
        # permanently stranding their own escrow (see cancel_deal for the
        # client-side mitigation of that second half). Requiring the caller
        # to BE the owner they're registering closes this off entirely, and
        # costs legitimate callers nothing -- every SDK/UI path here already
        # signs registration with the agent's own wallet.
        if gl.message.sender_address != owner:
            raise gl.vm.UserError(
                f"{ERR_EXPECTED} owner_address must match the calling account -- "
                f"register an agent using the wallet that will own it"
            )

        capabilities_description = str(capabilities_description)
        evidence_url = str(evidence_url)

        def leader_fn():
            return _verify_capabilities(capabilities_description, evidence_url)

        def validator_fn(leader_result) -> bool:
            if not isinstance(leader_result, gl.vm.Return):
                return _handle_leader_error(leader_result, leader_fn)
            leader_data = leader_result.calldata
            try:
                validator_data = leader_fn()
            except gl.vm.UserError:
                return False
            return _capability_verdicts_equivalent(leader_data, validator_data)

        result = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)

        verified = bool(result["verified"])
        confidence = result["confidence"]
        status = AGENT_STATUS_VERIFIED if verified else AGENT_STATUS_UNVERIFIED
        initial_score = REPUTATION_INITIAL_VERIFIED if verified else REPUTATION_INITIAL_UNVERIFIED

        self.agents[agent_id] = Agent(
            owner=owner,
            capabilities_description=capabilities_description,
            verified_capabilities_json=json.dumps(result["verified_capabilities"]),
            verification_status=status,
            confidence=confidence,
            evidence_url=evidence_url,
            reputation_score=u256(initial_score),
            total_deals=u256(0),
            successful_deals=u256(0),
        )
        self.agent_ids.append(agent_id)

        # Integration test sketch (AI runtime call):
        #   await ledger.register({ agentId, capabilities, evidenceUrl })
        #   assert (await ledger.getAgent(agentId)).verificationStatus in ("verified","unverified")

    # -------------------------------------------------------------------
    # Client: create a deal and escrow the GEN for it in THIS contract.
    # -------------------------------------------------------------------
    @gl.public.write.payable
    def create_deal(
        self,
        deal_id: str,
        agent_id: str,
        task_description: str,
        criteria: str,
        payment_amount: int,
    ) -> None:
        if deal_id in self.deals:
            raise gl.vm.UserError(f"{ERR_EXPECTED} deal_id already exists")
        if ":" in deal_id:
            raise gl.vm.UserError(f"{ERR_EXPECTED} deal_id must not contain ':'")
        if agent_id not in self.agents:
            raise gl.vm.UserError(f"{ERR_EXPECTED} agent '{agent_id}' is not registered")
        if int(payment_amount) <= 0:
            raise gl.vm.UserError(f"{ERR_EXPECTED} payment_amount must be positive")

        # Escrow must equal payment_amount exactly: this contract has no
        # generic refund-overpayment path, so any excess GEN would be
        # permanently stuck. Fail loudly instead of silently locking funds.
        if gl.message.value != u256(payment_amount):
            raise gl.vm.UserError(
                f"{ERR_EXPECTED} escrow must equal payment_amount exactly: "
                f"sent {gl.message.value}, need {payment_amount}"
            )

        self.next_deal_seq = self.next_deal_seq + u256(1)
        self.deals[deal_id] = Deal(
            client=gl.message.sender_address,
            agent_id=agent_id,
            task_description=str(task_description),
            criteria=str(criteria),
            payment_amount=u256(payment_amount),
            status=DEAL_STATUS_ACTIVE,
            deliverable_url="",
            pending_review=REVIEW_NONE,
            created_seq=self.next_deal_seq,
        )
        self.deal_ids.append(deal_id)

        # Integration test sketch:
        #   await ledger.createDeal({ dealId, agentId, task, criteria, paymentAmount }, { value: paymentAmount })
        #   assert (await ledger.getDeal(dealId)).status === "active"

    # -------------------------------------------------------------------
    # Client: reclaim escrow for a deal the agent never responded to.
    # Only possible before ANY deliverable has been submitted -- once the
    # agent submits, settlement is out of the client's hands (verification
    # decides it), so a client can't cancel out from under a legitimate,
    # in-flight deliverable. Without this function there is no way to ever
    # move GEN out of an "active" deal that an agent simply ignores forever
    # -- GenVM contracts have no block-height field to build a deadline from
    # (see the Deal.created_seq comment), so this is deliberately a client-
    # initiated release rather than a time-based expiry.
    # -------------------------------------------------------------------
    @gl.public.write
    def cancel_deal(self, deal_id: str) -> None:
        if deal_id not in self.deals:
            raise gl.vm.UserError(f"{ERR_EXPECTED} deal not found")

        deal = self.deals[deal_id]
        if gl.message.sender_address != deal.client:
            raise gl.vm.UserError(f"{ERR_EXPECTED} only the client who created this deal can cancel it")
        if deal.status != DEAL_STATUS_ACTIVE:
            raise gl.vm.UserError(
                f"{ERR_EXPECTED} deal is not active -- a deliverable was already submitted or it was already settled"
            )

        deal.status = DEAL_STATUS_CANCELLED
        self.deals[deal_id] = deal
        _pay(deal.client, deal.payment_amount)

        # Integration test sketch:
        #   await ledger.cancelDeal({ dealId })   // as the original client
        #   assert (await ledger.getDeal(dealId)).status === "cancelled"

    # -------------------------------------------------------------------
    # Agent owner: submit a deliverable -> independently verified, gated
    # settlement. Escrow is only released here, and only on a clean accept.
    # -------------------------------------------------------------------
    @gl.public.write
    def submit_deliverable(
        self,
        deal_id: str,
        deliverable_url: str,
        completion_notes: str,
    ) -> None:
        if deal_id not in self.deals:
            raise gl.vm.UserError(f"{ERR_EXPECTED} deal not found")

        deal = self.deals[deal_id]
        if deal.status != DEAL_STATUS_ACTIVE:
            raise gl.vm.UserError(f"{ERR_EXPECTED} deal is not active")
        if deal.agent_id not in self.agents:
            raise gl.vm.UserError(f"{ERR_EXPECTED} agent no longer registered")

        agent = self.agents[deal.agent_id]
        if gl.message.sender_address != agent.owner:
            raise gl.vm.UserError(f"{ERR_EXPECTED} only the agent's registered owner can submit a deliverable")

        # Copy everything the non-deterministic block needs into plain memory
        # values (storage objects cannot be touched inside leader_fn/validator_fn).
        task_description = str(deal.task_description)
        criteria = str(deal.criteria)
        notes = str(completion_notes)
        url = str(deliverable_url)

        def leader_fn():
            return _evaluate_deliverable(task_description, criteria, notes, url)

        def validator_fn(leader_result) -> bool:
            if not isinstance(leader_result, gl.vm.Return):
                return _handle_leader_error(leader_result, leader_fn)
            leader_data = leader_result.calldata
            try:
                validator_data = leader_fn()
            except gl.vm.UserError:
                return False
            return _deal_verdicts_equivalent(leader_data, validator_data)

        result = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)

        accepted = bool(result["accepted"])
        quality_score = int(result["quality_score"])
        confidence = result["confidence"]

        final_status = _derive_final_status(accepted, quality_score, confidence)

        deal.deliverable_url = url
        self.next_eval_seq = self.next_eval_seq + u256(1)
        self.deal_results[f"{deal.agent_id}:{deal_id}"] = DealResult(
            deal_id=deal_id,
            llm_accepted="true" if accepted else "false",
            final_status=final_status,
            quality_score=u256(max(0, min(100, quality_score))),
            confidence=confidence,
            notes=str(result.get("notes", ""))[:1000],
            evaluation_seq=self.next_eval_seq,
        )

        if final_status == DEAL_STATUS_COMPLETED:
            deal.status = DEAL_STATUS_COMPLETED
            deal.pending_review = REVIEW_NONE
            _settle_deal(self, deal.agent_id, agent, deal.payment_amount, signal=quality_score, won=True)
            _pay(agent.owner, deal.payment_amount)

        elif final_status == DEAL_STATUS_REJECTED:
            # Clean, high-confidence "not accepted" -- refund the client now,
            # no human in the loop needed, same way a bounced check just bounces.
            deal.status = DEAL_STATUS_REJECTED
            deal.pending_review = REVIEW_NONE
            _settle_deal(self, deal.agent_id, agent, deal.payment_amount, signal=quality_score, won=False)
            _pay(deal.client, deal.payment_amount)

        else:  # pending_review -- ambiguous verdict, funds move NEITHER direction
            deal.status = DEAL_STATUS_PENDING_REVIEW
            deal.pending_review = REVIEW_OPEN

        self.deals[deal_id] = deal

        # Integration test sketch:
        #   await ledger.submitDeliverable({ dealId, deliverableUrl, notes })
        #   assert ["completed","rejected","pending_review"].includes((await ledger.getDeal(dealId)).status)

    # -------------------------------------------------------------------
    # Arbiter: resolve a pending_review deal (spec's dispute_agent_deal /
    # LexDAO hook -- LexDAO integration itself is out of scope for testnet,
    # this is the on-chain settlement point a real dispute service would call).
    # -------------------------------------------------------------------
    @gl.public.write
    def resolve_dispute(self, deal_id: str, release_to_agent: bool) -> None:
        if deal_id not in self.deals:
            raise gl.vm.UserError(f"{ERR_EXPECTED} deal not found")
        if gl.message.sender_address != self.arbiter:
            raise gl.vm.UserError(f"{ERR_EXPECTED} only the arbiter can resolve a dispute")

        deal = self.deals[deal_id]
        if deal.pending_review != REVIEW_OPEN:
            raise gl.vm.UserError(f"{ERR_EXPECTED} deal '{deal_id}' is not pending review")
        if deal.agent_id not in self.agents:
            raise gl.vm.UserError(f"{ERR_EXPECTED} agent no longer registered")

        agent = self.agents[deal.agent_id]
        deal.pending_review = REVIEW_NONE

        result_key = f"{deal.agent_id}:{deal_id}"
        prior_quality = 50
        if result_key in self.deal_results:
            prior_quality = int(self.deal_results[result_key].quality_score)

        if release_to_agent:
            deal.status = DEAL_STATUS_COMPLETED
            _settle_deal(self, deal.agent_id, agent, deal.payment_amount, signal=prior_quality, won=True)
            _pay(agent.owner, deal.payment_amount)
        else:
            deal.status = DEAL_STATUS_REJECTED
            _settle_deal(self, deal.agent_id, agent, deal.payment_amount, signal=prior_quality, won=False)
            _pay(deal.client, deal.payment_amount)

        if result_key in self.deal_results:
            r = self.deal_results[result_key]
            r.final_status = deal.status
            self.deal_results[result_key] = r

        self.deals[deal_id] = deal

        # Integration test sketch:
        #   await ledger.resolveDispute({ dealId, releaseToAgent: true })   // as arbiter
        #   assert (await ledger.getDeal(dealId)).status === "completed"

    # -------------------------------------------------------------------
    # Views
    # -------------------------------------------------------------------
    @gl.public.view
    def get_arbiter(self) -> str:
        return str(self.arbiter)

    @gl.public.view
    def get_agent(self, agent_id: str) -> dict:
        if agent_id not in self.agents:
            raise gl.vm.UserError(f"{ERR_EXPECTED} agent not found")
        a = self.agents[agent_id]
        return {
            "owner": str(a.owner),
            "capabilities_description": a.capabilities_description,
            "verified_capabilities": json.loads(a.verified_capabilities_json),
            "verification_status": a.verification_status,
            "confidence": a.confidence,
            "evidence_url": a.evidence_url,
            "reputation_score": int(a.reputation_score),
            "total_deals": int(a.total_deals),
            "successful_deals": int(a.successful_deals),
        }

    @gl.public.view
    def get_deal(self, deal_id: str) -> dict:
        if deal_id not in self.deals:
            raise gl.vm.UserError(f"{ERR_EXPECTED} deal not found")
        d = self.deals[deal_id]
        return {
            "client": str(d.client),
            "agent_id": d.agent_id,
            "task_description": d.task_description,
            "criteria": d.criteria,
            "payment_amount": int(d.payment_amount),
            "status": d.status,
            "deliverable_url": d.deliverable_url,
            "pending_review": d.pending_review,
            "created_seq": int(d.created_seq),
        }

    @gl.public.view
    def list_agents(self, offset: int, limit: int) -> dict:
        """Paginated agent directory. Returns summaries (not full records) so
        a frontend can render a browsable list without N+1 view calls -- the
        frontend can still call get_agent(agent_id) for full detail on click.
        """
        total = len(self.agent_ids)
        offset = max(0, int(offset))
        limit = max(0, min(int(limit), 50))  # bounded page size -- compute limits on O(n) work
        end = min(offset + limit, total)

        summaries = []
        for i in range(offset, end):
            agent_id = str(self.agent_ids[i])
            a = self.agents[agent_id]
            summaries.append({
                "agent_id": agent_id,
                "capabilities_description": a.capabilities_description,
                "verification_status": a.verification_status,
                "reputation_score": int(a.reputation_score),
                "total_deals": int(a.total_deals),
                "successful_deals": int(a.successful_deals),
            })

        return {"total": total, "offset": offset, "limit": limit, "agents": summaries}

    @gl.public.view
    def list_deals(self, offset: int, limit: int) -> dict:
        """Paginated deal directory (most recently created last)."""
        total = len(self.deal_ids)
        offset = max(0, int(offset))
        limit = max(0, min(int(limit), 50))
        end = min(offset + limit, total)

        summaries = []
        for i in range(offset, end):
            deal_id = str(self.deal_ids[i])
            d = self.deals[deal_id]
            summaries.append({
                "deal_id": deal_id,
                "agent_id": d.agent_id,
                "status": d.status,
                "payment_amount": int(d.payment_amount),
                "created_seq": int(d.created_seq),
            })

        return {"total": total, "offset": offset, "limit": limit, "deals": summaries}

    @gl.public.view
    def get_deal_result(self, agent_id: str, deal_id: str) -> dict:
        key = f"{agent_id}:{deal_id}"
        if key not in self.deal_results:
            return {}
        r = self.deal_results[key]
        return {
            "deal_id": r.deal_id,
            "llm_accepted": r.llm_accepted,
            "final_status": r.final_status,
            "quality_score": int(r.quality_score),
            "confidence": r.confidence,
            "notes": r.notes,
            "evaluation_seq": int(r.evaluation_seq),
        }


# ---------------------------------------------------------------------------
# Non-deterministic helpers (run inside leader_fn / validator_fn -- pure
# functions, no storage access)
# ---------------------------------------------------------------------------
def _verify_capabilities(capabilities_description: str, evidence_url: str) -> dict:
    try:
        page = gl.nondet.web.get(evidence_url)
        body = page.body
        if isinstance(body, (bytes, bytearray)):
            body = body.decode("utf-8", errors="ignore")
        evidence = str(body)[:MAX_EVIDENCE_CHARS]
    except Exception as e:
        raise gl.vm.UserError(f"{ERR_TRANSIENT} could not fetch evidence_url: {e}")

    prompt = f"""You are evaluating an AI agent's capability registration for an
on-chain agent directory.

CLAIMED CAPABILITIES:
"{capabilities_description}"

EVIDENCE FROM {evidence_url}:
{evidence}

Does the evidence credibly support the claimed capabilities? Be strict --
only list a capability as verified if the evidence directly demonstrates it.

Respond ONLY with JSON, no other text:
{{
  "verified": true or false,
  "verified_capabilities": ["list of capabilities actually supported by the evidence"],
  "confidence": "high" | "medium" | "low",
  "reasoning": "one sentence"
}}"""

    raw = gl.nondet.exec_prompt(prompt, response_format="json")
    data = _coerce_json(raw)

    if not isinstance(data, dict):
        raise gl.vm.UserError(f"{ERR_LLM} non-dict capability response: {type(data)}")

    confidence = data.get("confidence", "low")
    if confidence not in CONFIDENCE_LEVELS:
        confidence = "low"

    verified_capabilities = data.get("verified_capabilities", [])
    if not isinstance(verified_capabilities, list):
        verified_capabilities = []

    return {
        "verified": bool(data.get("verified", False)),
        "verified_capabilities": [str(c) for c in verified_capabilities],
        "confidence": confidence,
        "reasoning": str(data.get("reasoning", ""))[:500],
    }


def _evaluate_deliverable(task_description: str, criteria: str, completion_notes: str, deliverable_url: str) -> dict:
    try:
        page = gl.nondet.web.get(deliverable_url)
        body = page.body
        if isinstance(body, (bytes, bytearray)):
            body = body.decode("utf-8", errors="ignore")
        content = str(body)[:MAX_EVIDENCE_CHARS]
    except Exception as e:
        raise gl.vm.UserError(f"{ERR_TRANSIENT} could not fetch deliverable_url: {e}")

    prompt = f"""You are a deliverable reviewer settling an escrowed deal between
a client and an autonomous AI agent.

TASK: "{task_description}"
ACCEPTANCE CRITERIA: "{criteria}"
AGENT'S COMPLETION NOTES: "{completion_notes}"

DELIVERABLE CONTENT:
{content}

Evaluate whether this deliverable genuinely satisfies the acceptance criteria.
Check that the work is substantive, not placeholder or scaffolding only.

Respond ONLY with JSON, no other text:
{{
  "accepted": true or false,
  "quality_score": 0-100,
  "notes": "2-3 sentences of specific, actionable feedback",
  "confidence": "high" | "medium" | "low"
}}"""

    raw = gl.nondet.exec_prompt(prompt, response_format="json")
    data = _coerce_json(raw)

    if not isinstance(data, dict):
        raise gl.vm.UserError(f"{ERR_LLM} non-dict deliverable response: {type(data)}")

    confidence = data.get("confidence", "low")
    if confidence not in CONFIDENCE_LEVELS:
        confidence = "low"

    try:
        quality_score = int(round(float(str(data.get("quality_score", 0)).strip())))
    except (TypeError, ValueError):
        raise gl.vm.UserError(f"{ERR_LLM} non-numeric quality_score: {data.get('quality_score')}")
    quality_score = max(0, min(100, quality_score))

    return {
        "accepted": bool(data.get("accepted", False)),
        "quality_score": quality_score,
        "notes": str(data.get("notes", ""))[:1000],
        "confidence": confidence,
    }


def _coerce_json(raw) -> dict:
    """LLMs sometimes wrap JSON in prose or code fences; pull out the object."""
    if isinstance(raw, dict):
        return raw
    text = str(raw).strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise gl.vm.UserError(f"{ERR_LLM} no JSON object found in LLM response")
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError as e:
        raise gl.vm.UserError(f"{ERR_LLM} malformed JSON from LLM: {e}")


def _handle_leader_error(leader_result, leader_fn) -> bool:
    """Canonical validator-side error handler (write-contract skill pattern)."""
    leader_msg = getattr(leader_result, "message", "") or ""
    try:
        leader_fn()
        return False  # leader errored, validator succeeded -> disagree, force rotation
    except gl.vm.UserError as e:
        validator_msg = getattr(e, "message", str(e))
        if validator_msg.startswith(ERR_EXPECTED) or validator_msg.startswith(ERR_EXTERNAL):
            return validator_msg == leader_msg
        if validator_msg.startswith(ERR_TRANSIENT) and leader_msg.startswith(ERR_TRANSIENT):
            return True
        return False  # ERR_LLM or unknown -> always disagree
    except Exception:
        return False


def _capability_verdicts_equivalent(leader: dict, validator: dict) -> bool:
    """Equivalence Principle for capability attestation (spec rule #4): the
    verified boolean must match, and the verified_capabilities lists must
    overlap by at least CAPABILITY_OVERLAP_THRESHOLD_PCT (semantic, case-
    insensitive substring-token comparison -- validators won't phrase a
    capability identically, so exact-string equality would fail consensus
    on trivial rewording).
    """
    if bool(leader["verified"]) != bool(validator["verified"]):
        return False
    if not leader["verified"]:
        # Both sides said "not verified" -- no capability list to compare.
        return True
    return _capabilities_overlap_pct(
        leader["verified_capabilities"], validator["verified_capabilities"]
    ) >= CAPABILITY_OVERLAP_THRESHOLD_PCT


def _capabilities_overlap_pct(list_a: list, list_b: list) -> int:
    """Deterministic pure comparison -- safe to call identically in leader and
    validator. Token-set (Jaccard-style) overlap over normalized capability
    strings, since two LLM runs will describe the same evidence with
    different wording rather than identical strings.
    """
    def tokens(items: list) -> set:
        out = set()
        for item in items:
            for word in str(item).lower().replace(",", " ").split():
                if len(word) > 2:
                    out.add(word)
        return out

    set_a, set_b = tokens(list_a), tokens(list_b)
    if not set_a and not set_b:
        return 100
    if not set_a or not set_b:
        return 0
    overlap = len(set_a & set_b)
    union = len(set_a | set_b)
    return int((overlap * 100) / union) if union else 0


def _deal_verdicts_equivalent(leader: dict, validator: dict) -> bool:
    """Comparative validation for deliverable settlement: both sides must
    derive the SAME final_status (completed/rejected/pending_review), and
    when both land on 'completed' the quality scores must be reasonably
    close. This compares the on-chain settlement effect, not free-form notes.
    """
    leader_final = _derive_final_status(leader["accepted"], leader["quality_score"], leader["confidence"])
    validator_final = _derive_final_status(validator["accepted"], validator["quality_score"], validator["confidence"])
    if leader_final != validator_final:
        return False
    if leader_final == DEAL_STATUS_COMPLETED:
        return abs(leader["quality_score"] - validator["quality_score"]) <= 15
    return True


def _meets_confidence_floor(confidence: str, floor: str) -> bool:
    """Rank-based floor comparison so ACCEPT/REJECT_CONFIDENCE_FLOOR are
    genuinely load-bearing -- raising or lowering either really is the
    one-line change the comments below claim, instead of a constant that
    looks configurable but isn't."""
    return CONFIDENCE_RANK.get(confidence, -1) >= CONFIDENCE_RANK.get(floor, 99)


def _derive_final_status(accepted: bool, quality_score: int, confidence: str) -> str:
    if accepted and _meets_confidence_floor(confidence, ACCEPT_CONFIDENCE_FLOOR) and quality_score >= QUALITY_AUTO_ACCEPT_THRESHOLD:
        return DEAL_STATUS_COMPLETED
    if (not accepted) and _meets_confidence_floor(confidence, REJECT_CONFIDENCE_FLOOR) and quality_score < QUALITY_AUTO_ACCEPT_THRESHOLD:
        return DEAL_STATUS_REJECTED
    return DEAL_STATUS_PENDING_REVIEW


def _settle_deal(contract: "AgentLedger", agent_id: str, agent: Agent, payment_amount: u256, signal: int, won: bool) -> None:
    """Bounded weighted-decay reputation update (spec rule #3): the score
    moves at most REPUTATION_DECAY_WEIGHT_PCT of the way toward `signal` on
    any single deal. It can drift down over repeated failures but can never
    be zeroed out or maxed out in one transaction.
    """
    agent.total_deals = agent.total_deals + u256(1)
    if won:
        agent.successful_deals = agent.successful_deals + u256(1)

    old_score = int(agent.reputation_score)
    clamped_signal = max(REPUTATION_MIN, min(REPUTATION_MAX, int(signal)))
    new_score = (old_score * (100 - REPUTATION_DECAY_WEIGHT_PCT) + clamped_signal * REPUTATION_DECAY_WEIGHT_PCT) // 100
    agent.reputation_score = u256(max(REPUTATION_MIN, min(REPUTATION_MAX, new_score)))

    contract.agents[agent_id] = agent


@gl.evm.contract_interface
class _ExternalRecipient:
    """Used to send GEN to a wallet (EOA) outside this contract -- an external
    message, per GenLayer's value-transfer docs for addresses outside the IC."""
    class View:
        pass
    class Write:
        pass


def _pay(recipient: Address, amount: u256) -> None:
    _ExternalRecipient(recipient).emit_transfer(value=amount)
