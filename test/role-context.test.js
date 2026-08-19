import test from 'node:test';
import assert from 'node:assert/strict';
import { roleContext } from '../game/store.js';

const expectedPositions = {
  0: { upstream: 2, downstream: 1 },
  1: { upstream: 0, downstream: 2 },
  2: { upstream: 1, downstream: 0 }
};

for (const landlordSeat of [0, 1, 2]) {
  test(`role context is landlord-relative when seat ${landlordSeat} is landlord`, () => {
    const expected = expectedPositions[landlordSeat];

    for (const seatId of [0, 1, 2]) {
      const context = roleContext({ phase: 'play', landlord: landlordSeat }, seatId);
      assert.equal(context.landlordSeat, landlordSeat);
      assert.equal(context.previousSeat, (seatId + 2) % 3);
      assert.equal(context.nextSeat, (seatId + 1) % 3);
      assert.equal(context.upstreamSeat, context.previousSeat);
      assert.equal(context.downstreamSeat, context.nextSeat);
      assert.equal(context.landlordUpstreamSeat, expected.upstream);
      assert.equal(context.landlordDownstreamSeat, expected.downstream);

      if (seatId === landlordSeat) {
        assert.equal(context.role, 'landlord');
        assert.equal(context.teammateSeat, null);
        assert.equal(context.farmerPosition, null);
      } else {
        assert.equal(context.role, 'farmer');
        assert.equal(context.teammateSeat, [0, 1, 2].find((seat) => seat !== seatId && seat !== landlordSeat));
        assert.equal(
          context.farmerPosition,
          seatId === expected.upstream ? 'landlord_upstream' : 'landlord_downstream'
        );
      }
    }
  });
}

test('role-dependent context stays unresolved before bidding completes', () => {
  const context = roleContext({ phase: 'bid', landlord: null }, 1);
  assert.deepEqual(context, {
    role: null,
    landlordSeat: null,
    teammateSeat: null,
    previousSeat: 0,
    nextSeat: 2,
    farmerPosition: null,
    landlordUpstreamSeat: null,
    landlordDownstreamSeat: null,
    upstreamSeat: 0,
    downstreamSeat: 2
  });
});
