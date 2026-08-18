# Dou Dizhu Agent Protocol

The local MCP server adapts seven tools to the application's HTTP `agent-game.v1` protocol. The application is the only source of truth.

## Tools

| Tool | Purpose | Required input |
| --- | --- | --- |
| `list_strategies` | List editable Markdown strategies | None |
| `create_game` | Create a match | Optional `turnTimeoutMs` from 30000 to 60000 |
| `join_game` | Claim or reconnect to a seat and lock a strategy snapshot | `gameId`, `seatId`, `agentId`; optional `strategyId` |
| `observe_game` | Read one seat's private observation | `gameId`, `seatId` |
| `start_game` | Mark the controlled seat ready; the third ready seat starts dealing | `gameId`, controlled `seatId` |
| `submit_action` | Submit one action and an optional public decision summary | `gameId`, `seatId`, `seq`, `action` |
| `submit_review` | Submit one structured post-game review | `gameId`, `seatId`, `review` |
| `create_competition` | Create a 3/5/7-round match | `totalRounds`, `turnTimeoutMs` |
| `observe_competition` | Read scores and the requesting seat's private match context | `competitionId`, `seatId` |
| `submit_competition_review` | Submit the final multi-round summary | `competitionId`, `seatId`, `review` |

## Observation

- `phase`: `waiting`, `bid`, `play`, or `over`.
- `seatControllers`: occupied seats and whether each is a player or Agent.
- `readySeats` and `allReady`: seats whose controllers have confirmed start, independent of merely joining.
- `landlord`: final landlord seat during play; null while bidding is unresolved.
- `current`: seat whose turn it is.
- `you`: observed seat.
- `isYourTurn`: whether this seat may act.
- `seq`: optimistic concurrency token required by `submit_action`.
- `allowedActions`: currently accepted action shapes.
- `hands`: the observed seat has card IDs; other seats expose counts only.
- `lastPlay` and `tablePlays`: public cards currently on the table.
- `turnDeadlineAt` and `serverNow`: absolute timestamps for remaining turn time.
- `strategy`: the selected Markdown strategy snapshot for this seat.
- `reviewContext`: available after `phase=over`; contains result, final counts, action statistics, this seat's decisions, and the public action timeline.

## Actions

```json
{"type":"bid","value":1}
{"type":"play","cards":["3:0"]}
{"type":"pass"}
```

In bidding, `value=1` means call or rob according to `bidStage`; `value=0` means decline. During play, card IDs must come from the private hand.
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
- Never include hidden chain-of-thought, full prompts, private tool traces, or unsupported hidden-card claims.

## Card IDs

- Normal card: `<rank>:<suit>`.
- Ranks `3..15` represent `3..10,J,Q,K,A,2`.
- Suits `0..3` represent spades, hearts, clubs, and diamonds.
- `16:0` is the small joker; `17:0` is the big joker.

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

Each round has a new `gameId`; the enclosing `competitionId` owns `rounds`, `scores`, and cumulative settlement. Fixed scoring is zero-sum: landlord win `+2/-1/-1`, farmer win `-2/+1/+1`. Round reviews are for immediate adjustment. The final competition review should only retain recurring problems and validated improvements; it should suggest Markdown edits but never modify the file automatically.
