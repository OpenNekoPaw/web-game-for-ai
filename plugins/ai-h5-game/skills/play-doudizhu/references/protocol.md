# Dou Dizhu Agent Protocol

The game service exposes these tools through its remote MCP endpoint. The application is the only source of truth.

## Tools

| Tool | Purpose | Required input |
| --- | --- | --- |
| `list_strategies` | List editable Markdown strategies | None |
| `create_game` | Create a match | Turn timeout is fixed at 60000 ms (1 minute) |
| `create_rematch` | Create an independent match from a completed deal | `sourceGameId` |
| `join_invite` | Consume an Agent invitation and join its game and seat | `inviteToken` or `inviteUrl`, `agentId`; optional `displayName` |
| `join_game` | Claim or reconnect to a seat and lock a strategy snapshot | `gameId`, `seatId`, `agentId`; optional `displayName`, `strategyId` |
| `observe_game` | Read one seat's private observation | `gameId`, `seatId` |
| `start_game` | Mark the controlled seat ready; the third ready seat starts dealing | `gameId`, controlled `seatId` |
| `submit_action` | Submit one action and an optional public decision summary | `gameId`, `seatId`, `seq`, `action` |
| `submit_review` | Submit one structured post-game review | `gameId`, `seatId`, `review` |
| `create_competition` | Create a 3/5/7-round match | `totalRounds`; turn timeout is fixed at 60000 ms |
| `observe_competition` | Read scores and the requesting seat's private match context | `competitionId`, `seatId` |
| `submit_competition_review` | Submit the final multi-round summary | `competitionId`, `seatId`, `review` |

## Observation

- `phase`: `waiting`, `bid`, `play`, or `over`.
- `sourceGameId`: the completed baseline game for a same-deal rematch, otherwise null.
- `seatControllers`: occupied seats and whether each is a player or Agent. Each controller has a stable `id` for reconnection and a public `displayName` for the table and replay.
- `readySeats` and `allReady`: seats whose controllers have confirmed start, independent of merely joining.
- `landlord`: final landlord seat during play; null while bidding is unresolved.
- `firstCaller`: first seat that called landlord in the current deal. Seats that declined before this call are no longer eligible to rob. If an eligible later seat robs, the first caller receives one final counter-rob turn.
- `current`: seat whose turn it is.
- `you`: observed seat.
- `isYourTurn`: whether this seat may act.
- `seq`: optimistic concurrency token required by `submit_action`.
- `allowedActions`: currently accepted action shapes.
- `cardEncoding`: the authoritative rank ordering and suit vocabulary used by the H5 table.
- `hands`: the observed seat has semantic card objects; other seats expose counts with empty `cards`.
- `lastPlay`, `tablePlays`, and `bottom`: public card objects currently visible on the table. `tablePlays` retains the current high play while later seats pass and is replaced only by the next accepted play. Each card binds the stable action `id` to `rank`, `suit`, visible `label`, and numeric `strength`.
- `passCount` and `tablePasses`: consecutive passes after `lastPlay` and their display state. With `lastPlay` present, `passCount=0` means a pass leaves one more seat able to respond; `passCount=1` means the next pass resets the trick and the next seat, which is the current `lastPlay.seatId`, receives the lead.
- `turnDeadlineAt` and `serverNow`: absolute timestamps for remaining turn time.
- The service does not return an Agent-owned local strategy. Keep the Markdown strategy in the Agent runtime. Server-catalog strategy metadata is returned only when explicitly selected.
- `reviewContext`: available after `phase=over`; contains result, final counts, action statistics, this seat's decisions, and the public action timeline.
- `roleContext`: dynamic role and position context. `previousSeat` and `nextSeat` describe turn order relative to this Agent. `farmerPosition` is `landlord_upstream` when this farmer acts immediately before the landlord and `landlord_downstream` when it acts immediately after the landlord. It also contains `landlordSeat`, `teammateSeat`, `landlordUpstreamSeat`, and `landlordDownstreamSeat`. Role-dependent values are `null` until bidding resolves. `upstreamSeat` and `downstreamSeat` are compatibility aliases for `previousSeat` and `nextSeat`; never use those aliases to select a role strategy.

## Actions

```json
{"type":"bid","value":1}
{"type":"play","cards":["3:0"]}
{"type":"pass"}
```

In bidding, `value=1` means call or rob according to `bidStage`; `value=0` means decline. A seat that returns `value=0` during `call` exits landlord competition and is skipped during `rob`. After all still-eligible later seats respond, a changed `landlordCandidate` returns the turn to `firstCaller` for one final counter-rob decision. During play, use card-object semantics to decide and submit only their `id` values. For example, choose `{ "id":"14:0", "rank":"A", "label":"A♠" }` and submit `"14:0"`.
Read [rules.md](rules.md) before selecting cards and [strategy.md](strategy.md) before choosing among legal actions.

An Agent may attach a public decision summary. It is stored in the replay and visible only in the H5 global view or replay:

```json
{
  "summary": "用较小对子争取牌权，保留高牌应对地主",
  "intent": "控制节奏",
  "confidence": 0.72
}
```

- `summary` is required when `decision` is present, maximum 160 characters.
- `intent` is optional, maximum 80 characters.
- `confidence` is optional and ranges from 0 to 1.
- The server calculates `durationMs`; do not submit it.
- Server-catalog strategies add their `id`, `updatedAt`, and content `hash` to accepted decisions. Local strategies are not uploaded, so their metadata is intentionally absent from the server replay.
- Never include hidden chain-of-thought, full prompts, private tool traces, or unsupported hidden-card claims.

## Card IDs

- Observation card: `{ "id":"14:0", "rank":"A", "suit":"spades", "label":"A♠", "strength":14 }`.
- Normal card: `<rank>:<suit>`.
- Ranks `3..15` represent `3..10,J,Q,K,A,2`.
- Suits `0..3` represent spades, hearts, clubs, and diamonds.
- `16:0` is the small joker; `17:0` is the big joker.
- `rank`, `suit`, and `label` are the model-facing semantics. `id` is the action token. `strength` is supplied for comparison and must not be translated back into a face by the Agent.

## Errors

- `stale_state`: observe again and calculate from the new state.
- `not_your_turn`: wait and observe later.
- `seat_occupied`: choose another seat or reconnect with the original `agentId`.
- `illegal_play` or `cards_not_in_hand`: discard the attempted action and decide again from a fresh observation.
- `cannot_pass_first`: play a legal lead instead.
- `invalid_decision`: shorten or correct the optional public decision fields.
- `game_service_unavailable`: start the independent H5 game application.

## Post-game review

After `phase=over`, submit one review:

```json
{
  "assessment": "未能阻止地主通过长顺子快速减牌",
  "problems": ["地主首出八张顺子后，本方缺少针对其剩余牌型的计划"],
  "improvements": ["对手一次减少五张以上时，立即进入残局结构推断"],
  "strategySuggestions": ["在残局规则中增加：对手少于六张时优先阻断连续单牌"]
}
```

The review is saved in replay. It proposes updates to the selected Markdown strategy but never edits the strategy file automatically.

## Multi-round competition

Each round has a new `gameId`; the enclosing `competitionId` owns `rounds`, `scores`, and cumulative settlement. Base scoring is zero-sum: landlord win `+2/-1/-1`, farmer win `-2/+1/+1`. The standard multiplier doubles once for each bomb, rocket, spring, or anti-spring condition. Settlement exposes `baseScore`, `multiplier`, `multiplierReasons`, `bombCount`, `rocketCount`, `spring`, `antiSpring`, and `playsBySeat`; `scoreDelta` already includes the multiplier. Round reviews are for immediate adjustment. The final competition review should only retain recurring problems and validated improvements; it should suggest Markdown edits but never modify the file automatically.

## Same-deal rematch

Call `create_rematch` only with a completed source `gameId`. The new game copies the source's initial hands, bottom cards, and first bidder, but it does not copy controllers, readiness, strategies, decisions, scores, or competition membership. Join the returned `gameId`, select the strategy for each Agent again, and wait for all three seats to call `start_game`. Use `sourceGameId` to group outcomes; model output may remain nondeterministic even when the deal is identical.
