import { openControl } from "../control/store";
import { expireStaleHandoffs, getHandoff, listHandoffs } from "../control/handoff";
import type { HandoffState } from "../control/handoff-types";

const USAGE = "Usage: overload handoff list [pending|read|acknowledged|concluded|expired] | show <request_id>";

export function runHandoffCli(args: string[], controlPath?: string): void {
  const [sub, arg, ...extra] = args;
  if (extra.length || (sub !== "list" && sub !== "show") || (sub === "show" && !arg)) { console.error(USAGE); process.exitCode = 2; return; }
  const control = openControl(controlPath);
  try {
    expireStaleHandoffs(control);
    if (sub === "show") {
      const row = getHandoff(control, arg!);
      if (!row) { console.error(`handoff not found: ${arg}`); process.exitCode = 1; return; }
      console.log(JSON.stringify(row, null, 2));
      return;
    }
    const rows = listHandoffs(control, arg as HandoffState | undefined);
    if (!rows.length) console.error("No handoffs.");
    for (const row of rows) console.log(`${row.request_id}\t${row.state}${row.ack_decision ? `/${row.ack_decision}` : ""}\t${row.target_id}\t${row.source_kind}:${row.source_id}\t${row.brief.purpose}`);
  } catch (error) {
    console.error((error as Error).message); process.exitCode = 1;
  } finally { control.close(); }
}
