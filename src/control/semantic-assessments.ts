import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { ControlError, ensureControlSchema, getAttention, getAttentionMaterial } from "./store";

export const SEMANTIC_ASSESSMENT_VERSION = "semantic_assessment_v1";
export const SEMANTIC_ASSESSMENT_MAX_PER_PASS = 20;
export const SEMANTIC_ASSESSMENT_MAX_ATTEMPTS = 2;

export type SemanticAssessmentState = "pending" | "running" | "completed" | "unavailable" | "failed" | "stale";
export type SemanticAssessmentVerdict = "ordinary" | "needs_attention" | "uncertain";

export interface SemanticAssessment {
  assessment_id: string;
  item_id: string;
  attention_revision: number;
  material_fingerprint: string;
  model: string;
  assessment_version: string;
  state: SemanticAssessmentState;
  verdict: SemanticAssessmentVerdict | null;
  rationale: string | null;
  confidence: number | null;
  attempts: number;
  lease_token: string | null;
  lease_until: number | null;
  error: string | null;
  observed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface SemanticAssessmentClaim {
  assessment: SemanticAssessment;
  material: { fingerprint: string; inputs: Record<string, unknown> };
}

export type SemanticAssessmentResult = {
  verdict: SemanticAssessmentVerdict;
  rationale: string;
  confidence: number;
};

function assessmentFrom(row: Record<string, unknown>): SemanticAssessment {
  return {
    assessment_id: row.assessment_id as string,
    item_id: row.item_id as string,
    attention_revision: row.attention_revision as number,
    material_fingerprint: row.material_fingerprint as string,
    model: row.model as string,
    assessment_version: row.assessment_version as string,
    state: row.state as SemanticAssessmentState,
    verdict: row.verdict as SemanticAssessmentVerdict | null,
    rationale: row.rationale as string | null,
    confidence: row.confidence as number | null,
    attempts: row.attempts as number,
    lease_token: row.lease_token as string | null,
    lease_until: row.lease_until as number | null,
    error: row.error as string | null,
    observed_at: row.observed_at as number | null,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

function assessmentId(itemId: string, attentionRevision: number, materialFingerprint: string, model: string): string {
  return createHash("sha256").update(`${itemId}\0${attentionRevision}\0${materialFingerprint}\0${model}`).digest("hex");
}

function validModel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}

export function semanticAssessmentsEnabled(): boolean {
  return process.env.OVERLOAD_SEMANTIC_ASSESSMENTS === "1";
}

export function ensureSemanticAssessmentSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS control_semantic_assessments(
    assessment_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    attention_revision INTEGER NOT NULL CHECK(attention_revision >= 1),
    material_fingerprint TEXT NOT NULL CHECK(length(material_fingerprint)=64),
    model TEXT NOT NULL,
    assessment_version TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','running','completed','unavailable','failed','stale')),
    verdict TEXT CHECK(verdict IS NULL OR verdict IN ('ordinary','needs_attention','uncertain')),
    rationale TEXT,
    confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
    lease_token TEXT,
    lease_until INTEGER,
    error TEXT,
    observed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(item_id,attention_revision,material_fingerprint,model),
    FOREIGN KEY(item_id) REFERENCES control_attention(item_id),
    CHECK((state='completed' AND verdict IS NOT NULL AND rationale IS NOT NULL AND confidence IS NOT NULL AND observed_at IS NOT NULL) OR state<>'completed'),
    CHECK((state='running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (state<>'running' AND lease_token IS NULL AND lease_until IS NULL))
  );
  CREATE INDEX IF NOT EXISTS control_semantic_assessments_due
    ON control_semantic_assessments(state, updated_at, assessment_id)
    WHERE state='pending';
  CREATE INDEX IF NOT EXISTS control_semantic_assessments_item
    ON control_semantic_assessments(item_id, created_at DESC);`);
}

export function scheduleSemanticAssessment(
  db: Database,
  itemId: string,
  model: string,
  now = Date.now(),
): SemanticAssessment | null {
  ensureControlSchema(db);
  if (!semanticAssessmentsEnabled()) return null;
  ensureSemanticAssessmentSchema(db);
  if (!validModel(model)) throw new ControlError("invalid", "semantic assessment model is required");
  const item = getAttention(db, itemId);
  if (!item || item.state !== "open" || item.effect_state !== "not_started") return null;
  const material = getAttentionMaterial(db, itemId);
  if (!material) throw new ControlError("blocked", "attention material unavailable");
  const id = assessmentId(item.item_id, item.revision, material.fingerprint, model);
  db.query(`INSERT OR IGNORE INTO control_semantic_assessments(
    assessment_id,item_id,attention_revision,material_fingerprint,model,assessment_version,state,verdict,rationale,confidence,attempts,lease_token,lease_until,error,observed_at,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,'pending',NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,?,?)`)
    .run(id, item.item_id, item.revision, material.fingerprint, model, SEMANTIC_ASSESSMENT_VERSION, now, now);
  const row = db.query("SELECT * FROM control_semantic_assessments WHERE assessment_id=?").get(id) as Record<string, unknown> | null;
  return row ? assessmentFrom(row) : null;
}

function expireAbandonedClaims(db: Database, now: number): void {
  db.query(`UPDATE control_semantic_assessments
    SET state='pending', lease_token=NULL, lease_until=NULL, error='lease_expired', updated_at=?
    WHERE state='running' AND lease_until<=? AND attempts<?`).run(now, now, SEMANTIC_ASSESSMENT_MAX_ATTEMPTS);
  db.query(`UPDATE control_semantic_assessments
    SET state='failed', lease_token=NULL, lease_until=NULL, error='attempt_budget_exhausted', updated_at=?
    WHERE state='running' AND lease_until<=? AND attempts>=?`).run(now, now, SEMANTIC_ASSESSMENT_MAX_ATTEMPTS);
}

export function claimSemanticAssessments(
  db: Database,
  input: { model: string; limit?: number; lease_ms?: number },
  now = Date.now(),
): SemanticAssessmentClaim[] {
  ensureControlSchema(db);
  if (!semanticAssessmentsEnabled()) return [];
  ensureSemanticAssessmentSchema(db);
  if (!validModel(input.model)) throw new ControlError("invalid", "semantic assessment model is required");
  const limit = input.limit ?? SEMANTIC_ASSESSMENT_MAX_PER_PASS;
  const leaseMs = input.lease_ms ?? 30_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEMANTIC_ASSESSMENT_MAX_PER_PASS) throw new ControlError("invalid", "limit must be 1..20");
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 60_000) throw new ControlError("invalid", "lease_ms must be 1000..60000");
  return db.transaction(() => {
    expireAbandonedClaims(db, now);
    const rows = db.query(`SELECT s.*,m.inputs FROM control_semantic_assessments s
      JOIN control_attention a ON a.item_id=s.item_id
      JOIN control_attention_material m ON m.item_id=s.item_id
      WHERE s.state='pending' AND s.model=? AND s.attempts<?
        AND a.state='open' AND a.effect_state='not_started'
        AND a.revision=s.attention_revision AND m.fingerprint=s.material_fingerprint
      ORDER BY s.created_at,s.assessment_id LIMIT ?`).all(input.model, SEMANTIC_ASSESSMENT_MAX_ATTEMPTS, limit) as Array<Record<string, unknown>>;
    const claims: SemanticAssessmentClaim[] = [];
    for (const row of rows) {
      const token = randomUUID();
      const changed = db.query(`UPDATE control_semantic_assessments
        SET state='running',attempts=attempts+1,lease_token=?,lease_until=?,error=NULL,updated_at=?
        WHERE assessment_id=? AND state='pending'`).run(token, now + leaseMs, now, row.assessment_id).changes;
      if (!changed) continue;
      const claimed = db.query("SELECT * FROM control_semantic_assessments WHERE assessment_id=?").get(row.assessment_id) as Record<string, unknown>;
      claims.push({ assessment: assessmentFrom(claimed), material: { fingerprint: row.material_fingerprint as string, inputs: JSON.parse(row.inputs as string) as Record<string, unknown> } });
    }
    return claims;
  }).immediate() as SemanticAssessmentClaim[];
}

function currentAssessmentInput(db: Database, assessment: SemanticAssessment): boolean {
  const item = getAttention(db, assessment.item_id);
  const material = getAttentionMaterial(db, assessment.item_id);
  return !!item && !!material && item.state === "open" && item.effect_state === "not_started"
    && item.revision === assessment.attention_revision && material.fingerprint === assessment.material_fingerprint;
}

export function settleSemanticAssessment(
  db: Database,
  input: { assessment_id: string; lease_token: string; result?: SemanticAssessmentResult; unavailable?: string },
  now = Date.now(),
): SemanticAssessment {
  ensureControlSchema(db);
  ensureSemanticAssessmentSchema(db);
  if (!input || typeof input.assessment_id !== "string" || !input.assessment_id.trim() || typeof input.lease_token !== "string" || !input.lease_token.trim()) throw new ControlError("invalid", "assessment_id and lease_token are required");
  const hasResult = input.result !== undefined;
  const hasUnavailable = typeof input.unavailable === "string" && input.unavailable.trim();
  if (hasResult === hasUnavailable) throw new ControlError("invalid", "provide exactly one of result or unavailable");
  if (input.result) {
    if (!['ordinary', 'needs_attention', 'uncertain'].includes(input.result.verdict)
      || typeof input.result.rationale !== "string" || !input.result.rationale.trim() || input.result.rationale.length > 2_000
      || typeof input.result.confidence !== "number" || input.result.confidence < 0 || input.result.confidence > 1) throw new ControlError("invalid", "invalid semantic assessment result");
  }
  return db.transaction(() => {
    const row = db.query("SELECT * FROM control_semantic_assessments WHERE assessment_id=?").get(input.assessment_id) as Record<string, unknown> | null;
    if (!row) throw new ControlError("not_found", "semantic assessment not found");
    const assessment = assessmentFrom(row);
    if (assessment.state !== "running" || assessment.lease_token !== input.lease_token || !assessment.lease_until || assessment.lease_until < now) throw new ControlError("conflict", "semantic assessment claim is stale");
    if (!currentAssessmentInput(db, assessment)) {
      db.query("UPDATE control_semantic_assessments SET state='stale',lease_token=NULL,lease_until=NULL,error='attention_or_material_changed',updated_at=? WHERE assessment_id=?")
        .run(now, assessment.assessment_id);
    } else if (input.result) {
      db.query(`UPDATE control_semantic_assessments SET state='completed',verdict=?,rationale=?,confidence=?,lease_token=NULL,lease_until=NULL,observed_at=?,updated_at=? WHERE assessment_id=?`)
        .run(input.result.verdict, input.result.rationale, input.result.confidence, now, now, assessment.assessment_id);
    } else {
      db.query("UPDATE control_semantic_assessments SET state='unavailable',lease_token=NULL,lease_until=NULL,error=?,updated_at=? WHERE assessment_id=?")
        .run(input.unavailable, now, assessment.assessment_id);
    }
    return assessmentFrom(db.query("SELECT * FROM control_semantic_assessments WHERE assessment_id=?").get(assessment.assessment_id) as Record<string, unknown>);
  }).immediate() as SemanticAssessment;
}

export function listSemanticAssessments(db: Database, itemId: string): SemanticAssessment[] {
  ensureControlSchema(db);
  const hasSchema = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='control_semantic_assessments'").get();
  if (!hasSchema) return [];
  return (db.query("SELECT * FROM control_semantic_assessments WHERE item_id=? ORDER BY created_at DESC,assessment_id DESC").all(itemId) as Record<string, unknown>[]).map(assessmentFrom);
}
