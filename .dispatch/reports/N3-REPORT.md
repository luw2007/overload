# N3 Report — ATTEMPT_ID n3-a1-750C57E4

## Result

Implemented the extension-side decision answer round trip within the assigned
write paths.

## Runtime evidence

- Earendil Pi `ToolCallEvent` documentation says the pre-execution event "Can
  block" and supports mutable input only; it cannot inject a tool result.
- OMP `ToolCallEventResult` exposes `block`, `reason`, and replacement `input`,
  likewise no result injection.
- Both runtime loaders expose `registerTool`; their registries apply extension
  tools after built-ins by name, so an extension `ask` definition shadows the
  built-in.
- OMP's native `AskToolDetails` shape uses `selectedOptions` and `customInput`;
  the override emits that compatible shape and uses abortable UI methods.

## Changes

- `src/extension/overload.ts`: registered an `ask` override, polls the exact
  reducer-derived request UID every 2s, atomically races web/TUI answers,
  consumes answer files, maps option/text, cancels timers/dialogs, and lazily
  cleans a losing web file.
- `test/ext-answer.test.ts`: option, text, TUI-wins cleanup, and abort/no-leaked
  poll coverage against the real extension boundary.
- `docs/plans/overload-20260831-decision-answer.md`: protocol, UID, race,
  failures, and runtime requirements.

## Verification

`bun test test/ext-answer.test.ts test/ext-decision-payload.test.ts`

Result: 11 pass, 0 fail, 17 assertions.

`git diff --check` passed.
