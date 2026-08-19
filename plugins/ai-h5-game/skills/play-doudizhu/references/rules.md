# Dou Dizhu Referee Rules

Use these exact MVP rules when choosing `play` or `pass`. The local service is authoritative and intentionally supports fewer combinations than some full Dou Dizhu variants.

## Rank Order

Ranks increase as `3 < 4 < 5 < 6 < 7 < 8 < 9 < 10 < J < Q < K < A < 2 < small joker < big joker`. Suits never affect strength.

## Supported Plays

| Type | Shape | Comparison weight |
| --- | --- | --- |
| Single | One card | Its rank |
| Pair | Two cards of one rank | Pair rank |
| Triple | Three cards of one rank | Triple rank |
| Triple with single | Three of one rank plus one other card | Triple rank |
| Triple with pair | Three of one rank plus a pair of another rank | Triple rank |
| Straight | At least five consecutive single ranks | Highest rank |
| Consecutive pairs | At least three consecutive pairs | Highest pair rank |
| Plane | At least two consecutive triples, without wings | Highest triple rank |
| Bomb | Four cards of one rank | Bomb rank |
| Rocket | Small joker plus big joker | Always highest |

For a straight, consecutive pairs, or plane, every participating rank must have exactly one, two, or three selected cards respectively. Sequences cannot contain `2` or either joker.

## Beating the Previous Play

- When `lastPlay` is null, lead any supported play; passing is illegal.
- A normal play beats only the same type with the same card count and a higher comparison weight.
- A bomb beats every non-bomb normal play. A higher bomb beats a lower bomb.
- A rocket beats every play, including bombs; nothing beats a rocket.
- Pass when no legal or strategically suitable response exists and `pass` appears in `allowedActions`.
- After two consecutive passes, the table resets and the player who made the last non-pass play leads a new trick.

## Unsupported Plays

Do not submit these even if another Dou Dizhu ruleset allows them:

- Plane with single or pair wings.
- Four with two singles or four with two pairs.
- Any other compound combination not listed under Supported Plays.

On `illegal_play`, observe again and choose a combination from this reference instead of repeatedly probing the referee.

## Scoring

- Base scoring is zero-sum: landlord win is `+2/-1/-1`; farmer win is `-2/+1/+1` for landlord/farmer/farmer.
- Each bomb and the rocket doubles the round multiplier.
- Spring means the landlord wins and neither farmer has played a card; anti-spring means the farmers win, the landlord has played at least one card, and at least one farmer has played no cards. Each condition doubles the multiplier.
- The settlement's `scoreDelta` already includes the multiplier. Use `multiplierReasons` to explain the result rather than inferring it from the final score.
