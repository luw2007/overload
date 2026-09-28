import { homedir } from "node:os";
import { join } from "node:path";
import { openControl } from "../control/store";
import { buildManagerContext } from "../manager/context";
import { readManagerView } from "../manager/inspect";
import { openLedgerReadonly } from "../manager/routes";
import { listManagerTurns } from "../manager/store";
import { askManager, loadManagerConfig, type RunModel } from "../manager/turn";

const USAGE = 'usage: overload manager ask "<question>" | turns [limit] | context | read <attention|follow_up|works|waits|sessions|done|targets> [cursor]';

export type ManagerCliDeps = { controlPath?: string; ledgerPath?: string; configPath?: string; runModel?: RunModel; out?: (line: string) => void };

export async function runManagerCli(args: string[], deps: ManagerCliDeps = {}): Promise<number> {
  const home = process.env.OVERLOAD_HOME ?? join(homedir(), ".overload");
  const out = deps.out ?? ((line: string) => console.log(line));
  const [command, ...rest] = args;
  const valid = (command === "ask" && rest.length === 1 && !!rest[0]?.trim()) || (command === "turns" && rest.length <= 1) || (command === "context" && rest.length === 0) || (command === "read" && (rest.length === 1 || rest.length === 2));
  if (!valid) { console.error(USAGE); return 2; }
  const control = openControl(deps.controlPath ?? process.env.OVERLOAD_ANSWERS_PATH ?? join(home, "orchestrator-answers.db"));
  const ledger = openLedgerReadonly(deps.ledgerPath ?? process.env.OVERLOAD_LEDGER_PATH ?? join(home, "ledger.db"));
  try {
    if (command === "ask") {
      const turn = await askManager({ control, ledger, config: loadManagerConfig(deps.configPath ?? join(home, "config.json")), runModel: deps.runModel }, { question: rest[0]!, source: "cli" });
      out(turn.answer_markdown ?? "");
      out(JSON.stringify({ turn_id: turn.turn_id, status: turn.status, failure_reason: turn.failure_reason, handoff_receipts: turn.handoff_receipts }));
      return turn.status === "answered" ? 0 : 1;
    }
    if (command === "turns") {
      const limit = rest[0] === undefined ? 20 : Number(rest[0]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) { console.error(USAGE); return 2; }
      for (const turn of listManagerTurns(control, limit)) out(JSON.stringify(turn));
      return 0;
    }
    if (command === "context") { out(JSON.stringify(buildManagerContext(control, ledger), null, 2)); return 0; }
    out(JSON.stringify(readManagerView(control, ledger, { view: rest[0]!, cursor: rest[1] })));
    return 0;
  } finally { ledger?.close(); control.close(); }
}
