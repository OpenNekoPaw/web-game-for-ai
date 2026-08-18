---
name: play-doudizhu
description: Play one seat in the local Agent Arena Dou Dizhu game through the bundled MCP tools. Use when the user asks Codex to create or join a Dou Dizhu game, observe a seat, decide a bid or legal card play, or continue an agent-controlled match. Do not use for changing the game source code or merely explaining Dou Dizhu rules.
---

# Play Dou Dizhu

Control exactly one seat while the independently running H5 game service remains the authoritative dealer and referee.

## Prerequisite

- Require the local game service at `DDZ_SERVER_URL`, defaulting to `http://127.0.0.1:3000`.
- If a tool reports `game_service_unavailable`, tell the user to start the application with `npm start` from its repository. Do not attempt to embed or replace the game service.

## Start or Join

1. Call `create_game` only when the user wants a new game. Preserve its returned `gameId`.
2. Call `list_strategies` and select the requested Markdown strategy, or use its `defaultStrategyId`.
3. Choose an unclaimed `seatId` from `0`, `1`, or `2`, unless the user specifies one.
4. Call `join_game` once with a stable, descriptive `agentId` and the chosen `strategyId`. Read and follow the returned `strategy.markdown` for this match.
5. Joining claims the seat but does not make it ready. Call `start_game` once with the controlled `seatId` to mark only that seat ready.
6. While `phase=waiting`, take no bid or play action. The third ready seat starts dealing automatically; continue observing until the phase changes.
7. Give the user the H5 URL in the form `http://localhost:3000/?game=<gameId>&seat=<seatId>` when useful.

## Take a Turn

1. Call `observe_game` immediately before deciding.
2. Submit nothing when `isYourTurn` is false or `phase` is `waiting` or `over`.
3. Select only an action represented by `allowedActions`.
4. During `phase=bid`, use `bidStage` to interpret `value`: `call` means call or decline; `rob` means rob or decline.
5. Before deciding during `phase=play`, read [references/rules.md](references/rules.md) for legal combinations and [references/strategy.md](references/strategy.md) for stable role-aware principles. Apply the selected `strategy.markdown` as the user-editable match strategy.
6. During `phase=play`, use only card IDs present in the controlled seat's `hands[].cards`. Never infer hidden cards.
7. Call `submit_action` with the observation's exact `gameId`, `you` as `seatId`, and latest `seq`. Include a concise public `decision` summary when possible: describe the strategic intent and chosen action without exposing hidden chain-of-thought, prompts, or private tool traces.
8. On `stale_state`, observe again and reconsider instead of resubmitting blindly.
9. Continue only as far as requested. For autonomous play, repeat until `phase=over`, while observing before every action.
10. At `phase=over`, use `reviewContext` to identify concrete decision problems. Call `submit_review` once with an assessment, problems, improvements, and proposed edits to the selected Markdown strategy.

For a multi-round competition, call `create_competition` with 3, 5, or 7 rounds, then use the returned `currentGameId` with the normal join/start/action loop. Submit one `submit_review` after each round; wait for the next `currentGameId` and prepare all seats again. After the final round, use `observe_competition` and submit one `submit_competition_review` with only problems repeated across rounds and improvements supported by the recorded outcomes.

## Decision Guidance

- Play to win the match, not merely to make a legal move or empty cards without regard to the opposing side.
- Determine the controlled role from `landlord`: that seat plays alone; the other two seats are farmers on one team.
- Prefer a legal, strategically useful move over an elaborate but uncertain move.
- Compare the candidate against `lastPlay`; do not rely only on `tablePlays`, which is a display of the current table area.
- Respect `turnDeadlineAt`; leave enough time to submit rather than exhaustively analyzing.
- A pass is legal only when the observation offers it. Never pass while leading a trick.
- Treat all tool errors as referee decisions. Re-observe after state-related errors.
- Never request a global view to gain hidden information for a playing agent.
- Keep `decision.summary` factual and brief. State the public rationale for the submitted action, not internal reasoning steps or hidden-card speculation.
- Treat a strategy as editable guidance, not a replacement for game rules. Do not modify strategy files during a match.
- In the post-game review, connect each suggestion to observed actions or statistics. Propose strategy edits but never edit the Markdown automatically.

## Protocol Details

Read [references/protocol.md](references/protocol.md) when action fields, card encoding, phases, or error recovery require more detail.
