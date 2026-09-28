# Overload Phase A implementation contract

Date: 2026-09-26  
Status: Phase A implementation contract aligned to the delivered implementation; production release gate remains open

This document is the copy-pasteable boundary between Phase A implementation slices. Terms marked **EXISTING** name current code. Terms marked **NEW** are the only new contracts authorized here.

Code evidence cites a file and the symbol named in the same sentence, not line numbers: line citations went stale while the tree was still changing.

## 1. Scope and non-goals

Phase A implements and verifies acceptance scenarios **A01–A17** from `overload-20260926-attention-product.md:384-402`:

1. material-change classification and notification deduplication;
2. a complete `DecisionViewPackage`-backed card/drawer, with server-known option semantics;
3. a follow-up read model that keeps recorded, applying, failed, and unknown responsibility visible;
4. one notification owner for Attention, legacy Q1, and hung subjects, with macOS or Feishu delivery and durable outcomes;
5. stale-write, actor, expiry, mailbox-consumption, effect-observation, outbox, and audit linkage needed by A01–A17;
6. shadow comparison, a single-owner cutover, and legacy notification retirement.

Explicit non-goals:

- no Product B conditional waiting, typed wait predicates, baselines, polling, or wake/resume implementation;
- no new scheduler, Todo/Goal/Quota engine, retry engine, or generalized workflow graph;
- no new runtime adapter and no expansion of existing runtime restore/answer capability;
- no second context store, mailbox, Work model, revision, `effect_state`, event bus, or Feishu integration;
- no client-supplied actor, model-generated executable action, or inferred ownership from similar titles;
- no change to existing Attention state enums or the meaning of ack/defer/resolve.

## 2. Current facts that implementations must preserve

The following are **EXISTING** and are grounded in `local://phaseA-facts.md`:

- `Contract`, `Work`, and `AttentionItem` are defined at `src/control/types.ts`; Attention state is `open | applying | resolved | superseded` and effect state is `not_started | applying | succeeded | failed | unknown` (`src/control/types.ts`). Do not duplicate these facts.
- `listAttention` excludes `applying` from Now/Inbox/Done; `listAttentionFollowUps` is the separate applying/failure responsibility read model (`src/control/store.ts`). Done semantics remain unchanged.
- resolve uses revision/material CAS and external-effect guards; Ack and defer neither answer nor authorize (`src/control/store.ts`).
- schema ownership is `control_schema_meta` plus explicit `CONTROL_MIGRATIONS`; v6 schema creation and open-Attention baseline backfill run in one immediate migration transaction, and opening an already-v6 database idempotently repairs missing open rows (`src/control/store.ts`).
- `DecisionViewPackage` and `assembleDecisionView` exist at `src/control/context-assembler.ts`. Options are derived by the shared store helper; generic option metadata and approval-target effects are authoritative, and unavailable semantics fail assembly with `needs_context` (`src/control/store.ts`; `src/control/context-assembler.ts`).
- context routes receive only the server-injected actor. The Attention mutation route requires a trusted server actor for `resolve` before parsing the decision body; Ack/defer remain seen/presentation actions and do not consume a decision (`src/web/context-routes.ts`; `src/web/server.ts`).
- stale Attention or material submissions map to HTTP 409 with `code:"stale_attention"`, current revision/state/effect state, and a decision-package refresh URL (`src/web/server.ts`).
- the Web decision path fetches and renders the decision package; raw evidence remains outside the normal card/drawer path (`src/web/static/app.js`).
- mailbox targets, answers, receipts, and effect observations remain authoritative (`src/decision-bot/mailbox.ts`). `consumeDecision` owns single consumption and `effect_observed` reconciliation (`src/decision-bot/mailbox.ts`; `src/extension/overload.ts`).
- adapter dispatch moves a card to applying and reopens dispatch rejection as `open/unknown` (`src/adapters/service.ts`).
- control outbox identity/hash and ledger projection already exist (`src/control/outbox.ts`). State mutation, material projection, and outbox insertion remain one source transaction.
- Feishu is an existing writeback path, not proof of a configured real-channel production smoke: its card action emits `itemId`, `revision`, and `answer` (`src/adapters/feishu.ts`), and `AdapterService.accept` applies ownership/version/expiry rules before mailbox or generic resolve (`src/adapters/service.ts`).
- notification shadow defaults preserve the legacy Q1/hung newline sender as the only sender while recording candidate comparisons; Attention is candidate-only until cutover (`src/notify/nudge.ts`).
- `package.json:7-12` provides only `bun test`; there is no repository typecheck script.

## 3. Frozen persistence contract

### 3.1 Migration and baseline strategy

As of Phase A, `CONTROL_SCHEMA_VERSION` was 6; the current tree is at 7, where the Phase B v7 migration only adds the wait and prerequisite-edge tables (see `docs/plans/overload-20260926-phaseB-contract.md` §3.2) and leaves the v6 Phase A tables below unchanged. The non-destructive v6 migration creates the following tables and indexes with `CREATE TABLE/INDEX IF NOT EXISTS`, projects generation-1 material for every existing open Attention row, and updates `control_schema_meta` to 6 in the same immediate transaction. Opening an already-v6 database performs the same missing-row scan in an idempotent immediate repair transaction. Historical open rows therefore receive a baseline but do not directly send: under the default shadow configuration the incumbent legacy Q1/hung sender remains the only sender, while the candidate path only records comparisons/outcomes. Upsert likewise derives and projects the current material baseline atomically with the Attention row, event, and outbox (`src/control/store.ts`).
```sql
CREATE TABLE IF NOT EXISTS control_attention_material (
  item_id TEXT PRIMARY KEY,
  material_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  inputs TEXT NOT NULL,
  computed_at INTEGER NOT NULL,
  FOREIGN KEY(item_id) REFERENCES control_attention(item_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS control_attention_material_key
  ON control_attention_material(material_key);

CREATE TABLE IF NOT EXISTS control_notifications (
  notification_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  material_key TEXT NOT NULL,
  threshold TEXT NOT NULL CHECK(threshold IN ('new_now','material_change','expires_soon','expired')),
  channel TEXT NOT NULL CHECK(channel IN ('macos','feishu')),
  outcome TEXT NOT NULL CHECK(outcome IN ('shadowed','pending','sent','failed','unknown','suppressed')),
  owner_epoch TEXT NOT NULL,
  work_id TEXT,
  item_id TEXT,
  item_revision INTEGER,
  approval_id TEXT,
  receipt_id TEXT,
  outbox_event_id TEXT,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('attention','legacy_q1','legacy_hung')),
  source_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  next_attempt_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  attempted_at INTEGER,
  completed_at INTEGER,
  UNIQUE(subject, material_key, threshold, owner_epoch)
);
CREATE INDEX IF NOT EXISTS control_notifications_due
  ON control_notifications(outcome, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS control_notifications_item
  ON control_notifications(item_id, item_revision, created_at);

CREATE TABLE IF NOT EXISTS control_notification_shadow (
  comparison_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  material_key TEXT NOT NULL,
  threshold TEXT NOT NULL,
  legacy_would_send INTEGER NOT NULL CHECK(legacy_would_send IN (0,1)),
  candidate_would_send INTEGER NOT NULL CHECK(candidate_would_send IN (0,1)),
  legacy_reason TEXT NOT NULL,
  candidate_reason TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('attention','legacy_q1','legacy_hung')),
  source_id TEXT NOT NULL,
  item_id TEXT,
  item_revision INTEGER,
  compared_at INTEGER NOT NULL,
  UNIQUE(subject, material_key, threshold)
);
```

`subject` is the stable responsibility identity: `attention:<item_id>`, `q1:<request_uid>`, or `hung:<stable_id>`. It deliberately excludes Attention revision. `material_key` is `<subject>:<fingerprint>` for Attention; unlinked legacy subjects use `<subject>:legacy-open`. Native Attention and legacy Q1/hung are treated as the same responsibility only when an explicit producer-recorded approval/request binding resolves unambiguously; titles, summaries, parsed IDs, and resemblance are never correlations. Unlinked legacy rows remain separate coverage gaps rather than being guessed away (`src/notify/nudge.ts`). `owner_epoch` changes only during explicit cutover. The uniqueness constraint prevents both channels or retries from claiming the same interruption in one epoch. `channel` records the chosen primary delivery; non-primary channels may still update cards/status but must not insert a sending claim.

`approval_id`, `receipt_id`, and `outbox_event_id` are nullable audit correlations, not replacement authorities. Cross-database foreign keys are intentionally absent. Writers record authoritative identities when known; missing or ambiguous legacy linkage remains null and separately represented.

### 3.2 Material fingerprint

The sole canonicalization input is this **NEW** type:

```ts
export type MaterialFingerprintInputs = {
  risk: string;
  decision: string;
  option_effects: Array<{ option: string; effect: string }>;
  decisive_evidence: Array<{ object_id: string; revision: number; conclusion: string }>;
  validity: { expires_at: number | null; expired: boolean };
  consequence: string;
};
```

Canonicalization is deterministic and local:

1. trim every string, normalize CRLF/CR to LF, collapse internal Unicode whitespace to one ASCII space, and normalize Unicode to NFC;
2. preserve `option_effects` in executable `AttentionItem.options` order; sort `decisive_evidence` by `object_id`, then numeric `revision`, then normalized `conclusion`;
3. serialize objects with lexicographically sorted keys, arrays in the order above, JSON primitives unchanged, and no insignificant whitespace—the same recursive canonical JSON behavior already used by `src/control/outbox.ts` and `src/decision-bot/mailbox.ts` should be extracted/reused rather than forked;
4. `fingerprint = sha256(canonical(inputs))`; `material_key = subject + ":" + fingerprint`.

Timestamps, card revision, updated time, prose summary, heartbeat, ordinary logs, and source-declared `material_change` are not inputs. `risk`, `decision`, and `consequence` are deterministic projections from current card/contract facts. `option_effects` comes only from server-known option semantics. `decisive_evidence` is the card's own pinned evidence object (`AttentionItem.evidence.{object_id,revision}` and its conclusion), not raw logs. `DecisionViewPackage.trigger_evidence` (pool facts linked to the Work) is display context only and is deliberately NOT a material input: linking a new fact does not change the fingerprint; a decision-relevant fact must be pinned by a card revision. Expiry contributes only exact `expires_at` and derived `expired`; threshold dedup remains separately keyed by `threshold`.

Every upsert derives material through `deriveAttentionMaterialInputs` and projects it in the same immediate transaction as the Attention row, Attention event, and outbox; the assembler calls that same derivation/projection path before returning a package (`src/control/store.ts`; `src/control/context-assembler.ts`). A missing historical open projection is inserted as generation 1 by migration/reopen repair. Equal fingerprints retain generation and refresh `computed_at`; a different fingerprint increments generation. A source assertion can request recomputation but cannot choose the fingerprint, urgency, authorization, or notification.

## 4. Frozen TypeScript seams

### 4.1 Store and read models

Keep all **EXISTING** exported signatures source-compatible. Add:

```ts
// NEW in src/control/types.ts
export type AttentionZone = "now" | "inbox" | "done";
export type FollowUpStage =
  | "answer_recorded"
  | "applying"
  | "verification_required"
  | "failed"
  | "unknown";

export type AttentionFollowUp = {
  item: AttentionItem;
  stage: FollowUpStage;
  receipt_id: string | null;
  consumed_at: number | null;
  applied_at: number | null;
  outcome: "succeeded" | "failed" | "unknown" | null;
  occurred_effects: Array<{ kind: string; evidence: Record<string, unknown> }>;
  remaining_responsibility: string;
  next_action: string;
};

// NEW in src/control/store.ts
export function listAttention(db: Database, zone: AttentionZone, now?: number): AttentionItem[];
export function listAttentionFollowUps(db: Database, now?: number): AttentionFollowUp[];
export function resolveAttention(
  db: Database,
  itemId: string,
  input: AttentionDecisionInput,
  actor: string,
  now?: number,
): AttentionItem;
```

`listAttention` retains the existing zone behavior. `resolveAttention` is the single public wrapper for generic decisions; it requires a non-empty trusted actor, while approval-linked items continue through mailbox write/consume and are rejected by this wrapper. Ack is seen-only (`acknowledged_at`) and defer only changes presentation timing; neither answers, authorizes, or resolves. `listAttentionFollowUps` derives fields from existing Attention plus mailbox receipt/effect observations and does not persist a second status. It includes answer-recorded-but-unconsumed, applying, verification-required, failed, and unknown responsibility, and excludes verified success with no remaining responsibility. Web exposes this exact model at `GET /api/control/attention?zone=follow_up` as `{items: AttentionFollowUp[]}` (`src/control/store.ts`; `src/web/server.ts`).

Unknown or failed effects must reopen the same item responsibility (`state='open'`, effect state retained as `unknown` or `failed`, revision incremented) or remain in follow-up if dispatch is still being reconciled. They must never silently enter Done or spawn a replacement Work solely to bypass a receipt.

### 4.2 Decision view and option semantics

Replace bare package options with server-known display metadata while retaining the executable option ID:

```ts
// NEW shape in src/control/context-assembler.ts
export type DecisionOption = {
  id: string;                 // exact value accepted by store/mailbox
  label: string;              // deterministic server-owned display label
  effect: string;             // concrete effect or “records answer; execution pending”
  consequence: string;        // user-visible consequence of choosing it
  requires_reason: boolean;
  requires_contract: boolean;
};

export interface DecisionViewPackage {
  package_type: "decision_view";
  consumer_id: string;
  work_id: string;
  problem_id?: string;
  attention_revision: number; // NEW stale-write token
  material_fingerprint: string; // NEW drawer freshness token
  conclusion: string;
  trigger: string;
  trigger_evidence: TriggerEvidence[];
  impact: string;
  recommendation: string | null;
  options: DecisionOption[];  // CHANGED from string[]
  owner: string;
  expires_at: number | null;
  scene_entry: SceneEntry | null;
  prior_decisions: PriorDecision[];
  artifacts: ArtifactRef[];
  effect_state: AttentionItem["effect_state"];
  contract_revision: number;
  stale_objects: StaleObjectEntry[];
  budget_limited?: boolean;
}

// EXISTING signature, updated return shape only
export function assembleDecisionView(db: Database, input: GetContextPackageInput): AssemblyResult;
```

Option order equals `AttentionItem.options`; IDs are unchanged. Generic `stop`, `continue`, and `narrow` metadata lives in the shared store derivation used by both material fingerprinting and assembly. `narrow` requires both reason and replacement contract. Approval options use the active registered target effect and state explicitly that choosing records an answer, not effect success. Any unknown option without authoritative active target semantics makes assembly fail closed with `needs_context`; neither material projection nor UI invents executable semantics or buttons (`src/control/store.ts`; `src/control/context-assembler.ts`). The Web drawer submits `attention_revision`, current contract revision, affected-card snapshots where applicable, and the material fingerprint; a changed package displays the new package while retaining only an unsubmitted local draft.

### 4.3 Mailbox, effects, audit, and outbox

These remain authoritative **EXISTING** seams:

```ts
export function writeHumanAnswer(
  db: Database, owner: ConsumerOwner, id: string, answer: string,
  actor?: string, now?: number,
): { ok: true } | { ok: false; reason: string };
export function consumeDecision(db: Database, input: ConsumeInput): Receipt | null;
export function observeReceiptEffect(db: Database, observation: EffectObservation): boolean;
export function enqueueControlEvent(db: Database, input: {
  entity_id: string; entity_version: number; kind: string;
  work_id?: string; item_id?: string; payload: Record<string, unknown>;
}, now?: number): string;
```

Add one **NEW** control-side projection seam:

```ts
export type AttentionAuditLink = {
  work_id: string;
  item_id: string;
  item_revision: number;
  approval_id: string | null;
  receipt_id: string | null;
  outbox_event_id: string;
};

export function projectAttentionEffect(
  db: Database,
  link: AttentionAuditLink,
  observation: EffectObservation,
  now?: number,
): AttentionItem;
```

`projectAttentionEffect` accepts only an observation already accepted by mailbox `observeReceiptEffect`; it updates the same Attention row and enqueues the corresponding outbox event in one immediate source transaction. `succeeded` resolves only when no acceptance or other responsibility remains. `failed`/`unknown` restores visible responsibility. Every emitted payload includes the audit link. Adapters observe/submit external effects; they do not author Attention truth. A unique mailbox receipt and target-version CAS remain the no-double-consume boundary.

### 4.4 Notification and shadow seams

```ts
// NEW in src/notify/nudge.ts (or a sibling module re-exported here)
export type NotificationChannel = "macos" | "feishu";
export type NotificationThreshold = "new_now" | "material_change" | "expires_soon" | "expired";
export type NotificationOutcome = "shadowed" | "pending" | "sent" | "failed" | "unknown" | "suppressed";
export type NotificationMode = "shadow" | "send";

export type NotificationCandidate = {
  subject: string;
  material_key: string;
  threshold: NotificationThreshold;
  source_kind: "attention" | "legacy_q1" | "legacy_hung";
  source_id: string;
  reason: string;
  work_id?: string;
  item_id?: string;
  item_revision?: number;
  approval_id?: string;
  receipt_id?: string;
  outbox_event_id?: string;
};

export type NotificationPolicy = {
  mode: NotificationMode;
  primary_channel: NotificationChannel;
  owner_epoch: string;
  expires_soon_ms: number; // default 900_000
  max_attempts: number;    // default 3
};

export type NotificationDelivery = {
  outcome: "sent" | "failed" | "unknown";
  external_id?: string;
  error?: string;
};

export interface NotificationSender {
  readonly channel: NotificationChannel;
  send(candidates: readonly NotificationCandidate[]): Promise<NotificationDelivery>;
}

export function collectNotificationCandidates(
  ledger: Database,
  control: Database,
  now?: number,
): NotificationCandidate[];
export async function runNotificationCycle(input: {
  ledger: Database;
  control: Database;
  policy: NotificationPolicy;
  sender: NotificationSender;
  now?: number;
}): Promise<{ claimed: number; sent: number; failed: number; unknown: number; shadowed: number }>;
```

Collection is side-effect free. Claim/outcome writes are durable. Default `shadow` is legacy-only send: `nudgeOnce` runs the incumbent Q1/hung newline-state sender first, then records candidate comparison rows and `shadowed` outcomes without invoking the candidate sender; Attention is candidate-only until explicit cutover (`src/notify/nudge.ts`). `failed` retries only while `attempt_count < max_attempts`; `unknown` is not blindly resent. A channel receipt means channel acceptance, not user read. macOS and Feishu share the same `control_notifications` claim, `owner_epoch`, and primary-channel policy after cutover; they cannot independently dedup.

### 4.5 HTTP conflict body

Stale Attention revision or material-fingerprint submissions return HTTP 409 with this body; the route does not apply the submitted answer and gives the client the current state plus the package refresh URL (`src/web/server.ts`):

```ts
export type StaleAttentionBody = {
  error: "conflict";
  message: "stale attention revision";
  code: "stale_attention";
  item_id: string;
  expected_revision: number;
  current_revision: number;
  current_state: AttentionItem["state"];
  current_effect_state: AttentionItem["effect_state"];
  decision_package_url: string;
};
```

Target-version conflicts keep their mailbox/adapter conflict contract rather than pretending to be this Attention-CAS body. Feishu refreshes current state and does not retry the answer.

## 5. Ownership and invariants

1. **Control is the sole writer of Attention and material projection.** Web, notify, Feishu, runtime adapters, and ledger never write Attention SQL directly.
2. **Mailbox is the sole writer/consumer of answers and receipts.** A valid answer is not effect success. The unique receipt plus target version ensures at-most-once consumption across Web, Feishu, double click, restart, and replay.
3. **Adapters are effect observers.** They may dispatch and report accepted/rejected/unknown external results, but cannot resolve Attention without the control projection seam.
4. **Outbox is transactional.** Every control state/material transition and its outbox row commit in the same immediate transaction. Publication may repeat; projection must be idempotent and non-regressing.
5. **Applying and follow-up stay visible.** Answer-recorded, consumed/applying, partial, failed, and unknown responsibility appears in follow-up + Work until verified closure. Done remains resolved/superseded history.
6. **Failure/unknown reopens responsibility.** Unknown is never success, never authorizes replay, and never disappears because an attempt or Work ID changes.
7. **No double consume or double notify.** Mailbox target-version uniqueness governs consumption; notification subject/material/threshold/epoch uniqueness governs interruption.
8. **Expiry is independent of defer.** Deferring presentation cannot extend approval expiry, consume an expired answer, or reset retry/notification budgets.
9. **Trusted identity for decisions.** Context access and resolve use server-injected local identity or adapter-authenticated Feishu identity; request bodies cannot self-assert the decision actor. Ack remains a non-authorizing seen marker. Sensitive package fields continue through visibility policy; notification text contains no raw evidence by default.
10. **Feishu is projection/writeback, not authority.** Local control/mailbox facts win. A configured primary Feishu sender is a cutover option, not a verified production capability; primary macOS and Feishu delivery share one claim table and exactly one configured owner.

## 6. Defaults, shadow run, and switch procedure

Frozen defaults:

```text
OVERLOAD_NOTIFICATION_MODE=shadow
OVERLOAD_NOTIFICATION_PRIMARY=macos
OVERLOAD_NOTIFICATION_OWNER=maintenance
OVERLOAD_NOTIFICATION_OWNER_EPOCH=phase-a-shadow-1
OVERLOAD_NOTIFICATION_EXPIRES_SOON_MS=900000
OVERLOAD_NOTIFICATION_MAX_ATTEMPTS=3
```

Default `shadow` preserves the incumbent legacy Q1/hung newline-state sender as the only real sender. The candidate notification cycle records comparison rows and `shadowed` outcomes and must not call its macOS or Feishu sender; Attention has no legacy-send counterpart and is candidate-only. Exactly one launchd/daemon process with `OVERLOAD_NOTIFICATION_OWNER=maintenance` may run the candidate cycle. Feishu may synchronize status/cards and write back decisions, but it is not a second notification owner.

Cutover is ordered and reversible:

1. deploy v6; its transactional backfill/repair gives missing open Attention generation-1 material without directly sending, while default shadow keeps legacy Q1/hung as the only sender;
2. run focused A01–A17 tests and inspect shadow false-negative/duplicate rows; this is not a claim that A17 has production shadow coverage, and unlinked legacy rows remain visible coverage gaps;
3. stop the legacy newline-state sender path;
4. atomically configure one primary channel, set a fresh owner epoch (for example `phase-a-send-1`), and set mode `send` for the single maintenance owner;
5. restart only that owner, verify a pending claim becomes one durable terminal outcome, and confirm the other channel did not claim it; a configured real-channel smoke requires credentials and explicit operator authorization and has not yet been claimed here;
6. rollback by returning to `shadow`; this restores legacy-only sending and candidate comparison behavior without changing authorization, Attention, mailbox, or receipts. Never run legacy and candidate send paths concurrently.

Switching primary channel requires stopping the owner, changing `PRIMARY` and `OWNER_EPOCH` together, then restarting one owner. Existing terminal outcomes are retained for audit.

## 7. A01–A17 acceptance map

| ID | Contract field/invariant | Focused proof |
| --- | --- | --- |
| A01 | fingerprint excludes heartbeat/progress/prose; shadow only | material + notification tests: equal fingerprint, zero candidate send |
| A02 | subject excludes revision; distinct Attention subject gets `new_now` | notification aggregation test with uncleared old Now and new item |
| A03 | CAS revision is independent of material fingerprint | store test: revision increases, generation unchanged, no claim |
| A04 | `material_change`, `expires_soon`, `expired` unique thresholds | material/notification test: changed risk and each threshold claim once |
| A05 | defer does not change `expires_at`; mailbox checks expiry | store + mailbox expiry test |
| A06 | complete package and server-owned `DecisionOption` metadata | context assembler + browser card/drawer test; no normal-path raw JSON |
| A07 | package carries Attention revision/fingerprint; 409 body returns current state | context route/server/browser stale-drawer test |
| A08 | server actor and visibility policy remain mandatory | context route, server, visibility, Feishu owner tests |
| A09 | mailbox unique receipt and store CAS shared by Web/Feishu | concurrent adapter/server test: one success, one understandable 409/current state |
| A10 | `AttentionFollowUp.answer_recorded/applying` stays visible | store read-model + browser/Feishu projection test |
| A11 | `unknown` projection restores visible responsibility, no replay | mailbox reconciliation + effect projection test |
| A12 | `occurred_effects` and `remaining_responsibility` are separate | multi-observation follow-up test |
| A13 | verified checks do not erase outstanding human acceptance | follow-up/Work acceptance-responsibility test |
| A14 | succeeded plus no responsibility resolves once; ordinary completion sends none | effect projection + notification test |
| A15 | CAS, receipt uniqueness, non-regressing projection, durable notification uniqueness | restart/replay/out-of-order SQLite test |
| A16 | durable `failed/unknown`, bounded attempts, no blind unknown resend | notification sender failure/unknown test |
| A17 | explicit approval/request binding, preserved unlinked legacy subjects, shared claim table, and single-owner cutoff | focused mixed Q1/hung/Attention correlation, shadow, and send integration tests; production shadow coverage remains a release-gate item |

## 8. Verification commands

Run focused files during slice work; run the repository command once after integration. These are the only package-supported commands—there is no typecheck script.

```sh
bun test src/control/store.test.ts src/control/store-extra.test.ts src/control/context-assembler.test.ts
bun test src/decision-bot/mailbox.test.ts src/decision-bot/reconcile.test.ts
bun test src/adapters/service.test.ts src/adapters/feishu.test.ts
bun test src/notify/nudge.test.ts
bun test src/web/server.test.ts src/web/context-ui.test.ts src/web/ui-regression.test.ts src/web/ledger.test.ts
bun test
```

Browser acceptance must exercise the actual loopback surface for A06, A07, A10, A12, and A14. Channel acceptance uses isolated Feishu adapter tests; one configured real-channel smoke is still required by the production release gate when credentials and explicit operator authorization are available. A mock receipt proves state rules, not external delivery, and this document does not claim the Feishu real channel has been verified.