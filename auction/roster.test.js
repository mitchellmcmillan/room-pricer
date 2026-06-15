import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRoomAuctionRoster } from './roster.js';

test('room auction roster accepts one person per room', () => {
    const result = validateRoomAuctionRoster({
        people: [{ name: 'Ada', emoji: 'A' }, { name: 'Ben', emoji: 'B' }],
        rooms: [{ name: 'North' }, { name: 'South' }]
    });

    assert.equal(result.ok, true);
});

test('room auction roster rejects mismatched person and room counts', () => {
    const result = validateRoomAuctionRoster({
        people: [{ name: 'Ada', emoji: 'A' }, { name: 'Ben', emoji: 'B' }],
        rooms: [{ name: 'North' }]
    });

    assert.deepEqual(result, {
        ok: false,
        error: {
            code: 'roster_count_mismatch',
            message: 'Room auction requires the same number of people and rooms.'
        }
    });
});

test('room auction roster allows empty startup state', () => {
    const result = validateRoomAuctionRoster({ people: [], rooms: [] }, { allowEmpty: true });

    assert.equal(result.ok, true);
});
