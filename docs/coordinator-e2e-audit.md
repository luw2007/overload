# Coordinator E2E Audit — Integration Gaps

## Tested (offline, fake channel/runtime)

| Area | Coverage | Notes |
|---|---|---|
| Coordinator bind/dispatch/review/deliver/accept/reject | ✅ contract logic | Pure store + bridge |
| AdapterService routing: message→conversation, decision→coordinatorDecision | ✅ fake channel | `ChannelEvent{kind:'decision'}` injected to `accept()` |
| Scope enforcement (ship needs write, scout read-only) | ✅ | |
| Same-repo serial ship+scout | ✅ | By design: child scope ⊆ contract scope |
| Idempotent dispatch | ✅ | |
| Premature deliver guard | ✅ | |
| Contract supersede (409) | ✅ | |
| Auth (no token → 403) | ✅ | |
| Attention card lifecycle (open→resolved, evidence fields) | ✅ | |

## Smoke Gaps (need live integration)

| ID | Gap | Owner | Impact |
|---|---|---|---|
| GAP-SDK | Real Feishu SDK inbound (createLarkChannel, websocket connect, webhook signature verify) | Adapter/Feishu owner | Cannot verify real event parsing or auth |
| GAP-PI-WORKER | Two real pi runtime sessions via `CoordinatorWorkers.start()` with live `AgentRuntime` | Runtime owner | Worker completion simulated via `store.transition()`, not runtime event stream |
| GAP-USER-CALLBACK | Real user card-button click → Feishu `cardAction` webhook → `ChannelEvent{kind:'decision'}` | Adapter/Feishu owner | Fake channel injects decision event directly; real webhook path untested |
| GAP-CARD-UPDATE | Original card `message_id` update via `FeishuChannel.send()`/`updateCard()` after decision | Adapter/Feishu owner | `fakeChannel.send()` records but doesn't verify Feishu API contract |
| GAP-DELIVERY-DEDUP | `channel_deliveries` flush loop idempotency under concurrent ticks | Adapter/Service owner | Single-tick tested only; race condition path untested |

## Known UX Issues (routing integration)

- **Feishu approve spam**: `src/adapters/feishu.ts` ~L80 `card()` adds `confirm` dialog on every button → double-confirm UX. Fix: remove confirm or limit to destructive actions only.
- **Delivery re-send**: tick/delivery loop may re-insert cards if `channel_deliveries` `business_key` dedup is not enforced. Fix: upsert by `business_key`.

## Files

- `src/adapters/coordinator-e2e.test.ts` — 7 tests, 2 describes (integration + contract)
- `scripts/coordinator-acceptance.ts` — 12 gates, JSON report, exit code
- `docs/coordinator-e2e-audit.md` — this file
