> **Superseded:** The answer-file protocol described below was replaced by the orchestrator answers mailbox (`~/.overload/orchestrator-answers.db`) to preserve exactly one human→agent answer semantic.

# Decision answer file protocol

The Overload extension overrides the runtime `ask` tool because the host's
`tool_call` hook can only block or replace input; it cannot supply a result.
Registered extension tools take precedence over built-ins with the same name.

For tool call `<id>`, the request UID is exactly the reducer key:
`<stable_id>#<writer_id>#<id>`. The extension emits this ask as
`decision_requested`; the reducer constructs the same UID from the journal row.

The web service writes `${OVERLOAD_ANSWERS_DIR:-~/.overload/answers}/<uid>.json`
with `{request_uid, option, text, answered_at}`. While that ask is pending, the
override polls every two seconds. A valid file is read and unlinked, then mapped
to the native ask result: a matching `option` becomes `selectedOptions`; `text`
becomes `customInput`.

The TUI and file poll race. The first answer wins, aborts the losing path, and
the normal `tool_execution_end` hook emits the sole `decision_resolved` event.
If TUI wins, that hook also lazily removes a concurrently written losing file.
Poll timers are cancelled on resolution or host abort.

Malformed, mismatched, or empty files are removed and ignored. Missing files are
normal polling state. Files for asks that are not pending are never proactively
polled; a later terminal event for that ask performs best-effort cleanup.

Pi and OMP both need: extension `registerTool` precedence over the built-in
`ask`, abortable `ctx.ui.select`/`input`, and the standard ask result shape. A
runtime without those capabilities must not install this override; it needs an
upstream pre-execution result-injection hook instead.
