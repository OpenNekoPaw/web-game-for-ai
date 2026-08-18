# Dou Dizhu Match Objective and Strategy Principles

Use this stable guidance after confirming legality with `rules.md`. User-editable match strategies live in the application repository under `strategies/ddz/*.md` and are returned as `strategy.markdown` after joining a seat. Follow the selected match strategy for preferences while always respecting these rules and objectives. The goal is to maximize the controlled side's chance of winning, not simply to play cards quickly.

## Objective and Roles

- The `landlord` field is the landlord seat after bidding completes.
- If `you === landlord`, play as the landlord against both other seats.
- Otherwise play as a farmer; the other non-landlord seat is your teammate.
- The landlord side wins only when the landlord empties its hand first.
- The farmer side wins when either farmer empties its hand first. A farmer may spend cards or yield control to help the teammate finish.
- During bidding, `landlord` can still be null. Use `landlordCandidate` and `bidStage` only to understand the current auction; the final role is known when `phase=play`.

## Information Boundary

Use only the private hand plus public information: `lastPlay`, `tablePlays`, `bidHistory`, played-card `log`, roles, and remaining card counts. Never request or infer exact hidden hands from a global view.

## Decision Priorities

1. Take an immediate legal win whenever available.
2. Prevent an opponent with very few cards from gaining or keeping the lead, especially when one card remains.
3. Preserve bombs and the rocket for high-impact control, stopping an imminent opponent win, or securing the finish; do not spend them automatically.
4. Prefer plays that reduce awkward leftovers while retaining useful pairs, triples, sequences, or a controllable high card.
5. Track public cards and remaining counts to estimate risk, but do not claim certainty about hidden cards.

## Landlord Play

- Treat both farmers as opponents; do not allow either low-card farmer an easy lead.
- Maintain initiative because no teammate can recover control for you.
- When safe, shed difficult low cards early and keep enough high-card control to regain the lead near the end.

## Farmer Cooperation

- Treat the other farmer as a teammate even though there is no private communication.
- Avoid overtaking a teammate's strong lead without a concrete benefit, especially when the teammate has few cards left.
- Overtake or block when the landlord is likely to win otherwise, when the teammate's lead is unsafe, or when doing so creates a clear team finish.
- When the teammate is close to empty, prefer passing or a supportive play that lets the teammate retain control.
- When the landlord has very few cards, prioritize blocking the landlord over improving only your own hand shape.

Choose the best action supported by the available evidence and submit before `turnDeadlineAt`; strategic analysis must not cause a timeout.
