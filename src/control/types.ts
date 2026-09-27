export type AcceptanceCriterion = {
  id: string;
  kind: "check" | "artifact" | "human";
  description: string;
  evidence?: string;
};

export type Contract = {
  objective: string;
  beneficiary?: string;
  acceptance: AcceptanceCriterion[];
  non_goals: string[];
  scope: {
    repo?: string;
    cwd?: string;
    allowed_effects?: string[];
    human_only_effects?: string[];
  };
  budget: {
    retry_limit?: number;
    deadline_at?: number;
    cost_limit?: number;
    cost_mode?: "hard" | "soft" | "unknown";
  };
  stop_conditions: Array<{ id: string; kind: "hard" | "judgment"; description: string }>;
  decision_owner: string;
};

export type Work = {
  work_id: string;
  title: string;
  source: string;
  source_id: string | null;
  state: "candidate" | "active" | "stopped" | "completed";
  revision: number;
  contract: Contract | null;
  created_at: number;
  updated_at: number;
};

export type AttentionItem = {
  item_id: string;
  work_id: string;
  revision: number;
  state: "open" | "applying" | "resolved" | "superseded";
  effect_state: "not_started" | "applying" | "succeeded" | "failed" | "unknown";
  /** Why the effect ended in this state (e.g. "push_failed"); null while unexplained. */
  effect_detail: string | null;
  urgency: "now" | "inbox";
  conclusion: string;
  trigger: string;
  impact: string;
  recommendation: string | null;
  options: string[];
  owner: string;
  expires_at: number | null;
  defer_until: number | null;
  acknowledged_at: number | null;
  source_link: string | null;
  approval_id: string | null;
  consumer_owner: "extension" | "orchestrator" | null;
  contract_revision: number;
  decision_mode: "human_only" | "scoped_auto";
  evidence: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

export type DecisionOption = {
  id: string;
  label: string;
  effect: string;
  consequence: string;
  requires_reason: boolean;
  requires_contract: boolean;
};

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

export type MaterialFingerprintInputs = {
  risk: string;
  decision: string;
  option_effects: Array<{ option: string; effect: string }>;
  decisive_evidence: Array<{ object_id: string; revision: number; conclusion: string }>;
  validity: { expires_at: number | null; expired: boolean };
  consequence: string;
};

export type AttentionMaterialProjection = {
  item_id: string;
  subject: string;
  material_key: string;
  fingerprint: string;
  generation: number;
  inputs: MaterialFingerprintInputs;
  computed_at: number;
};

export type AttentionAuditLink = {
  work_id: string;
  item_id: string;
  item_revision: number;
  approval_id: string | null;
  receipt_id: string | null;
  outbox_event_id: string;
};

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
export type AttentionCardSnapshot = { item_id: string; revision: number };

export type AffectedAttentionCard = { item_id: string; conclusion: string; revision: number };

export type ContractRevisionPreview = {
  current_contract: Contract | null;
  current_revision: number;
  affected_cards: AffectedAttentionCard[];
};

export type AttentionDecisionInput = {
  selected_option: string;
  replacement_contract?: Contract;
  reason?: string;
  expected_contract_revision?: number;
  affected_cards?: AttentionCardSnapshot[];
  /** Freshness tokens used by the Phase A decision package. */
  attention_revision?: number;
  material_fingerprint?: string;
};

// ── Phase B: bounded condition waits (docs/plans/overload-20260926-phaseB-contract.md §§4–5) ──

export type GithubPrMergedCondition = {
  kind: "github_pr_merged";
  source: {
    provider: "github";
    host: "github.com" | string;
    owner: string;
    repo: string;
    number: number;
  };
};

export type CheckNewResultCondition = {
  kind: "check_new_result";
  source: {
    orchestrator_db: "local";
    work_id: string;
    task_id: string;
    attempt_id: string;
    check_id: string;
    check_def_version: string;
  };
};

export type WorkCompletedCondition = {
  kind: "work_completed";
  source: {
    prerequisite_work_id: string;
    dependency_revision: number;
  };
};

export type WaitCondition =
  | GithubPrMergedCondition
  | CheckNewResultCondition
  | WorkCompletedCondition;

export type PrBaseline = {
  provider: "github"; host: string; owner: string; repo: string; number: number;
  state: "OPEN" | "CLOSED" | "MERGED"; merged_at: string | null; updated_at: string; observed_at: number;
};
export type CheckBaseline = {
  attempt_id: string; check_id: string; check_def_version: string;
  result_set_version: number; observed_at: number | null;
};
export type WorkBaseline = {
  prerequisite_work_id: string; dependency_revision: number;
  work_revision: number; state: Work["state"]; observed_at: number;
};
export type WaitBaseline = PrBaseline | CheckBaseline | WorkBaseline;
export type WaitBaselineSnapshot<B extends WaitBaseline = WaitBaseline> = {
  baseline: B;
  baseline_generation: number;
  fingerprint: string;
  established_at: number;
};

export type WaitDispositionInput =
  | { kind: "redecide" }
  | {
      kind: "authorized_resume";
      authorization: {
        consumer_owner: "extension" | "orchestrator";
        approval_id: string;
        target_version: string;
        approved_effect: "answer_blocked_request" | "resume_checkpoint";
        work_revision: number;
        attention_revision: number;
        attempt_id: string;
        checkpoint_reference: string;
        execution_owner: string;
        expires_at: number;
      };
    };

export type CreateWaitInput = {
  work_id: string;
  item_id: string;
  condition: WaitCondition;
  deadline_at: number;
  disposition?: WaitDispositionInput; // omitted means {kind:'redecide'}
  transient_budget?: number;          // omitted means 3; integer 1..3
};

export type WorkDependencyEdge = {
  work_id: string;
  prerequisite_work_id: string;
  revision: number;
  state: "active" | "revoked";
  created_by: string;
  created_at: number;
};

export type WaitState =
  | "watching" | "ready" | "unavailable" | "expired" | "cancelled";

export type WaitErrorKind =
  | "transient" | "rate_limited" | "permission_denied"
  | "unsupported_provider" | "configuration" | "invalid_response"
  | "identity_mismatch" | "source_missing" | "unknown";

export type WaitResumeGrant = Extract<WaitDispositionInput,
  { kind: "authorized_resume" }>["authorization"];

export type WaitDispositionState =
  | "pending" | "redecision_recorded" | "dispatching" | "dispatched"
  | "effect_succeeded" | "effect_failed" | "effect_unknown";

export type ConditionWait = {
  wait_id: string; work_id: string; item_id: string;
  condition: WaitCondition;
  source_identity: Record<string, unknown>;
  baseline_established_at: number;
  baseline: WaitBaseline; baseline_generation: number; source_generation: number;
  observed: Record<string, unknown> | null;
  observed_fingerprint: string | null;
  observed_generation: number; unchanged_count: number;
  last_observed_at: number | null; last_confirmed_at: number | null;
  state: WaitState; state_reason: string | null;
  ready_at: number | null; ready_observation_fingerprint: string | null;
  deadline_at: number; next_check_at: number | null;
  transient_failures: number; transient_budget: number;
  last_error_kind: WaitErrorKind | null; last_error_detail: string | null;
  retry_after_at: number | null;
  version: number; actor: string; decision_owner: string;
  disposition: "redecide" | "authorized_resume";
  resume_grant: WaitResumeGrant | null;
  disposition_state: WaitDispositionState | null;
  disposition_claim_id: string | null; dispatch_id: string | null;
  disposition_detail: Record<string, unknown> | null;
  disposition_at: number | null; effect_observed_at: number | null;
  created_at: number; updated_at: number;
};

export type WaitObservation =
  | { kind: "same"; observed: Record<string, unknown>; fingerprint: string; source_generation: number; observed_at: number }
  | { kind: "changed_not_ready"; observed: Record<string, unknown>; fingerprint: string; source_generation: number; observed_at: number }
  | { kind: "ready"; observed: Record<string, unknown>; fingerprint: string; source_generation: number; observed_at: number }
  | { kind: "error"; error_kind: WaitErrorKind; detail: string; observed_at: number; retry_after_at?: number };

/** §8.4 dispatch outcome; defined with the control types because `recordWaitDispatch` persists it. */
export type RecoveryDispatchResult =
  | { state: "accepted"; dispatch_id: string; accepted_at: number }
  | { state: "rejected" | "unknown"; reason: string; dispatch_id?: string };

/** §5.3 source adapter API. Adapters only observe; they never write control state. */
export type ObserveContext = {
  now: number;
  signal: AbortSignal;
};

export interface WaitSourceAdapter<C extends WaitCondition = WaitCondition,
  B extends WaitBaseline = WaitBaseline> {
  readonly kind: C["kind"];
  establishBaseline(condition: C, ctx: ObserveContext): Promise<WaitBaselineSnapshot<B>>;
  observe(wait: ConditionWait & { condition: C; baseline: B }, ctx: ObserveContext): Promise<WaitObservation>;
}

export type WaitSourceAdapters = {
  github_pr_merged: WaitSourceAdapter<GithubPrMergedCondition, PrBaseline>;
  check_new_result: WaitSourceAdapter<CheckNewResultCondition, CheckBaseline>;
  work_completed: WaitSourceAdapter<WorkCompletedCondition, WorkBaseline>;
};

/** 409 body for wait conflicts that must expose the existing row (§3.3). */
export type WaitConflictBody = {
  error: "conflict";
  code: "active_wait_exists" | "wait_not_cancellable";
  message: string;
  wait_id: string;
  version: number;
  state: WaitState;
  disposition_state: WaitDispositionState | null;
};
