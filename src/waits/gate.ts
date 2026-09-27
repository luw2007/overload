/**
 * Phase B §14.1 release gate: schema/API landing is not enablement. Wait creation (Web `POST /api/waits`)
 * and the observer (`src/waits/cli.ts observe --once`, run by scripts/maintenance.sh) do nothing unless
 * `OVERLOAD_CONDITION_WAITS` is exactly "1". Unset, empty, or any other value is disabled (default off).
 * Disabled never touches existing rows: reads and cancels stay available, `watching` rows are kept as-is.
 */
export const CONDITION_WAITS_ENV = "OVERLOAD_CONDITION_WAITS";

export function conditionWaitsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[CONDITION_WAITS_ENV] === "1";
}
