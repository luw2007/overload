# Overload Phase A implementation contract

Date: 2026-09-26  
Status: frozen implementation contract for Product A

This document is the copy-pasteable boundary between Phase A implementation slices. Terms marked **EXISTING** name current code. Terms marked **NEW** are the only new contracts authorized here.

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

- `Contract`, `Work`, and `AttentionItem` are defined at `src/control/types.ts:8-65`; Attention state is `open | applying | resolved | superseded` and effect state is `not_started | applying | succeeded | failed | unknown` (`src/control/types.ts:45-46`). Do not duplicate these facts.
- `listAttention` currently excludes `applying` from Now/Inbox/Done (`src/control/store.ts:314-315`). Phase A must fix presentation through the new follow-up read model, not change Done semantics.
- resolve uses revision CAS and external-effect guards (`src/control/store.ts:534-614,617-633`). Ack and defer neither answer nor authorize.
- schema ownership is `control_schema_meta` plus explicit `CONTROL_MIGRATIONS`; migrations run as immediate transactions and destructive ones receive a `VACUUM INTO` backup (`src/control/store.ts:141-177`).
- `DecisionViewPackage` and `assembleDecisionView` exist at `src/control/context-assembler.ts:59-79,325-426`. Its current options are bare strings; generic option effects are validated in `src/control/store.ts:538-545,599-611`, while the Web consequence map is currently hard-coded (`src/web/static/app.js:52-54`).
- context and resolve routes receive only the server-injected actor; request data cannot supply identity (`src/web/context-routes.ts:11-17,28-41,74-88`; `src/web/server.ts:121-139,319-321`).
- stale Attention CAS already maps to HTTP 409 `{error:"conflict",message:"stale attention revision"}` (`src/control/store.ts:535,623`; `src/web/server.ts:85-88`).
- the Web evidence paths currently render raw `item.evidence` instead of fetching the decision package (`src/web/static/app.js:58-60,605-613`).
- mailbox targets, answers, receipts, and effect observations already exist (`src/decision-bot/mailbox.ts:8-12,21-42`). `consumeDecision` owns single consumption and `effect_observed` reconciliation (`src/decision-bot/mailbox.ts:68-81`; `src/extension/overload.ts:491-492`).
- adapter dispatch already moves a card to applying and reopens dispatch rejection as `open/unknown` (`src/adapters/service.ts:896-990`).
- control outbox identity/hash and ledger projection already exist (`src/control/outbox.ts:31-49,52-68,90-97`). State mutation and outbox insertion must remain one source transaction.
- Feishu is an **existing writeback path**, not a mock: its card action emits `itemId`, `revision`, and `answer` (`src/adapters/feishu.ts:234-268`), and `AdapterService.accept` applies the same ownership/version/expiry rules before mailbox or generic resolve (`src/adapters/service.ts:132-231`).
- the current nudge combines legacy Q1, hung, and Attention subjects but keeps only a newline set and supports only macOS (`src/notify/nudge.ts:24-65`).
- `package.json:7-12` provides only `bun test`; there is no repository typecheck script.

## 3. Frozen persistence contract

### 3.1 Migration strategy

Raise `CONTROL_SCHEMA_VERSION` from 5 to 6 and append exactly one non-destructive **NEW** `CONTROL_MIGRATIONS` entry. The v6 migration creates the following tables and indexes with `CREATE TABLE/INDEX IF NOT EXISTS`, then updates `control_schema_meta` to 6 inside the existing immediate transaction. It does not alter, copy, or reinterpret existing Work, Attention revision/effect state, mailbox, or outbox rows. Existing Attention rows acquire material state lazily on first projection; no fabricated historical notification is sent during backfill.

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

`subject` is the stable responsibility identity: `attention:<item_id>`, `q1:<request_uid>`, or `hung:<stable_id>`. It deliberately excludes Attention revision. `material_key` is `<subject>:<fingerprint>` for Attention; legacy subjects use `<subject>:legacy-open` until they can be linked reliably. `owner_epoch` is the configured notification-owner epoch, changed only during an explicit cutover. The uniqueness constraint prevents both channels or retries from claiming the same interruption in one epoch. `channel` records the chosen primary delivery; non-primary channels may still update cards/status but must not insert a sending claim.

`approval_id`, `receipt_id`, and `outbox_event_id` are nullable audit correlations, not replacement authorities. Cross-database foreign keys are intentionally absent. When known, writers must record them; unknown legacy linkage remains null rather than guessed.

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
3. serialize objects with lexicographically sorted keys, arrays in the order above, JSON primitives unchanged, and no insignificant whitespace—the same recursive canonical JSON behavior already used by `src/control/outbox.ts:8-14` and `src/decision-bot/mailbox.ts:14-19` should be extracted/reused rather than forked;
4. `fingerprint = sha256(canonical(inputs))`; `material_key = subject + ":" + fingerprint`.

Timestamps, card revision, updated time, prose summary, heartbeat, ordinary logs, and source-declared `material_change` are not inputs. `risk`, `decision`, and `consequence` are deterministic projections from current card/contract facts. `option_effects` comes only from server-known option semantics. `decisive_evidence` contains the pinned evidence conclusions used by `DecisionViewPackage`, not raw logs. Expiry contributes only exact `expires_at` and derived `expired`; threshold dedup remains separately keyed by `threshold`.

On first observation, insert generation 1. On equal fingerprint, retain generation and only refresh `computed_at`. On a different fingerprint, increment generation in the same transaction as the Attention mutation and its outbox event. A source assertion can request recomputation but cannot choose the fingerprint, urgency, authorization, or notification.

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

`listAttention` is the current function typed with the exported zone alias, not a new behavior. `resolveAttention` is the single public wrapper for the current generic decision resolver; Web and Feishu must call this seam rather than duplicate checks. Approval-linked items continue through mailbox write/consume and are rejected by this wrapper. `listAttentionFollowUps` derives fields from existing Attention plus mailbox receipt/effect observations; it does not persist a second status. It includes: answer recorded but unconsumed, every `state='applying'`, and any `effect_state IN ('failed','unknown')` with remaining responsibility. It excludes only rows with verified success and no remaining responsibility. The Web read response is `{items: AttentionFollowUp[]}`.

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

Option order equals `AttentionItem.options`; IDs are unchanged. Generic `stop`, `continue`, and `narrow` metadata is a typed server map beside the existing handlers. `narrow` requires both reason and replacement contract. Approval options use the registered target effect and explicitly say that choosing records an answer; it does not claim effect success. Unknown option IDs make assembly fail closed with `needs_context`; UI does not synthesize buttons. The Web drawer submits `attention_revision`, current contract revision, and affected-card snapshots where applicable; a changed package displays the new package while retaining an unsubmitted local draft only.

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

Collection is side-effect free. Claim/outcome writes are durable. In `shadow` mode no sender is invoked: comparison rows and `shadowed` outcomes are recorded only. `failed` retries only while `attempt_count < max_attempts`; `unknown` is not blindly resent. A channel receipt means channel acceptance, not user read. macOS and Feishu share the same `control_notifications` claim, `owner_epoch`, and primary-channel policy; they cannot independently dedup.

### 4.5 HTTP conflict body

All stale package, Attention revision, target version, or material-fingerprint submissions return HTTP 409 with this **NEW superset** (the existing `error` and `message` values remain unchanged):

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

No submitted answer is applied on 409. Feishu translates the same conflict into a refresh/current-state response and does not retry the answer.

## 5. Ownership and invariants

1. **Control is the sole writer of Attention and material projection.** Web, notify, Feishu, runtime adapters, and ledger never write Attention SQL directly.
2. **Mailbox is the sole writer/consumer of answers and receipts.** A valid answer is not effect success. The unique receipt plus target version ensures at-most-once consumption across Web, Feishu, double click, restart, and replay.
3. **Adapters are effect observers.** They may dispatch and report accepted/rejected/unknown external results, but cannot resolve Attention without the control projection seam.
4. **Outbox is transactional.** Every control state/material transition and its outbox row commit in the same immediate transaction. Publication may repeat; projection must be idempotent and non-regressing.
5. **Applying and follow-up stay visible.** Answer-recorded, consumed/applying, partial, failed, and unknown responsibility appears in follow-up + Work until verified closure. Done remains resolved/superseded history.
6. **Failure/unknown reopens responsibility.** Unknown is never success, never authorizes replay, and never disappears because an attempt or Work ID changes.
7. **No double consume or double notify.** Mailbox target-version uniqueness governs consumption; notification subject/material/threshold/epoch uniqueness governs interruption.
8. **Expiry is independent of defer.** Deferring presentation cannot extend approval expiry, consume an expired answer, or reset retry/notification budgets.
9. **Trusted identity only.** Actor remains server-injected locally and adapter-authenticated in Feishu. Sensitive package fields continue through visibility policy; notification text contains no raw evidence by default.
10. **Feishu is projection/writeback, not authority.** Local control/mailbox facts win. Primary macOS and primary Feishu delivery use one claim table and exactly one configured owner.

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

`shadow` records candidate/legacy comparisons and notification rows only; it **must not call macOS or Feishu send**. Exactly one launchd/daemon process with `OVERLOAD_NOTIFICATION_OWNER=maintenance` may claim notifications. Feishu remains enabled for status/card synchronization and writeback but is not a second notification owner.

Cutover is ordered and reversible:

1. deploy v6 and run shadow mode over the same Attention/Q1/hung inputs while the legacy nudge remains the only sender;
2. pass A01–A17 focused tests and inspect shadow false-negative/duplicate rows; unlinked legacy rows are reported as coverage gaps, never guessed;
3. stop the legacy newline-state sender path;
4. atomically configure one primary channel, set a fresh owner epoch (for example `phase-a-send-1`), and set mode `send` for the single maintenance owner;
5. restart only that owner, verify a pending claim becomes one durable terminal outcome, and confirm the other channel did not claim it;
6. rollback by returning to `shadow`; this stops new sends without changing authorization, Attention, mailbox, or receipts. Never run legacy and new send paths concurrently.

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
| A17 | shared legacy subjects/claim table and single-owner cutoff | mixed Q1/hung/Attention shadow and send integration test |

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

Browser acceptance must exercise the actual loopback surface for A06, A07, A10, A12, and A14. Channel acceptance must use the existing isolated Feishu adapter tests and one configured real-channel smoke only when credentials and explicit operator authorization are available; a mock receipt proves state rules, not external delivery.