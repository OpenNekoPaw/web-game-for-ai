---
name: play-doudizhu
description: Play one seat in the local Agent Arena Dou Dizhu game through the bundled MCP tools. Use when the user asks Codex to create or join a Dou Dizhu game, observe a seat, decide a bid or legal card play, or continue an agent-controlled match. Do not use for changing the game source code or merely explaining Dou Dizhu rules.
---

# Play Dou Dizhu

Control exactly one seat while the independently running H5 game service remains the authoritative dealer and referee.

## Responsibility Boundary

- Treat the game service as infrastructure only: it deals cards, exposes seat-scoped state, validates actions, advances turns, enforces the fixed deadline, settles scores, and records the match.
- Do all gameplay reasoning in the model. The service does not identify preferred combinations, rank candidate moves, protect hand structure, coordinate farmers, or recommend an action.
- Treat the selected `strategy.markdown` snapshot as the gameplay policy for the match. The Skill explains the protocol and state fields; it does not replace or silently override that strategy.

## Prerequisite

- Require the local game service at `DDZ_SERVER_URL`, defaulting to `http://127.0.0.1:3000`.
- If a tool reports `game_service_unavailable`, tell the user to start the application with `npm start` from its repository. Do not attempt to embed or replace the game service.

## Start or Join

1. Call `create_game` only when the user wants a new game. Preserve its returned `gameId`.
2. Call `list_strategies` and select the requested Markdown strategy, or use its `defaultStrategyId`.
3. Choose an unclaimed `seatId` from `0`, `1`, or `2`, unless the user specifies one.
4. Call `join_game` once with a stable `agentId`, a concise public `displayName` identifying this Agent at the table, and the chosen `strategyId`. Read and follow the returned `strategy.markdown` for this match.
5. Joining claims the seat but does not make it ready. Call `start_game` once with the controlled `seatId` to mark only that seat ready.
6. While `phase=waiting`, take no bid or play action. The third ready seat starts dealing automatically; continue observing until the phase changes.
7. Give the user the H5 URL in the form `http://localhost:3000/?game=<gameId>&seat=<seatId>` when useful.

## Take a Turn

1. Call `observe_game` immediately before deciding.
2. Submit nothing when `isYourTurn` is false or `phase` is `waiting` or `over`.
3. Select only an action represented by `allowedActions`.
4. During `phase=bid`, use `bidStage` to interpret `value`: `call` means call or decline; `rob` means rob or decline. If another seat robs, `firstCaller` may receive one final counter-rob turn before the landlord is fixed.
5. During `phase=play`, use `roleContext` to select the matching section of the locked strategy: `地主策略`, `地主上家策略`, or `地主下家策略`. Use [references/rules.md](references/rules.md) only to interpret legal combinations and [references/strategy.md](references/strategy.md) to understand how the editable strategy relates to this Skill.
6. Let the model interpret the raw private hand in `hands[].cards`, `lastPlay`, public history, remaining counts, role fields, scoring signals, and the selected strategy. Do not expect an extra server-provided analysis or recommendation field.
7. Use only card IDs present in the controlled seat's private hand. Never request a global view or infer exact hidden hands.
8. Submit with the observation's exact `gameId`, `you` as `seatId`, and latest `seq`. Include a concise public `decision` summary when possible, without chain-of-thought, prompts, or private tool traces.
9. On `stale_state`, observe again and make a new decision from the new state instead of resubmitting blindly.
10. Continue only as far as requested. For autonomous play, repeat until `phase=over`, observing immediately before every action.
11. At `phase=over`, use `reviewContext` to submit one evidence-based review. Propose edits to the selected strategy; never modify a strategy during its active match.

For a multi-round competition, call `create_competition` with 3, 5, or 7 rounds, then use the returned `currentGameId` with the normal join/start/action loop. Submit one `submit_review` after each round; wait for the next `currentGameId` and prepare all seats again. After the final round, use `observe_competition` and submit one `submit_competition_review` with only problems repeated across rounds and improvements supported by the recorded outcomes.

## Operational Constraints

- `turnTimeoutMs` is fixed at 60000 ms. Use `turnDeadlineAt` and `serverNow` to ensure the model submits within the minute.
- The deadline limits overlong analysis; it must not create a separate fast-decision policy or change the selected strategy near expiry.
- Compare the action with `lastPlay`; `tablePlays` is a display field, not the authoritative comparison target.
- A pass is available only when represented by `allowedActions`; leading a trick requires a play.
- Treat tool errors as referee decisions and re-observe after state-related errors.
- Keep `decision.summary` factual and brief. It records the conclusion, not hidden reasoning.

## Protocol Details

Read [references/protocol.md](references/protocol.md) when action fields, card encoding, phases, or error recovery require more detail.
