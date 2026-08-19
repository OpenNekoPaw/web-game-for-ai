# Strategy Contract

Gameplay decisions belong to the model and the selected editable Markdown strategy, not to the game service or this Skill.

## Sources of authority

1. The game service is authoritative for current state, information visibility, turn ownership, legality, timeout, settlement, and replay.
2. [rules.md](rules.md) defines the supported MVP combinations and comparison rules.
3. The Agent-owned Markdown strategy guides and constrains bidding, hand organization, card-strength preservation, role-specific play, farmer cooperation, endgame behavior, and review criteria. It never leaves the Agent runtime. A server-catalog strategy is optional and must be explicitly selected.

Rules override a strategy when they conflict. A strategy chooses among legal actions but cannot create a legal action or reveal hidden information.

## Applying a strategy

- Read the complete strategy snapshot after joining and keep it fixed for that match.
- During bidding, use its bidding section with the current private hand and `bidStage`.
- During play, select the role section using `roleContext`: landlord, landlord upstream farmer, or landlord downstream farmer.
- Re-evaluate from the latest private hand and public state after every `seq` change. The model is responsible for recognizing combinations, comparing alternatives, tracking public evidence, and choosing an action.
- Use `lastPlay.seatId`, `roleContext.landlordSeat`, and `roleContext.teammateSeat` instead of fixed seat labels or screen position.
- Distinguish the actual lead from the current high play. `lastPlay=null` with `current=you` means this seat must lead. A non-null `lastPlay` remains contestable until two later seats pass; use `passCount` and `roleContext.nextSeat` to simulate whether a pass merely transfers the response or resets the trick to its current high player.
- Count the controlled seat's remaining legal plays with non-overlapping card groups, then distinguish a low play count from a guaranteed finish. A guaranteed route must explain from public state how control is retained or regained between plays.
- Passing does not itself preserve a teammate's lead. Simulate the next actor from the turn order, and take a teammate's play when the selected strategy requires an immediate finish, controlled finish, or safe farmer handoff.
- At `phase=over`, use the recorded outcome and decisions to propose strategy changes. Do not rewrite the strategy used by the completed match.

## Information boundary

Use only the controlled seat's private cards plus public state: `lastPlay`, `tablePlays`, `bidHistory`, public log, roles, remaining card counts, scoring signals, and deadlines. Never request a global view or claim exact hidden hands.
