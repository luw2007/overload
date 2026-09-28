// Context handoff contract (docs/plans/overload-20260928-manager-chat.md §1.5).
export type HandoffSourceKind = "manager_turn" | "attention_item";
export type HandoffTargetKind = "session";
export type HandoffState = "pending" | "read" | "acknowledged" | "concluded" | "expired";
export type HandoffAckDecision = "adopt" | "defer" | "reject" | "no_change";
export type HandoffConclusionKind = "decision" | "conclusion";
export type HandoffReturnState = "queued" | "presented" | "explicit_unverified";

export type CollaborationBrief = {
  version: "collaboration_brief_v0";
  purpose: string;
  context: string;
  constraints: string[];
  inputs: string[];
  acceptance: string[];
  return_requirement: string;
};

export type HandoffTarget = { target_kind: HandoffTargetKind; target_id: string };

export type CreateHandoffInput = HandoffTarget & {
  source_kind: HandoffSourceKind;
  source_id: string;
  brief: CollaborationBrief;
  original_message?: string | null;
};

export type HandoffRequest = HandoffTarget & {
  request_id: string;
  source_kind: HandoffSourceKind;
  source_id: string;
  brief: CollaborationBrief;
  original_message: string | null;
  state: HandoffState;
  created_at: number;
  read_at: number | null;
  acknowledged_at: number | null;
  ack_decision: HandoffAckDecision | null;
  ack_reason: string | null;
  conclusion_kind: HandoffConclusionKind | null;
  conclusion_text: string | null;
  concluded_at: number | null;
};

export type HandoffReceipt = {
  request_id: string;
  priority_changed: false;
  todo_created: false;
  execution_interrupted: false;
};

export type HandoffReturn = {
  request_id: string;
  destination_kind: "manager_conversation" | "attention_item";
  destination_id: string;
  state: HandoffReturnState;
  presented_at: number | null;
  last_error: string | null;
};
