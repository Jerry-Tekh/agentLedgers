"""
Direct-mode tests for AgentLedger.

Run with:
    pytest tests/direct/test_agentledger.py -v

Direct mode runs the leader_fn only -- validator_fn / consensus equivalence
is NOT exercised here (that needs integration tests against a live network
or Studio). These tests cover state transitions, access control, and the
LLM/web response parsing paths via direct_vm.mock_web / direct_vm.mock_llm.

Address handling note: the direct_alice / direct_bob / direct_owner / etc.
fixtures return raw 20-byte Python `bytes` objects, NOT hex strings.
Contract methods that take an address as a `str` parameter need a real hex
string -- `str(some_bytes)` produces Python's bytes repr ("b'\\xdc...'"),
which is not a valid address and was silently wrong in an earlier version
of this file. Use addr_hex() below for every address passed as a string
argument. direct_vm.sender, by contrast, takes the raw bytes/fixture value
directly -- do not addr_hex() that one.
"""

import json

CONTRACT = "contracts/agentledger.py"
SDK_VERSION = "v0.2.16"  # pinned: 'latest' currently 404s on genvm-universal.tar.xz


def addr_hex(b: bytes) -> str:
    return "0x" + b.hex()


def _register_verified_agent(direct_vm, contract, sender, agent_id="research-agent-v1", owner=None):
    owner = owner if owner is not None else sender
    direct_vm.mock_web(
        r".*github\.com/myorg/research-agent.*",
        {"status": 200, "body": "README: research agent. Can search the web and summarise papers."},
    )
    direct_vm.mock_llm(
        r".*evaluating an AI agent's capability registration.*",
        json.dumps({
            "verified": True,
            "verified_capabilities": ["search the web", "summarise papers"],
            "confidence": "high",
            "reasoning": "README documents both capabilities with examples.",
        }),
    )
    direct_vm.sender = sender
    contract.register_agent(
        agent_id,
        "I can search the web and summarise academic papers",
        "https://github.com/myorg/research-agent/blob/main/README.md",
        addr_hex(owner),
    )
    return agent_id


def test_register_agent_verified(direct_vm, direct_deploy, direct_alice, direct_owner):
    contract = direct_deploy(CONTRACT, addr_hex(direct_owner), sdk_version=SDK_VERSION)
    agent_id = _register_verified_agent(direct_vm, contract, direct_alice)

    agent = contract.get_agent(agent_id)
    assert agent["verification_status"] == "verified"
    assert agent["reputation_score"] == 50
    assert "search the web" in agent["verified_capabilities"]
    assert agent["owner"].lower() == addr_hex(direct_alice).lower()


def test_register_agent_duplicate_id_reverts(direct_vm, direct_deploy, direct_alice, direct_bob, direct_owner):
    contract = direct_deploy(CONTRACT, addr_hex(direct_owner), sdk_version=SDK_VERSION)
    agent_id = _register_verified_agent(direct_vm, contract, direct_alice)

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("agent_id already registered"):
        contract.register_agent(agent_id, "different claim", "https://example.com", addr_hex(direct_bob))


def test_register_agent_owner_must_match_sender(direct_vm, direct_deploy, direct_alice, direct_bob, direct_owner):
    """Security fix: a caller cannot register an agent claiming an owner_address
    they don't control -- prevents impersonation/squatting against a victim
    address that never signed anything."""
    contract = direct_deploy(CONTRACT, addr_hex(direct_owner), sdk_version=SDK_VERSION)

    direct_vm.mock_web(
        r".*github\.com/myorg/research-agent.*",
        {"status": 200, "body": "README: research agent."},
    )
    direct_vm.mock_llm(
        r".*evaluating an AI agent's capability registration.*",
        json.dumps({"verified": True, "verified_capabilities": ["x"], "confidence": "high", "reasoning": "ok"}),
    )

    direct_vm.sender = direct_bob  # Bob is signing...
    with direct_vm.expect_revert("owner_address must match the calling account"):
        contract.register_agent(
            "impersonation-attempt",
            "I can do things",
            "https://github.com/myorg/research-agent/blob/main/README.md",
            addr_hex(direct_alice),  # ...but claims Alice as owner. Must revert.
        )

    # Confirm the revert actually rolled back -- no half-registered agent.
    listing = contract.list_agents(0, 10)
    assert listing["total"] == 0


def test_create_deal_requires_exact_escrow(direct_vm, direct_deploy, direct_alice, direct_bob, direct_owner):
    contract = direct_deploy(CONTRACT, addr_hex(direct_owner), sdk_version=SDK_VERSION)
    agent_id = _register_verified_agent(direct_vm, contract, direct_alice)

    direct_vm.sender = direct_bob
    direct_vm.value = 5 * 10**18
    with direct_vm.expect_revert("escrow must equal payment_amount exactly"):
        contract.create_deal("deal-1", agent_id, "Summarise 10 papers", "10 papers summarised in JSON", 10 * 10**18)


def test_create_deal_success_and_directory_listing(direct_vm, direct_deploy, direct_alice, direct_bob, direct_owner):
    contract = direct_deploy(CONTRACT, addr_hex(direct_owner), sdk_version=SDK_VERSION)
    agent_id = _register_verified_agent(direct_vm, contract, direct_alice)

    direct_vm.sender = direct_bob
    direct_vm.value = 10 * 10**18
    contract.create_deal("deal-1", agent_id, "Summarise 10 papers", "10 papers summarised in JSON", 10 * 10**18)

    deal = contract.get_deal("deal-1")
    assert deal["status"] == "active"
    assert deal["payment_amount"] == 10 * 10**18
    assert deal["client"].lower() == addr_hex(direct_bob).lower()

    listing = contract.list_agents(0, 10)
    assert listing["total"] == 1
    assert listing["agents"][0]["agent_id"] == agent_id

    deals = contract.list_deals(0, 10)
    assert deals["total"] == 1
    assert deals["deals"][0]["deal_id"] == "deal-1"


def test_submit_deliverable_only_agent_owner(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, direct_owner):
    contract = direct_deploy(CONTRACT, addr_hex(direct_owner), sdk_version=SDK_VERSION)
    agent_id = _register_verified_agent(direct_vm, contract, direct_alice)

    direct_vm.sender = direct_bob
    direct_vm.value = 10 * 10**18
    contract.create_deal("deal-1", agent_id, "Summarise 10 papers", "10 papers summarised in JSON", 10 * 10**18)

    direct_vm.sender = direct_charlie  # not the agent's owner
    with direct_vm.expect_revert("only the agent's registered owner can submit a deliverable"):
        contract.submit_deliverable("deal-1", "https://ipfs.io/ipfs/Qm123", "done")


def test_submit_deliverable_completed_pays_agent_and_updates_reputation(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_owner
):
    contract = direct_deploy(CONTRACT, addr_hex(direct_owner), sdk_version=SDK_VERSION)
    agent_id = _register_verified_agent(direct_vm, contract, direct_alice)

    direct_vm.sender = direct_bob
    direct_vm.value = 10 * 10**18
    contract.create_deal("deal-1", agent_id, "Summarise 10 papers", "10 papers summarised in JSON", 10 * 10**18)

    direct_vm.mock_web(
        r".*ipfs\.io/ipfs/Qm123.*",
        {"status": 200, "body": "Report: 10/10 papers summarised, JSON attached, all fields present."},
    )
    direct_vm.mock_llm(
        r".*deliverable reviewer settling an escrowed deal.*",
        json.dumps({"accepted": True, "quality_score": 90, "notes": "Meets criteria.", "confidence": "high"}),
    )

    direct_vm.sender = direct_alice  # the agent's registered owner
    contract.submit_deliverable("deal-1", "https://ipfs.io/ipfs/Qm123", "10/10 papers summarised")

    deal = contract.get_deal("deal-1")
    assert deal["status"] == "completed"

    agent = contract.get_agent(agent_id)
    assert agent["total_deals"] == 1
    assert agent["successful_deals"] == 1
    # weighted decay: (50 * 75 + 90 * 25) // 100 = 60
    assert agent["reputation_score"] == 60

    result = contract.get_deal_result(agent_id, "deal-1")
    assert result["final_status"] == "completed"


def test_submit_deliverable_rejected_refunds_client(direct_vm, direct_deploy, direct_alice, direct_bob, direct_owner):
    contract = direct_deploy(CONTRACT, addr_hex(direct_owner), sdk_version=SDK_VERSION)
    agent_id = _register_verified_agent(direct_vm, contract, direct_alice)

    direct_vm.sender = direct_bob
    direct_vm.value = 10 * 10**18
    contract.create_deal("deal-1", agent_id, "Summarise 10 papers", "10 papers summarised in JSON", 10 * 10**18)

    direct_vm.mock_web(r".*ipfs\.io/ipfs/QmBad.*", {"status": 200, "body": "Empty placeholder file."})
    direct_vm.mock_llm(
        r".*deliverable reviewer settling an escrowed deal.*",
        json.dumps({"accepted": False, "quality_score": 5, "notes": "No real content.", "confidence": "high"}),
    )

    direct_vm.sender = direct_alice
    contract.submit_deliverable("deal-1", "https://ipfs.io/ipfs/QmBad", "done")

    deal = contract.get_deal("deal-1")
    assert deal["status"] == "rejected"

    agent = contract.get_agent(agent_id)
    # weighted decay: (50 * 75 + 5 * 25) // 100 = 38
    assert agent["reputation_score"] == 38
    assert agent["successful_deals"] == 0


def test_submit_deliverable_ambiguous_goes_to_pending_review(direct_vm, direct_deploy, direct_alice, direct_bob, direct_owner):
    contract = direct_deploy(CONTRACT, addr_hex(direct_owner), sdk_version=SDK_VERSION)
    agent_id = _register_verified_agent(direct_vm, contract, direct_alice)

    direct_vm.sender = direct_bob
    direct_vm.value = 10 * 10**18
    contract.create_deal("deal-1", agent_id, "Summarise 10 papers", "10 papers summarised in JSON", 10 * 10**18)

    direct_vm.mock_web(r".*ipfs\.io/ipfs/QmMid.*", {"status": 200, "body": "7 of 10 papers summarised."})
    direct_vm.mock_llm(
        r".*deliverable reviewer settling an escrowed deal.*",
        json.dumps({"accepted": True, "quality_score": 50, "notes": "Partial coverage.", "confidence": "medium"}),
    )

    direct_vm.sender = direct_alice
    contract.submit_deliverable("deal-1", "https://ipfs.io/ipfs/QmMid", "mostly done")

    deal = contract.get_deal("deal-1")
    assert deal["status"] == "pending_review"
    assert deal["pending_review"] == "open"

    # No reputation change yet -- settlement is withheld until the arbiter acts.
    agent = contract.get_agent(agent_id)
    assert agent["total_deals"] == 0


def test_submit_deliverable_reject_needs_high_confidence(direct_vm, direct_deploy, direct_alice, direct_bob, direct_owner):
    """Bug fix regression test: REJECT_CONFIDENCE_FLOOR is 'high'. A
    not-accepted verdict at only 'medium' confidence must NOT auto-reject --
    it should fall through to pending_review, exercising the now-wired
    _meets_confidence_floor() helper rather than the old dead constant."""
    contract = direct_deploy(CONTRACT, addr_hex(direct_owner), sdk_version=SDK_VERSION)
    agent_id = _register_verified_agent(direct_vm, contract, direct_alice)

    direct_vm.sender = direct_bob
    direct_vm.value = 10 * 10**18
    contract.create_deal("deal-1", agent_id, "Summarise 10 papers", "10 papers summarised in JSON", 10 * 10**18)

    direct_vm.mock_web(r".*ipfs\.io/ipfs/QmLowConf.*", {"status": 200, "body": "Unclear submission."})
    direct_vm.mock_llm(
        r".*deliverable reviewer settling an escrowed deal.*",
        json.dumps({"accepted": False, "quality_score": 10, "notes": "Looks bad but unsure.", "confidence": "medium"}),
    )

    direct_vm.sender = direct_alice
    contract.submit_deliverable("deal-1", "https://ipfs.io/ipfs/QmLowConf", "submitted")

    deal = contract.get_deal("deal-1")
    assert deal["status"] == "pending_review", "medium-confidence reject must not auto-settle"


def test_resolve_dispute_only_arbiter(direct_vm, direct_deploy, direct_alice, direct_bob, direct_owner):
    contract = direct_deploy(CONTRACT, addr_hex(direct_owner), sdk_version=SDK_VERSION)
    agent_id = _register_verified_agent(direct_vm, contract, direct_alice)

    direct_vm.sender = direct_bob
    direct_vm.value = 10 * 10**18
    contract.create_deal("deal-1", agent_id, "Summarise 10 papers", "10 papers summarised in JSON", 10 * 10**18)

    direct_vm.mock_web(r".*ipfs\.io/ipfs/QmMid.*", {"status": 200, "body": "7 of 10 papers summarised."})
    direct_vm.mock_llm(
        r".*deliverable reviewer settling an escrowed deal.*",
        json.dumps({"accepted": True, "quality_score": 50, "notes": "Partial.", "confidence": "medium"}),
    )
    direct_vm.sender = direct_alice
    contract.submit_deliverable("deal-1", "https://ipfs.io/ipfs/QmMid", "mostly done")

    direct_vm.sender = direct_bob  # client, not the arbiter
    with direct_vm.expect_revert("only the arbiter can resolve a dispute"):
        contract.resolve_dispute("deal-1", True)

    direct_vm.sender = direct_owner  # constructor arbiter
    contract.resolve_dispute("deal-1", True)
    assert contract.get_deal("deal-1")["status"] == "completed"


def test_cancel_deal_refunds_before_submission(direct_vm, direct_deploy, direct_alice, direct_bob, direct_owner):
    """Bug fix: without cancel_deal, GEN escrowed for an agent that never
    responds was stuck in the contract forever. Confirms the client can
    reclaim it while the deal is still active."""
    contract = direct_deploy(CONTRACT, addr_hex(direct_owner), sdk_version=SDK_VERSION)
    agent_id = _register_verified_agent(direct_vm, contract, direct_alice)

    direct_vm.sender = direct_bob
    direct_vm.value = 10 * 10**18
    contract.create_deal("deal-1", agent_id, "Summarise 10 papers", "10 papers summarised in JSON", 10 * 10**18)

    contract.cancel_deal("deal-1")

    deal = contract.get_deal("deal-1")
    assert deal["status"] == "cancelled"


def test_cancel_deal_only_client(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, direct_owner):
    contract = direct_deploy(CONTRACT, addr_hex(direct_owner), sdk_version=SDK_VERSION)
    agent_id = _register_verified_agent(direct_vm, contract, direct_alice)

    direct_vm.sender = direct_bob
    direct_vm.value = 10 * 10**18
    contract.create_deal("deal-1", agent_id, "Summarise 10 papers", "10 papers summarised in JSON", 10 * 10**18)

    direct_vm.sender = direct_charlie  # not the client who created the deal
    with direct_vm.expect_revert("only the client who created this deal can cancel it"):
        contract.cancel_deal("deal-1")


def test_cancel_deal_blocked_after_submission(direct_vm, direct_deploy, direct_alice, direct_bob, direct_owner):
    """Once the agent has submitted (even to pending_review), the client can
    no longer unilaterally cancel out from under an in-flight deliverable."""
    contract = direct_deploy(CONTRACT, addr_hex(direct_owner), sdk_version=SDK_VERSION)
    agent_id = _register_verified_agent(direct_vm, contract, direct_alice)

    direct_vm.sender = direct_bob
    direct_vm.value = 10 * 10**18
    contract.create_deal("deal-1", agent_id, "Summarise 10 papers", "10 papers summarised in JSON", 10 * 10**18)

    direct_vm.mock_web(r".*ipfs\.io/ipfs/QmDone.*", {"status": 200, "body": "10/10 papers summarised."})
    direct_vm.mock_llm(
        r".*deliverable reviewer settling an escrowed deal.*",
        json.dumps({"accepted": True, "quality_score": 90, "notes": "Good.", "confidence": "high"}),
    )
    direct_vm.sender = direct_alice
    contract.submit_deliverable("deal-1", "https://ipfs.io/ipfs/QmDone", "done")
    assert contract.get_deal("deal-1")["status"] == "completed"

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("deal is not active"):
        contract.cancel_deal("deal-1")
