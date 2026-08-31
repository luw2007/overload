# N1 report — Dashboard client: attention-card payload + inline actions

ATTEMPT_ID: n1-a1-5978E581
Base: 5941de0 (state_version 1)
Write path touched: `src/web/static/app.js` only.

## Summary

Implemented F2 (relative wait chip), F3 (impact line), F5 (inline Resume for hung/zombie),
F6 (Inbox close-out, single + bulk), F1 (answer UI: option chips + free-text) entirely
client-side, matching the frozen CSS class names in CONTRACT S6 and the API shapes in
S1–S4. No changes to `src/web/server.ts` or any other file.

## A1 — syntax gate

```
bun -e 'new Function(require("fs").readFileSync("src/web/static/app.js","utf8"))'
```
Passes (verified after every edit pass).

## A2 — manual walkthrough matrix

### F2 — relative wait time (`.age-chip`, `.age-warn` at ≥30min)

Helper: `ageChip(absoluteMs)` computes `Date.now() - absoluteMs`, renders seconds
under a minute, else `分钟`/`小时 分`, adds `.age-warn` when age ≥ 30 min, and keeps
the absolute timestamp in `title`.

Fixture: Now decision card, `created_at` = 46 minutes ago.

```html
<span class="age-chip age-warn" title="2024/1/1 09:14:00">已等待 46 分钟</span>
```

Fixture: same card, `created_at` = 45 seconds ago.

```html
<span class="age-chip" title="2024/1/1 10:00:15">已等待 45 秒</span>
```

Fixture: hung card, `since` = 2h13m ago → same helper reused for "最后进展":

```html
<span class="age-chip age-warn" title="...">已等待 2 小时 13 分</span>
```

### F3 — impact line (`.impact-line`)

Decision card (any `kind`, ask/pending request):
```html
<div class="impact-line">会话挂起等待回答，此期间无进展</div>
```

Hung card, `q5_reason: "turn_hung"`:
```html
<div class="impact-line">回合已停滞，上下文持续占用</div>
```

Hung card, `q5_reason: "dead_connection"`:
```html
<div class="impact-line">连接已断，会话无法继续</div>
```

### F5 — inline Resume

Hung card, `resume_capability: {resumable: true}`:
```html
<div class="decision-card-actions">
  <span class="chip">tty1</span> <button class="btn copy-jump" data-binding="tty1">复制</button><button class="btn primary jump" data-id="s1" data-route="jump-session" data-binding="tty1">打开</button><span class="jump-status" aria-live="polite"></span>
  <button class="btn primary resume-session" data-id="s1">Resume</button><span class="resume-status" aria-live="polite"></span>
</div>
```

Hung card, `resume_capability: {resumable: false, reason: "process_alive"}` (or capability
missing): resume button omitted, chips unchanged (jumpActions only) — matches "when not
resumable, no button (keep current chips)".

Zombie group row (Inbox), same shape reused per row:
```html
<span class="chip"><a href="#" class="drill" data-id="s2">s2</a> · 2024/1/1 08:00:00</span><button class="btn primary resume-session" data-id="s2">Resume</button><span class="resume-status" aria-live="polite"></span>
```

Clicking `.resume-session` reuses the existing `resume()` function (POST
`/api/resume-session/:stable_id`, same "正在恢复…" / "已拉起" / "恢复失败：…" status-text UX
as the Sessions tab — no new code path).

### F6 — Inbox close-out (single + bulk)

Inbox q2 row, checkbox + `.btn.closeout`:
```html
<tr>
  <td><input class="row-select" type="checkbox" data-id="s3" aria-label="选择 s3"></td>
  <td><a href="#" class="drill" data-id="s3">s3</a></td>
  <td>pi</td>
  <td>2024/1/1 08:30:00</td>
  <td><button class="btn closeout" data-id="s3">收尾</button></td>
</tr>
```

Bulk toolbar: `#bulk-closeout` is created at runtime (server.ts's static toolbar in the
forbidden file only ships `#bulk-ack`) and inserted right after `#bulk-ack`. Visibility is
tab-scoped: `#bulk-ack` shows only on Now, `#bulk-closeout` only on Inbox; the shared
`#toolbar`/`#selected-count` continue to work for both tabs. Selecting rows on any tab
clears on tab switch so `ack`/`closeout` never receive the wrong id space (Now selects
`request_uid`, Inbox selects `stable_id`).

```html
<button class="btn primary" id="bulk-closeout">批量收尾</button>
```

Single click → `closeout([id])` → `POST /api/closeout/:stable_id`; success removes the row
from selection state and calls `refresh()` (row disappears from `/api/q2`, reappears in
`/api/archive` per CONTRACT S3). Bulk click → `closeout([...state.selected])`, same flow.
Selection reconciliation in `refresh()` was widened from `q1`-only ids to
`q1 request_uid ∪ q2 stable_id` so a closed-out selection is pruned correctly.

### F1 — answer UI

Card with `options` populated (`row.summary` present, `row.options: ["approve","deny"]`):
```html
<div class="option-chips">
  <button class="opt-answer" data-id="req-1" data-option="approve">approve</button>
  <button class="opt-answer" data-id="req-1" data-option="deny">deny</button>
</div>
<div class="decision-card-actions">
  <input class="answer-text" type="text" placeholder="输入回答" data-id="req-1">
  <button class="btn answer-submit" data-id="req-1">作答</button>
</div>
```

Card with `options: null` but `summary` present (free-text only):
```html
<div class="decision-card-actions">
  <input class="answer-text" type="text" placeholder="输入回答" data-id="req-2">
  <button class="btn answer-submit" data-id="req-2">作答</button>
</div>
```

Card with both `summary: null` and `options: null` (uncaptured legacy row): `answerBlock`
returns `""` — no option chips, no free-text input, only the pre-existing Ack button in
`decision-card-actions` remains (Ack-only kept, per spec).

Click `.opt-answer` → `answer(request_uid, {option: label})`; click `.answer-submit` → reads
the paired `.answer-text` input by `data-id` (via `CSS.escape`) and calls
`answer(request_uid, {text: value})`. Both POST `/api/answer/:request_uid`.

On 200: `state.answered.add(request_uid)` then `refresh()`. On the next render the card's
`answerBlock` short-circuits to:
```html
<div class="decision-card-actions"><span class="answered-note">已作答，等待 agent 续跑</span></div>
```
(Ack button in the outer `decision-card-actions` stays, per "Ack button stays").

On 409: `showError(new Error("请求已不在等待中"))` then `refresh()` (per spec "show 请求已不在等待中 and
refresh" — reuses the existing error banner rather than inventing a second UI surface).
`state.answered` is also pruned in `refresh()` against the live `q1` request_uid set, so a
request that leaves `q1` (acked/resolved/closed elsewhere) doesn't leave a stale "已作答" card
behind if it somehow reappears.

## A3 — new user-visible strings

- `已等待 {n} 秒` / `已等待 {n} 分钟` / `已等待 {h} 小时 {m} 分` (age chip prefix, F2)
- `会话挂起等待回答，此期间无进展` (impact line, ask/pending request)
- `回合已停滞，上下文持续占用` (impact line, `turn_hung`)
- `连接已断，会话无法继续` (impact line, `dead_connection`)
- `会话异常，需人工确认` (impact line fallback for an unrecognized `q5_reason`, defensive only)
- `收尾` (per-row close-out button)
- `批量收尾` (bulk close-out button)
- `输入回答` (answer free-text placeholder)
- `作答` (answer submit button)
- `已作答，等待 agent 续跑` (answered-note)
- `请求已不在等待中` (409 answer error)

## Notes / deviations

- `#bulk-closeout` doesn't exist in the static HTML (server.ts, N2's file, forbidden to
  touch) so it's created and inserted next to `#bulk-ack` on first `renderToolbar()` call.
  This stays entirely inside `app.js` and doesn't require any CSS from N2 beyond reusing
  `.btn.primary` and `.hidden`, both already defined.
- Selection is cleared on tab switch (small addition beyond the task list) because Now and
  Inbox now both use the shared `state.selected`/`.row-select` checkbox mechanism but key on
  different id spaces (`request_uid` vs `stable_id`); without the clear, a stale selection
  made on one tab could be bulk-submitted to the wrong endpoint on the other tab.
- No changes to CLI stdout/stderr, no new dependencies, no server/CSS files touched.
