# Forma Agent reliability roadmap

This roadmap is the implementation ledger for the agreed layered Routing, Task Context, and Planning Validation work. A passing phase does not cancel later phases. Update each phase's status, evidence, and unresolved issues after implementation and review; do not silently remove unfinished work.

## P0 — Routing Decision and execution authorization

- **Goal:** Separate user goal, current turn stage, task relation, and permitted effects. Reuse the existing Planning GLM for semantic decisions; keep a deterministic fail-closed image execution gate and a small diverse offline evaluation baseline.
- **Modules:** `backend/routing.mjs`, `backend/task.mjs`, `backend/agent.mjs`, existing Debug Trace, routing tests. Keep the existing project and canvas structures.
- **Dependencies:** Existing GLM Planning call, `job`, selected material IDs, Mock fetcher, existing budget checks. No new model or paid test calls.
- **Acceptance:** Explicit no-image requests never call image tools; ordinary image requests still complete; model decisions and actual tool permissions agree; known failures, scope negation, stage combinations, and ambiguous requests appear in tests; Trace records source, stage, relation, and permissions.
- **Status:** 已完成真实验收（2026-10-10）。Real Trace `902b7855-d119-4262-ab41-ba270153f109` exposed a P0 text-delivery failure: Planning chose `clarify` without a blocking question, Agent saved the brief twice, then returned a promise of future analysis while the task was marked completed. The P0 follow-up requires `clarify` to name its blocking question, routes unsupported clarification to text planning, and checks actual text delivery after `save_brief`. `routing_decision`, `routing_final`, `text_delivery_contract`, and `text_delivery_check` retain the evidence. Mock regression includes analysis, exploratory advice, a real clarification, a design plan, image authorization, no-image requests, and saving a brief before answering. No paid API was called during automated tests.
- **Unresolved:** Without P1-A Context, references such as “按刚才方案” cannot be reliably resolved; new-format decisions referring to an unavailable prior task are held for clarification. The legacy Planning JSON compatibility path still derives stage from its old `mode`; it is marked `source=legacy_plan` in Trace. The minimal text-completion check is intentionally not a semantic or design-quality evaluator and may reject a useful concise response or miss a long but vacuous one. New Routing behavior still needs real-model acceptance after this change.
- **Real text acceptance, 2026-10-10:** Trace `db777541-2a85-4f07-b594-6d329ef7b177` returned a new `decision` (`discuss`, `none`, `read` + `save_draft`), delivered substantive advantages, limitations, and a recommendation, passed `text_delivery_check`, completed without an image call. The GLM fallback `glm-4.6v-flashx` appended `</think>` to its raw final answer; P0 now strips model thought tags only from user-visible final text, while preserving the raw Trace for diagnosis. Syntax and 58/58 Mock tests pass. This real run supports the no-image and answer paths, but the `discuss` stage did not require the stricter `plan` text check, and design quality remains unverified.
- **Image execution acceptance, 2026-10-10:** Trace `80554059-bbf4-4e4a-8b7c-2948bf86d9b3` returned the new Planning `decision` with `execute` / `generate` / `paid_image`, one validated plan item, one authorized `create_image` call, one Seedream request and one successful response, followed by `file_present` and `completed` with 1/1 delivered. There was no `legacy_plan`, routing fallback, repeated tool call, or Seedream retry. GLM's initial `glm-4.6v-flash` requests returned HTTP 429 code 1305; the existing provider fallback to `glm-4.6v-flashx` succeeded. This completes the P0 real acceptance for explicit text-only and explicit image-execution paths; visual fidelity and design quality remain outside P0.

## P1-A — Task Context and multi-turn continuity

- **Goal:** Persist creative tasks, confirmed design revisions, product identity, source materials, hard constraints, and execution state. Restore them when a later turn refers to an earlier task.
- **Modules:** Project persistence and APIs in `server.mjs`; Planning input in `backend/task.mjs`; Agent context in `backend/agent.mjs`; minimal UI state only if needed for disambiguation.
- **Dependencies:** P0 decision contract and task-context input seam; legacy project loading; existing `jobs`, plan revisions, assets, and source IDs.
- **Acceptance:** “按刚才方案生成” receives the confirmed design and correct product reference; multiple candidate tasks trigger clarification; user changes create revisions while completed assets remain; service restart and old projects work.
- **Status:** 已实施，等待真实验收（2026-10-10）。项目 JSON 增量保存 `creativeTasks` 与 `activeCreativeTaskId`；每个任务保存来源素材、产品身份、原始需求约束、草案/已确认修订和交付作品。Planning 输入包含相关任务快照和可见图片，Agent 上下文只取该任务修订与同任务历史。多任务无唯一关联时澄清，用户明确选中素材优先；按序号修改已交付作品可定位原 asset 并在其下追加版本。Debug Trace 记录任务关联、修订、素材来源与状态。Mock 覆盖分析→修订→确认生成→修改第二张、任务切换与歧义、持久化和旧项目兼容；`npm run check && npm test` 为 60/60，通过期间未调用付费 API。
- **Unresolved:** 2026-10-10 真实 Case 1 验证同任务三轮继承、原图传递和 1/1 交付，但暴露用户明确确认后 `confirmedRevisionId` 仍为空、默认 `reference` 的商品图未进入 `productIds`。本轮 P1-A 修复要求 Planning 给出带当前用户原文证据及目标 revision ID 的批准意图，协调器核对后确认此前设计版，再另存执行计划；任务内素材角色可由现有 Planning 对本轮真实素材判断，显式 `product`/`style` 角色优先。62/62 Mock 测试通过，待新版服务的再次真实验收。明确禁止生图的首轮仍走 P0 本地门禁，不额外调用 Planning，因此默认 `reference` 素材的任务内语义角色可能要到后续 Planning 轮次才确定。关键约束完整性属于 P1-B；视觉质量仍未验收。多任务歧义时仍需澄清。
- **Permission follow-up, 2026-10-11:** P1-A now derives `read` / `revise` / `confirm` / `generate` or `edit` capabilities from the existing Routing Decision rather than treating a text reply as a state write. Revision creation, constraint and material binding, confirmation, brief writes, and Agent image/asset tools check the same code-authorized effects. Explicit read-only wording is a local veto on mutations; conflicting model proposals return a clarification without changing Task State. The confirmed-revision direct read remains a conservative optimization, while other phrasings use GLM. `npm run check` and 79/79 Mock tests pass without paid calls. Real-page acceptance is still pending; ambiguous requests without an explicit read-only signal can still depend on GLM semantic accuracy, and this phase does not validate design quality or Planning constraint completeness.

## P1-B — Planning Validation and state transitions

- **Goal:** Check plan completeness against product identity, quantity, composition, and hard constraints before tool execution. Reject or clarify invalid plans; distinguish technical delivery from visual quality.
- **Modules:** Plan parser and validator in `backend/task.mjs`, plan-item state updates, trace, Mock tests.
- **Dependencies:** P1-A's confirmed task revision and constraint provenance; P0 permission contract.
- **Acceptance:** A three-column image is not counted as three images; wrong product, missing hard constraints, or unauthorized execution stop before Seedream; partial results and plan revisions remain recoverable; no claim of visual quality approval.
- **Status:** Not started. Do not implement during P0.
- **Unresolved:** Semantic coverage checks and eventual visual evaluation remain distinct from deterministic validation.

## P2 — Evidence-led extension

- **Goal:** Expand complex task types or optimize routing only when real traces and held-out evaluation identify a recurring gap.
- **Modules:** To be selected from evidence; avoid adding a Router model or multi-agent system by default.
- **Dependencies:** P0–P1-B acceptance results and real user testing.
- **Acceptance:** A proposed extension has a measured baseline, explicit cost/latency impact, and improvement on held-out scenarios without regression in execution safety.
- **Status:** Not started. Do not implement during P0.
- **Unresolved:** Which complex task classes warrant dedicated tools or semantics is intentionally undecided.
