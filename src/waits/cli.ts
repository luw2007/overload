import { homedir } from "node:os";
import { join } from "node:path";
import { conditionWaitsEnabled } from "./gate";
import { createChildProcessRegistry, ObserveWaitsFailure, observeDueWaits } from "./runner";
import { createCheckResultAdapter } from "./sources/check-result";
import { createGithubPrAdapter } from "./sources/github-pr";
import { createWorkCompleteAdapter } from "./sources/work-complete";

/**
 * The round's hard deadline. maintenance.sh TERMs the observer group at 4s and KILLs it at 5s, so the runner
 * stops claiming at 3s and keeps a full second for child TERM/KILL reaping and DB close before that TERM.
 */
const RUN_BUDGET_MS = 3000;

/**
 * `observe --once`: exactly one bounded round, one JSON line on stdout, non-zero exit on runner-level failure.
 * With the §14.1 gate off (OVERLOAD_CONDITION_WAITS != "1") it opens no database and runs no adapter: it prints
 * `{"status":"disabled"}` and exits 0, so existing `watching` rows are left untouched until re-enabled.
 */
async function main(argv: string[]): Promise<number> {
  if (argv.length !== 2 || argv[0] !== "observe" || argv[1] !== "--once") {
    console.error("usage: bun run src/waits/cli.ts observe --once");
    return 2;
  }
  if (!conditionWaitsEnabled()) {
    console.log(JSON.stringify({ status: "disabled", reason: "OVERLOAD_CONDITION_WAITS is not 1" }));
    return 0;
  }
  const home = join(homedir(), ".overload");
  const controlPath = process.env.OVERLOAD_ANSWERS_PATH ?? join(home, "orchestrator-answers.db");
  const orchestratorPath = process.env.OVERLOAD_ORCHESTRATOR_PATH ?? join(home, "orchestrator.db");
  const children = createChildProcessRegistry();
  try {
    const result = await observeDueWaits({
      controlPath,
      orchestratorPath,
      ledgerPath: process.env.OVERLOAD_LEDGER_PATH ?? join(home, "ledger.db"),
      // Same answers DB as control, as the Web server's openAnswersDb(controlPath); the runner opens its own connection.
      mailboxPath: controlPath,
      adapters: {
        github_pr_merged: createGithubPrAdapter(children.executor),
        check_new_result: createCheckResultAdapter({ orchestratorPath }),
        work_completed: createWorkCompleteAdapter({ controlPath }),
      },
      children,
    }, { runBudgetMs: RUN_BUDGET_MS });
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    if (error instanceof ObserveWaitsFailure) console.log(JSON.stringify(error.result));
    console.error(`wait observer: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Exit explicitly: a pipe held open by an aborted child's descendant must not keep the round alive.
if (import.meta.main) process.exit(await main(process.argv.slice(2)));
