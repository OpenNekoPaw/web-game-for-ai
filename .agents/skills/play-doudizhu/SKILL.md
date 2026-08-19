---
name: play-doudizhu
description: Play one seat in the local Agent Arena Dou Dizhu game through the bundled MCP tools. Use when the user asks an agent to create, rematch, or join a Dou Dizhu game, observe a seat, decide a bid or legal card play, or continue an agent-controlled match. Do not use for changing the game source code or merely explaining Dou Dizhu rules.
---

# Play Dou Dizhu

Control exactly one seat through the game service's remote MCP endpoint. The service remains the authoritative dealer and referee.

## Responsibility Boundary

- Treat the game service as infrastructure only: it deals cards, exposes seat-scoped state, validates actions, advances turns, enforces the fixed deadline, settles scores, and records the match.
- Do all gameplay reasoning in the model. The service does not identify preferred combinations, rank candidate moves, protect hand structure, coordinate farmers, or recommend an action.
- Treat the Agent's own local Markdown strategy as the gameplay policy. The game server MCP does not receive or display that local file. If explicitly using a server-catalog strategy, use the strategy returned by `join_game`.

## Prerequisite

- Require the game service MCP endpoint at `http://127.0.0.1:3000/mcp` unless the user provides another URL.
- If a tool reports `game_service_unavailable`, tell the user to start the application with `npm start` from its repository. Do not attempt to embed or replace the game service.

## Tool Names

- The MCP tools are `list_strategies`, `create_game`, `create_rematch`, `join_invite`, `join_game`, `observe_game`, `start_game`, `submit_action`, `submit_review`, `create_competition`, `observe_competition`, and `submit_competition_review`.
- Some agent hosts namespace MCP tools. If the environment exposes names like `mcp__ddz__create_game` or `mcp__ai-h5-game__create_game`, use the namespaced form exactly as shown by the host; otherwise use the raw names below.

## Start or Join

1. When the user supplies an Agent invitation URL, call `join_invite` with that exact URL, a stable `agentId`, and a concise `displayName`; do not create another game. Otherwise call `create_game` only for a new random game, or `create_rematch` for a completed deal.
2. Keep the Agent's selected local Markdown strategy available to the model. Call `list_strategies` only when explicitly comparing a server-catalog strategy.
3. Choose an unclaimed `seatId` from `0`, `1`, or `2`, unless the user specifies one.
4. For a direct join, call `join_game` once with a stable `agentId` and public `displayName`. Only pass `strategyMode=server` and `strategyId` when explicitly comparing a server-catalog strategy. For an invitation, use the `gameId` and `seatId` returned by `join_invite`.
5. Joining claims the seat but does not make it ready. Call `start_game` once with the controlled `seatId` to mark only that seat ready.
6. While `phase=waiting`, take no bid or play action. The third ready seat starts dealing automatically; continue observing until the phase changes.
7. Give the user the H5 URL in the form `http://localhost:3000/?game=<gameId>&seat=<seatId>` when useful.

## Take a Turn

1. Call `observe_game` immediately before deciding.
2. Submit nothing when `isYourTurn` is false or `phase` is `waiting` or `over`.
3. Select only an action represented by `allowedActions`.
4. During `phase=bid`, use `bidStage` to interpret `value`: `call` means call or decline; `rob` means rob or decline. A seat that already declined during `call` is no longer eligible to rob. If an eligible later seat robs, `firstCaller` may receive one final counter-rob turn before the landlord is fixed.
5. During `phase=play`, use `roleContext` to select the matching section of the locked strategy: `地主策略`, `地主上家策略`, or `地主下家策略`. Use [references/rules.md](references/rules.md) only to interpret legal combinations and [references/strategy.md](references/strategy.md) to understand how the editable strategy relates to this Skill.
6. Interpret the private hand from the semantic card objects in `hands[].cards`. Use each card's `rank`, `label`, and `strength` for reasoning, and retain its `id` only for action submission. Do not re-derive a face from the numeric ID. A rocket requires one `rank=small_joker` and one `rank=big_joker`. These fields are basic card information, not server-provided hand analysis or recommendations.
7. Partition the private hand into one or two non-overlapping legal play routes and count the remaining plays for each. Mark routes that require regaining control; a minimum combination count is not a guaranteed finish by itself.
8. For every candidate response and pass, simulate who acts next from `passCount` and `roleContext.nextSeat`, whether the landlord can interrupt, and how many plays remain. If taking a teammate's play lets this seat finish immediately or through a publicly justified control chain, take it instead of mechanically passing.
9. Submit only `id` values present in the controlled seat's private card objects. Never request a global view or infer exact hidden hands.
10. Submit with the observation's exact `gameId`, `you` as `seatId`, and latest `seq`. Include a concise public decision summary when possible; state the remaining-play conclusion when it materially determines the action, without chain-of-thought, prompts, or private tool traces.
11. On `stale_state`, observe again and make a new decision from the new state instead of resubmitting blindly.
12. Continue only as far as requested. For autonomous play, repeat until `phase=over`, observing immediately before every action.
13. At `phase=over`, use `reviewContext` to submit one evidence-based review. Propose edits to the local or server strategy; never modify a strategy during its active match.

For a multi-round competition, call `create_competition` with 3, 5, or 7 rounds, then use the returned `currentGameId` with the normal join/start/action loop. Submit one `submit_review` after each round; wait for the next `currentGameId` and prepare all seats again. After the final round, use `observe_competition` and submit one `submit_competition_review` with only problems repeated across rounds and improvements supported by the recorded outcomes.

## Operational Constraints

- `turnTimeoutMs` is fixed at 60000 ms. Use `turnDeadlineAt` and `serverNow` to ensure the model submits within the minute.
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
