import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMailbox, registerTarget, type ApprovalTarget } from "./mailbox";
import {
  candidateScopeHash,
  disablePolicyRule,
  enablePolicyRule,
  loadPolicy,
  matchingRule,
  policyAuthorizes,
  policyPrompt,
} from "./policy";

function makeTarget(over: Partial<ApprovalTarget> = {}): ApprovalTarget {
  return {
    consumerOwner: "extension", approvalId: "a", targetVersion: "v",
    question: "Q", options: ["approve", "deny"], effect: "push",
    scope: { gate: "action", cwd: "/repo" }, evidence: { command: "git push" },
    evidenceHash: "h", expiresAt: Date.now() + 60_000, state: "active", ...over,
  };
}

test("loadPolicy disables the bot when config file is missing and reports error", () => {
  const result = loadPolicy("/nonexistent-policy-path/config.json");
  expect(result.config.enabled).toBe(false);
  expect(result.error).toBeTruthy();
});

test("loadPolicy parses an enabled config and filters disabled rules", () => {
  const root = mkdtempSync(join(tmpdir(), "policy-load-"));
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({
    decision_bot: {
      enabled: true, model: "m", timeout_ms: 60_000, max_output_bytes: 262_144,
      rules: [{ id: "r1", consumer_owner: "extension", gate: "action", effect: "push", answers: ["approve"], cwd: "/repo", command: "git push" }],
    },
  }));
  const result = loadPolicy(configPath);
  expect(result.config.enabled).toBe(true);
  expect(result.config.rules).toHaveLength(1);
  expect(result.hash).toBeTruthy();
  rmSync(root, { recursive: true, force: true });
});

test("matchingRule requires every rule answer to be a target option and scope match", () => {
  const policy = loadPolicy("/nonexistent.json");
  const enabled = { ...policy, error: undefined as string | undefined, config: { enabled: true, model: "m", timeout_ms: 1, max_output_bytes: 1, rules: [{ id: "r", consumer_owner: "extension", gate: "action", effect: "push", answers: ["approve"], cwd: "/repo", command: "git push" }] } };
  expect(matchingRule(enabled, makeTarget())?.id).toBe("r");
  expect(matchingRule(enabled, makeTarget({ scope: { gate: "action", cwd: "/other" } }))).toBeNull();
  expect(matchingRule(enabled, makeTarget({ options: ["deny"] }))).toBeNull();
});

test("policyAuthorizes binds answer to rule answers and policy hash", () => {
  const policy = loadPolicy("/nonexistent.json");
  const hash = policy.hash;
  const enabled = { ...policy, error: undefined as string | undefined, config: { enabled: true, model: "m", timeout_ms: 1, max_output_bytes: 1, rules: [{ id: "r", consumer_owner: "extension", gate: "action", effect: "push", answers: ["approve"], cwd: "/repo", command: "git push" }] } };
  expect(policyAuthorizes(enabled, makeTarget(), "approve", hash)).toBe(true);
  expect(policyAuthorizes(enabled, makeTarget(), "deny", hash)).toBe(false);
  expect(policyAuthorizes(enabled, makeTarget(), "approve", "wrong-hash")).toBe(false);
});

test("policyPrompt embeds permitted answers and snapshot evidence hash", () => {
  const rule = { id: "r", consumer_owner: "extension", gate: "action", effect: "push", answers: ["approve"] };
  const prompt = policyPrompt(makeTarget(), rule);
  expect(prompt).toContain("permittedAnswers");
  expect(prompt).toContain("approve");
  expect(prompt).toContain("h");
});

test("candidateScopeHash is stable for identical scope and differs on command", () => {
  const base = { id: "r", consumer_owner: "extension" as const, gate: "g", effect: "e", answers: ["a"], cwd: "/c" };
  expect(candidateScopeHash({ ...base, command: "x" })).toBe(candidateScopeHash({ ...base, command: "x" }));
  expect(candidateScopeHash({ ...base, command: "x" })).not.toBe(candidateScopeHash({ ...base, command: "y" }));
});

test("disablePolicyRule flags a config rule and enable rejects unknown rules", () => {
  const root = mkdtempSync(join(tmpdir(), "policy-mut-"));
  const db = openMailbox(join(root, "m.db"));
  try {
    const policy = {
      config: { enabled: true, model: "m", timeout_ms: 1, max_output_bytes: 1, rules: [] },
      hash: "h",
      configuredRules: [{ id: "cfg-r", consumer_owner: "extension", gate: "g", effect: "e", answers: ["a"], cwd: "/c", command: "x" }],
    };
    const off = disablePolicyRule(db, policy, "cfg-r", "operator", "revoked");
    expect(off.ok).toBe(true);
    expect(off.disabled).toBe(true);
    expect(enablePolicyRule(db, policy, "missing", "operator").ok).toBe(false);
    const on = enablePolicyRule(db, policy, "cfg-r", "operator");
    expect(on.ok).toBe(true);
    expect(on.disabled).toBe(false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
