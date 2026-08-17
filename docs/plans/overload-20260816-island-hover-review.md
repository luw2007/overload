# N21 adversarial review — N20 Island hover alignment

## 1. Citation fidelity — MAJOR

**CITE-1 (MAJOR): “fixed 740×750 full overlay” is stale/exaggerated.** N20 uses that premise in the design at `docs/plans/overload-20260816-island-web-design.md:78,146-150,174,176`. The cited constants do exist at flux `main/windows/IslandWindow.ts:27-31`, but current flux explicitly says they are maxima: `renderer/src/island/IslandApp.tsx:3-5` says the window keeps width 740 while its height switches at open/close boundaries, and `main/windows/IslandWindow.ts:40,63-67` tracks/applies a requested height. The source therefore supports a fixed **width** and a 750px maximum/initial height, not a permanently fixed 740×750 window. This does not reverse the click-through decision below: flux still has transparent native-window area outside its clipped visible shape, whereas the proposed panel frame equals its visible bounds.

**CITE-2 (MINOR): control-point ordinate is misidentified.** N20 says “`y2 = 1.56`” at `docs/plans/overload-20260816-island-web-design.md:138`. In `cubic-bezier(x1,y1,x2,y2)` and `CAMediaTimingFunction(controlPoints:c1x:c1y:c2x:c2y:)`, the copied tuple `(0.34, 1.56, 0.64, 1)` has **y1 = 1.56** and y2 = 1. The tuple itself is transcribed correctly from flux comments at `renderer/src/island/animations/useIslandAnimation.ts:9` and `renderer/src/island/animations/island.css:6-8`.

All other audited flux citations match the current source:

- delays and cross-cancellation: N20 design `:102-111,166-168` and prototype `src/web/prototype/PROTOTYPE-island.html:10-19,176-203`; flux `renderer/src/island/IslandApp.tsx:53-55,622-626,650-653,657-661,684-689`;
- settings defaults: N20 design `:111,172`; flux `shared/types/Settings.ts:144-154,431-440`;
- max-height constants/slider: N20 design `:78,173`; flux `shared/types/Settings.ts:124-135` and `renderer/src/settings/tabs/GeneralTab.tsx:210-220`;
- actual CSS transition discrepancy: N20 design `:140,171`; flux `renderer/src/island/animations/island.css:87-93`;
- click-through IPC: N20 design `:146,174`; flux `main/windows/IslandWindow.ts:3-9,41-61,139-142`, `shared/ipc.ts:38-39`, and `renderer/src/island/IslandApp.tsx:641-667`;
- icon hover/drag suppression: N20 design `:156,175`; flux `renderer/src/island/IslandPill.tsx:110-120` and `renderer/src/island/IslandApp.tsx:56,711-716`.

## 2. AppKit tracking feasibility — PASS

The proposed options at `docs/plans/overload-20260816-island-web-design.md:84-98` are sufficient for a borderless, nonactivating floating panel. Apple’s *Cocoa Event Handling Guide*, “Tracking-Area Objects,” defines `.activeAlways` as active regardless of application activation and `.inVisibleRect` as making AppKit maintain the area from the view’s visible rectangle. Consequently tracking does not depend on the panel being key/main, and resizing the content view does not require manual reconstruction.

The phrase “`.nonactivatingPanel`, 永远不是 key window” at design `:96` is stronger than needed; the actual guarantee relevant here is that `.activeAlways` does not depend on key-window or active-application state. That wording does not invalidate the selected options. No flux citation is claimed for this AppKit-specific translation.

## 3. Debounce correctness — MAJOR

**TIMER-1 (MAJOR): the Swift pseudologic omits flux’s state guards.** N20 specifies unconditional timer creation in both handlers at `docs/plans/overload-20260816-island-web-design.md:109`: enter cancels close and starts open; exit cancels open and starts close. Flux does not do that. It starts the open timer only while closed (`renderer/src/island/IslandApp.tsx:648-653`) and returns before scheduling close when not open (`:669`). Without equivalent `isExpanded` guards, re-entering an already expanded panel schedules a redundant open, and leaving before the initial 200ms open schedules a redundant close on an already-collapsed panel. With frame animation, those redundant transitions can create resize/exited noise despite the later guards at design `:113-116`.

The core pass-through race is otherwise handled correctly: exit cancels a pending open and enter cancels a pending close, matching flux `IslandApp.tsx:622-626,657-661`. The prototype includes the missing state guards (`src/web/prototype/PROTOTYPE-island.html:187-203`), so the defect is confined to the native implementation contract. The native contract should also require each fired timer to clear its stored reference, as the prototype does at `:190-192,199-201`, before implementation.

## 4. Click-through scoping — PASS

N20 resolves the decision, rather than leaving it open, at `docs/plans/overload-20260816-island-web-design.md:144-152`: do not port `setIgnoreMouseEvents`/forwarding. Flux demonstrably enables whole-window click-through at `main/windows/IslandWindow.ts:139-142`, toggles it through `:41-61`, and defines the renderer/main channels at `shared/ipc.ts:38-39`. Its visible shape is clipped from a 740px-wide transparent native window (`IslandApp.tsx:3-13`; `IslandWindow.ts:27-31`).

A bounds-sized `NSPanel` has no native window outside its frame, so clicks outside the visible panel bounds naturally target the underlying application. The acknowledged rounded-corner slivers at design `:152` are bounded hit-testing polish, not a reason to copy Electron’s whole-window forwarding scheme. CITE-1’s height correction does not alter this conclusion.

## 5. Scope discipline — PASS

`git diff b01208c..1bd3ff0 -- docs/plans/overload-20260816-island-web-design.md` has hunks only in §2.3 (current design `:67-176`); §2.4 and later sections remain outside the diff. The decision remains “glance + copy-jump only, no approval/rejection” at design `:80` and prototype `src/web/prototype/PROTOTYPE-island.html:6`. `git diff --exit-code b01208c..1bd3ff0 -- src/web/prototype/PROTOTYPE-dashboard.html` is empty. N20 changed the Island prototype, not the dashboard.

## 6. Animation curve portability — MINOR

**CURVE-1 (MINOR): portable tuple, overstated spring equivalence.** The call at `docs/plans/overload-20260816-island-web-design.md:124-134` preserves CSS control-point order and duration: CSS and Core Animation both use P1 `(x1,y1)` then P2 `(x2,y2)`, so `(0.34,1.56,0.64,1)` is copyable into `CAMediaTimingFunction`. An ordinate above 1 permits overshoot. The close mapping to `.easeOut`/0.3s is also portable.

However, N20’s “对应 SwiftUI `spring(response: 0.42, dampingFraction: 0.8)` 的手感” at design `:138` should not be read as mathematical equivalence. A cubic Bézier is a single finite easing segment and cannot reproduce a physical spring’s general oscillatory response. Flux only states that mapping in comments (`renderer/src/island/animations/useIslandAnimation.ts:8-10`, `animations/island.css:5-9`), while its effective transition is instead 0.26s `(0.32,0.02,0.2,1)` / 0.24s ease-out (`island.css:87-93`), which N20 correctly discloses at design `:140`. Also correct CITE-2’s y1/y2 label.

OBJECT (CITE-1, TIMER-1, CITE-2, CURVE-1)
