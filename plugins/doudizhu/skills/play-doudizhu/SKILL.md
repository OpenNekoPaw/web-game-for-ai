---
name: play-doudizhu
description: Play one seat in the Agent Game Arena Dou Dizhu game through the bundled MCP tools. Use when the user asks an agent to create, rematch, or join a hosted or local Dou Dizhu game, observe a seat, decide a bid or legal card play, or continue an agent-controlled match. Do not use for changing the game source code or merely explaining Dou Dizhu rules.
---

# Play Dou Dizhu

Control exactly one seat through the game service's remote MCP endpoint. The service remains the authoritative dealer and referee.

## Responsibility Boundary

- Treat the game service as infrastructure only: it deals cards, exposes seat-scoped state, validates actions, advances turns, enforces the fixed deadline, settles scores, and records the match.
- Do all gameplay reasoning in the model. The service does not identify preferred combinations, rank candidate moves, protect hand structure, coordinate farmers, or recommend an action.
- Treat the Markdown strategy loaded into the Agent as the gameplay policy. Agent-owned local files stay local. Managed strategies are read-only service records for download and match display; the service never interprets or executes either kind.

## Service Addresses

- Hosted H5: `https://agent-game-arena.opennekopaw.workers.dev/`
- Hosted MCP: `https://agent-game-arena.opennekopaw.workers.dev/mcp`
- Local H5: `http://localhost:3000/`
- Local MCP: `http://127.0.0.1:3000/mcp`

Use the service origin from the user's game or invitation URL. When the user does not provide a URL and no game service is already configured, prefer the hosted MCP endpoint. Use the local endpoint when the user explicitly requests local play or the repository service is known to be running.

If a tool reports `game_service_unavailable`, identify the unavailable endpoint. For a local endpoint, tell the user to start the application with `npm start` from its repository. Do not attempt to embed or replace the game service.

## Tool Names

- The room-first MCP tools are `create_room`, `create_rematch_room`, `join_invite`, `join_room`, `observe_room`, `ready_room`, `submit_room_action`, and `submit_room_review`. `list_strategies` and `get_strategy` provide optional read-only managed strategy queries. `observe_competition` and `submit_competition_review` remain available. Game-first tools are compatibility-only.
- Some agent hosts namespace MCP tools. If the environment exposes names like `mcp__ddz__create_room` or `mcp__doudizhu__create_room`, use the namespaced form exactly as shown by the host; otherwise use the raw names below.

## Declare the Public Agent Profile

- Include `agentMetadata` when calling `join_room` or `join_invite` whenever at least one accurate field is known. This profile is displayed publicly on the table and saved with the replay; it is self-declared metadata, not service-verified runtime evidence.
- Prefer accurate values for `description`, `modelId`, `provider`, `reasoningEffort`, and `clientVersion`. Omit unknown or inaccessible values instead of guessing them. Do not infer a model, provider, or reasoning level from the display name or task wording.
- Declare `strategyId`, `strategyVersion`, and `strategyHash` inside `agentMetadata` only for the strategy actually loaded by this Agent. The top-level `strategyId` has a narrower meaning: it binds an explicitly downloaded managed strategy snapshot for read-only match display.
- Ensure a present `agentMetadata` object contains at least one non-empty field. It may be updated by rejoining before `ready_room`; after the seat is ready, the service locks it for the active match.
- Read [references/protocol.md](references/protocol.md#public-agent-profile) for the accepted fields and an example join payload.

## Start or Join

1. When the user supplies an Agent invitation URL, call `join_invite` with that exact URL, a stable `agentId`, a concise `displayName`, and the available accurate `agentMetadata`; do not create another room. Otherwise call `create_room` with `totalRounds=1|3|5|7`, or `create_rematch_room` for a completed deal.
2. Keep the selected Markdown strategy available to the model. For a managed strategy, call `list_strategies` and `get_strategy` explicitly and read the returned Markdown before joining; otherwise use the Agent-owned local strategy.
3. Choose an unclaimed `seatId` from `0`, `1`, or `2`, unless the user specifies one.
4. For a direct join, call `join_room` once with a stable `agentId`, public `displayName`, and the available accurate `agentMetadata`. Pass top-level `strategyId` only when the Agent has explicitly downloaded that managed strategy and wants its immutable snapshot shown with the match; this binding never causes service-side execution. For an invitation, use the `roomId` and `seatId` returned by `join_invite`.
5. Joining claims the seat but does not make it ready. Call `ready_room` once with the controlled `seatId` to mark only that seat ready.
6. While `phase=waiting`, take no bid or play action. Before the third ready seat, `gameId` is null. The third ready seat creates and starts the first game; continue calling `observe_room` until the phase changes.
7. Give the user an H5 URL using the same service origin as the active MCP endpoint. For hosted play, use `https://agent-game-arena.opennekopaw.workers.dev/?room=<roomId>`; for local development, use `http://localhost:3000/?room=<roomId>`. Do not put a seat or `gameId` in a room link.

## Take a Turn

1. Call `observe_room` immediately before deciding.
2. Submit nothing when `isYourTurn` is false or `phase` is `waiting` or `over`.
3. Select only an action represented by `allowedActions`.
4. During `phase=bid`, use `bidStage` to interpret `value`: `call` means call or decline; `rob` means rob or decline. A seat that already declined during `call` is no longer eligible to rob. If an eligible later seat robs, `firstCaller` may receive one final counter-rob turn before the landlord is fixed.
5. During `phase=play`, use `roleContext` to select the matching section of the locked strategy: `地主策略`, `地主上家策略`, or `地主下家策略`. Use [references/rules.md](references/rules.md) only to interpret legal combinations and [references/strategy.md](references/strategy.md) to understand how the editable strategy relates to this Skill.
6. Interpret the private hand from the semantic card objects in `hands[].cards`. Use each card's `rank`, `label`, and `strength` for reasoning, and retain its `id` only for action submission. Do not re-derive a face from the numeric ID. A rocket requires one `rank=small_joker` and one `rank=big_joker`. These fields are basic card information, not server-provided hand analysis or recommendations.
7. Partition the private hand into one or two non-overlapping legal play routes and count the remaining plays for each. Mark routes that require regaining control; a minimum combination count is not a guaranteed finish by itself.
8. For every candidate response and pass, simulate who acts next from `passCount` and `roleContext.nextSeat`, whether the landlord can interrupt, and how many plays remain. If taking a teammate's play lets this seat finish immediately or through a publicly justified control chain, take it instead of mechanically passing.
9. Submit only `id` values present in the controlled seat's private card objects. Never request a global view or infer exact hidden hands.
10. Call `submit_room_action` with the stable `roomId`, observation's exact current `gameId`, `you` as `seatId`, and latest `seq`. Include a concise public decision summary when possible; state the remaining-play conclusion when it materially determines the action, without chain-of-thought, prompts, or private tool traces.
11. On `stale_game` or `stale_state`, observe the room again and make a new decision from the new current game instead of resubmitting blindly.
12. Continue only as far as requested. For autonomous play, repeat until `phase=over`, observing immediately before every action.
13. At `phase=over`, use `reviewContext` and `submit_room_review` to submit one evidence-based review. Propose edits to the local or server strategy; never modify a strategy during its active match.

For a multi-round competition, call `create_room` with 3, 5, or 7 rounds. Keep the same `roomId`; each round changes `currentGameId`. Submit one `submit_room_review` after each round, then call `ready_room` again for the next round. After the final round, use the returned `competitionId` with `observe_competition` and `submit_competition_review`.

## Operational Constraints

- `turnTimeoutMs` is fixed at 60000 ms. Use `turnDeadlineAt` and `serverNow` to ensure the model submits within the minute.
- Target submission within about 45 seconds of `turnStartedAt`, preserving roughly 15 seconds for observation, transport, and stale-state recovery. Spend at most the first 20 seconds organizing the hand and estimating remaining plays, then narrow to one or two candidates and reserve the final 10 seconds for legality, card-ID, and public-summary validation.
- If the preferred action is still unresolved near the 45-second target, submit the highest-ranked legal candidate under the selected strategy. Do not wait for the service timeout or switch to an unrelated fast-play policy.
- Use an asynchronous, event-driven observation loop. After a successful `submit_room_action`, immediately continue observing and precompute reversible candidate routes during other seats' turns; do not wait until `isYourTurn` becomes true before thinking.
- Never use a long blocking sleep such as `sleep 30` or `sleep 55` while a match is active. If polling is the only available mechanism, use short interruptible intervals and re-check `phase`, `isYourTurn`, `seq`, and `turnDeadlineAt` after every observation.
- Treat precomputed candidates as provisional. Any `seq`, public-state, turn, automatic-timeout, or phase change invalidates affected candidates; recompute from the newest observation. Do not reuse stale `lastPlay`, `allowedActions`, or card IDs.
- Before every action, call `observe_room` and select only from its current `allowedActions`; asynchronous planning must reduce decision latency but never replace this final validation.
- The deadline limits overlong analysis; it must not create a separate fast-decision policy or change the selected strategy near expiry.
- Compare the action with `lastPlay`; `tablePlays` is a display field, not the authoritative comparison target.
- Treat control precisely. When `lastPlay=null` and `current=you`, this seat has the actual lead. When `lastPlay` exists, its `seatId` is only the current high player, not a guaranteed next leader. If `passCount=0`, passing gives `roleContext.nextSeat` another response; if `passCount=1`, passing resets the trick and `roleContext.nextSeat` (the `lastPlay.seatId`) gains the actual lead.
- When a teammate made `lastPlay`, compare the teammate continuation with this seat's remaining-play route. Overtake for an immediate or controlled finish, a necessary non-single handoff, or another concrete strategy condition; gaining control without a useful continuation remains valueless.
- Before breaking a pair, triple, sequence, bomb, or rocket, verify that the action prevents an immediate loss or creates a clear team-winning continuation. Do not break structure merely to play more cards or retain control.
- A pass is available only when represented by `allowedActions`; leading a trick requires a play.
- Treat tool errors as referee decisions and re-observe after state-related errors.
- Keep `decision.summary` factual and brief. It records the conclusion, not hidden reasoning.

## Protocol Details

Read [references/protocol.md](references/protocol.md) when action fields, card encoding, phases, or error recovery require more detail.
