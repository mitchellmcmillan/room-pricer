import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuctionEngineState } from './engine.js';
import { applyRuntimeAuctionCommand, buildRuntimeAuctionLogSnapshot, personIdAt, roomIdAt } from './runtime.js';

function createRuntimeAuction() {
    const peopleRecords = [{ id: 1, name: 'Ada', emoji: 'A' }, { id: 2, name: 'Bo', emoji: 'B' }];
    const roomRecords = [
        { id: 10, name: 'Blue', description: 'Front', initialPrice: 100 },
        { id: 20, name: 'Green', description: 'Back', initialPrice: 100 }
    ];
    return {
        peopleRecords,
        roomRecords,
        chosenPeople: [],
        readyPeople: [],
        roomSelections: [[], []],
        roomPrices: [100, 100],
        tickAmount: 5,
        auctionStartTime: null,
        paused: false,
        pauseReason: null,
        auctionCountdownEndTime: null,
        timer: 0,
        allocationLocked: false,
        ended: false,
        engineState: createAuctionEngineState({
            people: peopleRecords,
            rooms: roomRecords,
            tickAmount: 5,
            initialPricesByRoomId: { 10: 100, 20: 100 }
        })
    };
}

test('runtime auction command keeps engine IDs and client indices in sync', () => {
    const auction = createRuntimeAuction();

    assert.equal(personIdAt(auction, 1), 2);
    assert.equal(roomIdAt(auction, 0), 10);

    const claim = applyRuntimeAuctionCommand(auction, { type: 'claim_person', personId: 2 }, 1000);
    assert.equal(claim.ok, true);
    assert.deepEqual(auction.engineState.claimedPersonIds, [2]);
    assert.deepEqual(auction.chosenPeople, [1]);

    const select = applyRuntimeAuctionCommand(auction, { type: 'select_room', personId: 2, roomId: 10 }, 1000);
    assert.equal(select.ok, true);
    assert.deepEqual(auction.engineState.selectedRoomByPersonId, { 2: 10 });
    assert.deepEqual(auction.roomSelections, [[1], []]);

    auction.auctionStartTime = 1000;
    const tick = applyRuntimeAuctionCommand(auction, { type: 'tick' }, 2000);
    assert.equal(tick.ok, true);
    assert.deepEqual(auction.engineState.roomPricesById, { 10: 100, 20: 95 });
    assert.deepEqual(auction.roomPrices, [100, 95]);
    assert.equal(auction.timer, 1);
});

test('runtime log snapshot maps client indices to persisted IDs', () => {
    const auction = {
        ...createRuntimeAuction(),
        auctionDbId: 'auction-db',
        externalId: 'public-key',
        auctionStartTime: 1000,
        timer: 3,
        roomPrices: [105, 95],
        roomSelections: [[0, 99], [1]]
    };

    assert.deepEqual(buildRuntimeAuctionLogSnapshot(auction, '2026-01-01T00:00:00.000Z'), {
        auctionDbId: 'auction-db',
        externalId: 'public-key',
        startedAtMs: 1000,
        tickTime: '2026-01-01T00:00:00.000Z',
        timer: 3,
        rooms: [
            { roomId: 10, price: 105, selectors: [1] },
            { roomId: 20, price: 95, selectors: [2] }
        ]
    });
});
