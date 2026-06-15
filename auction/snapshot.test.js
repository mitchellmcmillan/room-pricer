import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuctionEngineState } from './engine.js';
import { buildClientAuctionSnapshot } from './snapshot.js';

test('client auction snapshot maps engine IDs to existing client indices', () => {
    const peopleRecords = [{ id: 1, name: 'Ada', emoji: 'A' }, { id: 2, name: 'Ben', emoji: 'B' }];
    const roomRecords = [
        { id: 10, name: 'North', description: 'Front room', initialPrice: 100 },
        { id: 20, name: 'South', description: 'Back room', initialPrice: 120 }
    ];
    const state = {
        ...createAuctionEngineState({
            people: peopleRecords,
            rooms: roomRecords,
            initialPricesByRoomId: { 10: 100, 20: 120 }
        }),
        claimedPersonIds: [2],
        readyPersonIds: [2],
        selectedRoomByPersonId: { 2: 20 }
    };

    const snapshot = buildClientAuctionSnapshot(state, { peopleRecords, roomRecords });

    assert.deepEqual(snapshot.chosenPeople, [1]);
    assert.deepEqual(snapshot.readyPeople, [1]);
    assert.deepEqual(snapshot.roomPrices, [100, 120]);
    assert.deepEqual(snapshot.roomSelections, [[], [1]]);
});
