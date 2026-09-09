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
};
