import assert from 'node:assert/strict';
import test from 'node:test';

import { applyAuctionCommand, createAuctionEngineState } from './engine.js';

const roster = {
    people: [{ id: 1 }, { id: 2 }],
    rooms: [{ id: 10 }, { id: 20 }],
    initialPricesByRoomId: { 10: 100, 20: 100 }
};

test('a bidder can claim an available person', () => {
    const state = createAuctionEngineState(roster);
    const result = applyAuctionCommand(state, { type: 'claim_person', personId: 1 }, 1000);

    assert.equal(result.ok, true);
    assert.deepEqual(result.state.claimedPersonIds, [1]);
    assert.deepEqual(result.events, [{ type: 'person_selected', personId: 1 }]);
});

test('a bidder cannot claim an already claimed person', () => {
    const state = createAuctionEngineState(roster);
    const claimed = applyAuctionCommand(state, { type: 'claim_person', personId: 1 }, 1000).state;
    const result = applyAuctionCommand(claimed, { type: 'claim_person', personId: 1 }, 1000);

    assert.deepEqual(result, {
        ok: false,
        error: {
            code: 'person_already_claimed',
            message: 'Person already controlled by another participant.'
        }
    });
});

test('releasing a person removes claim, room selection, and readiness', () => {
    const state = {
        ...createAuctionEngineState(roster),
        claimedPersonIds: [1],
        readyPersonIds: [1],
        selectedRoomByPersonId: { 1: 10 }
    };
    const result = applyAuctionCommand(state, { type: 'release_person', personId: 1 }, 1000);

    assert.equal(result.ok, true);
    assert.deepEqual(result.state.claimedPersonIds, []);
    assert.deepEqual(result.state.readyPersonIds, []);
    assert.deepEqual(result.state.selectedRoomByPersonId, {});
    assert.deepEqual(result.events, [{ type: 'person_deselected', personId: 1 }]);
});

test('disconnect during active auction releases the person and pauses the auction', () => {
    const state = {
        ...createAuctionEngineState(roster),
        claimedPersonIds: [1, 2],
        readyPersonIds: [1, 2],
        selectedRoomByPersonId: { 1: 10, 2: 20 },
        startedAt: 500,
        timer: 3
    };
    const result = applyAuctionCommand(state, { type: 'release_person', personId: 1, reason: 'disconnect' }, 1000);

    assert.equal(result.ok, true);
    assert.equal(result.state.startedAt, null);
    assert.equal(result.state.paused, true);
    assert.equal(result.state.pauseReason, 'bidder_disconnected');
    assert.equal(result.state.timer, 3);
    assert.deepEqual(result.state.claimedPersonIds, [2]);
    assert.deepEqual(result.state.readyPersonIds, []);
    assert.deepEqual(result.state.selectedRoomByPersonId, { 2: 20 });
    assert.deepEqual(result.effects, [{ type: 'cancel_tick' }, { type: 'cancel_countdown' }]);
    assert.deepEqual(result.events, [
        { type: 'person_deselected', personId: 1 },
        { type: 'auction_paused', reason: 'bidder_disconnected' }
    ]);
});

test('a claimed person can select one room', () => {
    const state = {
        ...createAuctionEngineState(roster),
        claimedPersonIds: [1]
    };
    const result = applyAuctionCommand(state, { type: 'select_room', personId: 1, roomId: 10 }, 1000);

    assert.equal(result.ok, true);
    assert.deepEqual(result.state.selectedRoomByPersonId, { 1: 10 });
    assert.deepEqual(result.events, [{ type: 'room_selected', personId: 1, roomId: 10 }]);
});

test('selecting another room moves the claimed person', () => {
    const state = {
        ...createAuctionEngineState(roster),
        claimedPersonIds: [1],
        selectedRoomByPersonId: { 1: 10 }
    };
    const result = applyAuctionCommand(state, { type: 'select_room', personId: 1, roomId: 20 }, 1000);

    assert.equal(result.ok, true);
    assert.deepEqual(result.state.selectedRoomByPersonId, { 1: 20 });
});

test('a person must be claimed before selecting a room', () => {
    const state = createAuctionEngineState(roster);
    const result = applyAuctionCommand(state, { type: 'select_room', personId: 1, roomId: 10 }, 1000);

    assert.deepEqual(result, {
        ok: false,
        error: {
            code: 'person_not_claimed',
            message: 'Person must be claimed before selecting a room.'
        }
    });
});

test('a room selection requires an existing room', () => {
    const state = {
        ...createAuctionEngineState(roster),
        claimedPersonIds: [1]
    };
    const result = applyAuctionCommand(state, { type: 'select_room', personId: 1, roomId: 99 }, 1000);

    assert.deepEqual(result, {
        ok: false,
        error: {
            code: 'unknown_room',
            message: 'Unknown room.'
        }
    });
});

test('all claimed people ready requests countdown', () => {
    const state = {
        ...createAuctionEngineState(roster),
        claimedPersonIds: [1, 2],
        readyPersonIds: [1]
    };
    const result = applyAuctionCommand(state, { type: 'set_ready', personId: 2, ready: true, countdownMs: 5000 }, 1000);

    assert.equal(result.ok, true);
    assert.deepEqual(result.state.readyPersonIds, [1, 2]);
    assert.equal(result.state.countdownEndsAt, 6000);
    assert.deepEqual(result.events, [{ type: 'ready_changed', personId: 2, ready: true }]);
    assert.deepEqual(result.effects, [{ type: 'start_countdown', endsAt: 6000, durationMs: 5000 }]);
});

test('clearing readiness cancels an active countdown', () => {
    const state = {
        ...createAuctionEngineState(roster),
        claimedPersonIds: [1, 2],
        readyPersonIds: [1, 2],
        countdownEndsAt: 6000
    };
    const result = applyAuctionCommand(state, { type: 'set_ready', personId: 1, ready: false }, 2000);

    assert.equal(result.ok, true);
    assert.deepEqual(result.state.readyPersonIds, [2]);
    assert.equal(result.state.countdownEndsAt, null);
    assert.deepEqual(result.effects, [{ type: 'cancel_countdown' }]);
});

test('countdown elapsed starts the auction and schedules ticks', () => {
    const state = {
        ...createAuctionEngineState(roster),
        claimedPersonIds: [1, 2],
        readyPersonIds: [1, 2],
        countdownEndsAt: 6000
    };
    const result = applyAuctionCommand(state, { type: 'countdown_elapsed' }, 6000);

    assert.equal(result.ok, true);
    assert.equal(result.state.startedAt, 6000);
    assert.equal(result.state.countdownEndsAt, null);
    assert.equal(result.state.paused, false);
    assert.deepEqual(result.events, [{ type: 'auction_started' }]);
    assert.deepEqual(result.effects, [{ type: 'schedule_tick' }]);
});

test('manual start starts the auction and schedules ticks', () => {
    const state = createAuctionEngineState(roster);
    const result = applyAuctionCommand(state, { type: 'start' }, 1000);

    assert.equal(result.ok, true);
    assert.equal(result.state.startedAt, 1000);
    assert.deepEqual(result.effects, [{ type: 'schedule_tick' }]);
});

test('manual start fails once auction already started', () => {
    const state = {
        ...createAuctionEngineState(roster),
        startedAt: 1000
    };
    const result = applyAuctionCommand(state, { type: 'start' }, 2000);

    assert.deepEqual(result, {
        ok: false,
        error: {
            code: 'auction_already_started',
            message: 'Auction already started or ended.'
        }
    });
});
