# Restricted managed decision bot — implementation contract

## Status and authorization

Round 2, base master 16b206a, branch luw2007/managed-decision-bot. User authorizes persistent logical identity, bounded per-decision runs, at most three design review rounds, implementation after no blockers. Default disabled; no production grants, master merge or publish authorized.

Round 1: pi/<model> feasibility task_b67084574a13 and pi/Google Claude Opus 4.6 Thinking adversarial task_9b84c9d5a82b. Fable failed provider version requirement; user explicitly approved replacing it with an available Claude. Claude artifact .dispatch/reports/REVIEW-R1-ADVERSARIAL.md exists, although provider cooldown interrupted final lifecycle reporting. Owner verified pi --help: no-tools/no-extensions/no-context-files DO exist; prior feasibility claim was false. Use documented CLI, not SDK. Owner rejects suggestion to put all bot proposals in orchestrator.db: extension-only deployments must not require optional orchestrator.

APPROVED FOR IMPLEMENTATION after round 2: feasibility task_c39c811e8c00 / ctx_b803736bfff9 (pi/<model>) APPROVE; independent Claude task_f6684d129dca / ctx_8e4a60f37393 (pi/<model>) APPROVE, report .dispatch/reports/R2-CLAUDE.md. Owner accepts the concrete contract, not every review statement about old code. In particular full action metadata is NEW work: existing approvalDetail truncates command/path and must not be treated as already sufficient. Two review rounds used; no third necessary. Provider failures and incompatible tool-calling attempts were not approvals. Implementation must preserve unknown outcome semantics and verify real runtime behavior.

## Product

One persisted bot identity; new ephemeral process per pending item, no persistent chat. Bot proposes an existing answer or escalates; deterministic explicit scoped policy authorizes, consumers revalidate. Supported targets: extension gated action approvals and orchestrator ready/ci_anomaly approvals. Plain ask stays deep-link-only. Orchestrator ready approve can push/create PR: policy names this effect explicitly. No auto-enrollment or broad default grants. Same-UID workflow boundary, not sandbox/security boundary.

Do not build generic planner/DAG, cloud infrastructure, arbitrary evidence tools, model router or policy self-editing. Existing human path must work with bot off, unavailable or misconfigured. Keep original Now/Inbox card and choices, show bot reasoning/status; no duplicate escalation request. No bot recursively reviewing its own internal failures.

## Storage and authority: concrete contract

Reuse orchestrator-answers.db as shared decision mailbox; migrate in openAnswersDb with busy_timeout=5000 and idempotent schema introspection. Place bot_identity, bot_attempts, bot_proposals, decision_receipts and live approval_targets here. These are metadata in the EXISTING mailbox, not a new answer transport. Existing answers remains human answer table; bot proposals never occupy it. No dependency on orchestrator daemon for extension use.

approval_targets: composite consumer_owner + approval_id, exact stable_id/request_uid when available, canonical immutable question/options/effect/scope, target_version hash, expires_at, active/consumed/closed, outcome metadata. Each producer registers its own exact actionable data before emitting request/awaiting. Extension includes FULL command/path/cwd/gate rule/class/toolCallId plus immutable invocation identity; never authorize on truncated UI detail. Orchestrator registers task/approval/gate/repo/base/branch and evidence snapshot digest. Existing source systems remain responsible for execution state. Target registration allows bot discovery without waiting on lossy reducer projection. Ledger remains telemetry, not final action authority.

Human answers migration adds explicit nullable consumer_owner and actor provenance. Unknown legacy rows remain untouched. Source consumers may bind legacy owner only when exact locally pending known approval matches and before claim; ambiguous ownership remains untouched. New human POST validates supported target and options; compatibility for active legacy source requests must resolve from exact existing request/approval facts, never blindly infer from ID spelling. Preserve existing foreign-row behavior and seven-day sweep. CLI/web never allow a bot actor supplied by user JSON.

Bot attempt/proposal immutable payload: botId, attemptId, owner lease token, target owner/id/version, policy hash, canonical evidence snapshot/hash, structured answer/escalation, bounded reason/evidence refs. Finite one inference attempt per target version by default, timeout 60s, output cap 256KiB; retry only manually or new target version. Single tick in flight. DB claim CAS prevents duplicate daemon runs. Lease expires beyond process deadline. Reclaim after crash marks attempt unknown/escalated, NEVER repeats inference automatically for same version. Stable bot UUID survives process restart.

## Final consume linearization

One shared owner-scoped consume function inside mailbox BEGIN IMMEDIATE transaction chooses valid human answer first, otherwise valid bot proposal. It verifies locally supplied original target version, owner, pending state, expiry and current policy hash/grant. Consumers supply live source state and evidence verification; no model metadata is trusted. It atomically records a receipt, marks target consumed and invalidates proposal. Return only the newly consumed receipt to extension. Human POST and consume serialize in this database: a human answer committed BEFORE consume wins. A human arriving AFTER consume receives an honest already-consumed conflict. Never promise retroactive human precedence.

Policy is read synchronously immediately before the transaction and verified in the consume boundary. Config changes linearize at the policy read; updates after consumption cannot cancel prior effects. CLI disable/takeover must persist revocation/cancellation in this same mailbox transaction so explicit operator operations serialize. Direct config file edits affect subsequent policy reads; document this boundary, do not claim filesystem/DB global atomicity.

Extension replaces GET-then-DELETE with POST atomic consume including original owner/id/version from its own closure. Owner-scoped validation before any removal; non-GET Origin/Host guard. A consumed extension receipt is not returned again: response-loss/process-crash means unknown, no automatic tool execution retry. Extension emits decision_resolved with actor/receipt and later execution outcome if observable; no fake completion. Existing human timeout/deny behavior stays fail-closed.

Orchestrator consumes mailbox receipt then applies state transition + approvals.consumed_at + unique receipt identity in ONE orchestrator.db transaction. Crash before application: orchestrator can read its own un-applied receipt and apply idempotently while approval still pending. Crash after application: consumed_at/receipt guard prevents duplicate transition; mark mailbox outcome afterward, recovery reconciles this marker. Do not claim atomic commit across DBs. Once mailbox consumed, authority is granted and no later policy revocation retracts that committed decision. External push/PR retains existing idempotency/reconciliation semantics; unknown effect remains unknown, not automatically replayed by bot.

Consumers reconcile expiry/closure to mailbox targets. Before consuming always check local producer pending state; bot discovery staleness cannot authorize. Extension process loss yields timeout/unknown, not synthetic approval. Orchestrator stale task state invalidates its target.

## Policy and evidence

Strict optional decision_bot config: enabled, model, timeout_ms, max_output_bytes and rules. Validate entire enabled policy fail-closed without blocking HUMAN consumers. Stable hash of normalized policy; no model confidence used as authority. Each rule names id, consumer_owner, exact gate/rule, exact repo/cwd scope, permitted answers and explicit effect class. For extension require exact full command or exact write/edit path (no implicit glob/substring); unknown class needs explicit exact action scope, not wildcard. For orchestrator require repo/gate and allow-listed effect push_pr or ci decision. Duplicate/ambiguous rule grants fail closed. No default rule.

Canonical snapshot includes registered original target and bounded existing evidence. Orchestrator evidence is immutable copied summary/content from collectEvidence result plus checks/diff hashes tied to base/head/status. Recheck repo head/base/status and check artifact digest before auto-consume; any mutation escalates/stales. Do not claim digest proves correctness. Extension command/path authorization covers exact invocation, not arbitrary filesystem semantic truth; no automatic file ingestion from event-provided paths. Model sees supplied packet only. References must point to snapshot entries; missing/unknown evidence is explicit and causes escalation if policy needs it. Runtime timeout covers model process and bounded evidence acquisition.

## Runner

Bun.spawn pi argv directly: --no-tools --no-extensions --no-context-files --no-skills --no-prompt-templates --no-session --print --mode json --model <configured> with explicit system prompt and bounded data prompt. No shell interpolation. No @untrusted file expansion; pass prompt as literal message after -- where supported (verify real invocation). Launch in private temp cwd to avoid project settings; no exported orchestration capability or terminal authority in child environment. Preserve only required ordinary model auth/environment, do not log secrets. Kill owned process group on timeout/output overflow, remove temp artifacts on all exits.

Parse actual pi JSONL terminal assistant result, reject tool-call output/nonzero exit/multiple conflicting final answers. Proposal strict schema: action answer|escalate, answer only from target options, reason bounded, evidenceRefs subset of snapshot. Unsupported CLI flags/model fail into original human item, never fallback to unrestricted pi. Real pi zero-tool smoke required.

## Surface and operations

CLI under overload decision-bot: status, run (--once for deterministic operational use), disable, takeover <owner> <approval-id>. Default config disabled. Optional daemon not part of four default jobs; document manual run first, no mandatory installer changes. Reuse current config and web auth patterns. Q1/API joins read-only bot metadata by exact approval target, renders identity, processing/escalation/consumed/result-unknown, short escaped rationale and human takeover while pending. Keep existing approve/deny options; submit human answer atomically supersedes unconsumed proposal. No bot actor forgery. Existing generic asks unchanged.

Bot unavailable: CLI status reports error, human API works. Result progression distinguishes proposal, consumed, resumed, completed, failed, unknown only where source evidence proves each. Do not infer successful tool operation solely from tool permission. Already existing archive behavior remains; unresolved/unknown decision stays actionable where producer supports it.

## Work allocation after approval

Boundary implementer owns shared mailbox schema/functions, both producer registrations and consumers, web human routes, orchestrator receipt recovery. Service implementer owns src/decision-bot policy/store/runner/service against frozen boundary. To avoid shared-file collision boundary implementation occurs first, then service integration; independent surface work can run concurrently once exact exports are frozen. Surface implementer owns CLI/config docs and web rendering, coordinates server/query edits with boundary owner. Each worker self-reviews; no concurrent build/test/lint/format suites. Owner integrates, independent verification executes afterward. No permanent mocks/source-string tests.

## Acceptance matrix

1. Defaults never run or answer; identity stable, attempts separate. Scoped explicit policy + real valid pi proposal reaches existing consumer exactly once.
2. Both extension gate and orchestrator gates operate; unsupported plain ask, unknown owner, disallowed answer/effect, ambiguous config never auto-answer.
3. Concurrent daemons one attempt; human-before-consume wins in either proposal order, human-after-consume conflicts honestly. Explicit takeover/disable serialized with consume.
4. Expiry, local pending state change, changed command/evidence/policy, lease loss reject late bot output. Mutation after proposal before consume is covered.
5. Crash at attempt claim/runner finish/mailbox consume/orchestrator apply/outcome write: no duplicate answer effects; extension lost response unknown and fail-closed; orchestrator receipt replay idempotent.
6. Malformed/oversized/tool output/nonzero/timeout/prompt injection cannot execute tools or bypass deterministic scope; process tree cleaned. No secrets in reports.
7. Old populated schema reopens idempotently; foreign rows survive with no unrelated task_events; human UI/CLI works during bot outage; both consumers use explicit owners.
8. Actual CLI/real pi smoke, actual card surface if browser available, and entire existing suite once after integration. Keep race/failure regression tests that fail plausible defects; no mock echo assertions. Report known baseline test timeout separately.
9. Operator docs include grants/effects, disable/takeover, single-UID trust boundary, crash semantics, supported pi requirements, status meaning and explicit opt-in examples. No production enabling, commits/merge/push implied by this plan.

## Round 2 questions to close

Review exact consume/receipt contract for remaining contradictions, especially producer registration versus existing legacy pending approvals, literal prompt argv, orchestrator evidence registration, and extension response-loss handling. Flag only concrete blockers with minimal fixes. At most one more review round if blockers remain. No implementation before owner records no blocking findings.
