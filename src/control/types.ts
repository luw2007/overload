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
