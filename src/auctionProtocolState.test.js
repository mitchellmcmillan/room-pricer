import assert from "node:assert/strict";
import test from "node:test";

import {
    advanceAuctionProtocolClock,
    applyAuctionProtocolMessage,
    createAuctionProtocolState,
    deriveAuctionProtocolView,
    readyAuctionProtocolPerson,
    selectAuctionProtocolPerson,
    selectAuctionProtocolRoom
} from "./auctionProtocolState.js";

test("auction update applies server state and derives bidder UI flags", () => {
    const state = createAuctionProtocolState({ selectedPerson: 1 });

    const result = applyAuctionProtocolMessage(state, {
        type: "auction_update",
        people: ["Ada", "Bo"],
        roomNames: ["Blue", "Green"],
        roomDescriptions: ["North", "South"],
        tickIntervalMs: 7000,
        tickAmount: 3,
        roomPrices: [10, 20],
        roomSelections: [[0], [1]],
        smoothProgress: 0.4,
        auctionStartTime: null,
        auctionPaused: false,
        timer: 9,
        chosenPeople: [0, 1],
        readyPeople: [0]
    });

    assert.equal(result.blockReconnect, false);
    assert.deepEqual(result.state.people, ["Ada", "Bo"]);
    assert.deepEqual(result.state.roomNames, ["Blue", "Green"]);
    assert.deepEqual(result.state.nextTickChanges, [0, 0]);
    assert.equal(result.state.allocationFound, true);
    assert.equal(result.state.userRoom, 1);

    const view = deriveAuctionProtocolView(result.state);
    assert.equal(view.allRoomsSelected, true);
    assert.equal(view.showReadyButton, true);
    assert.equal(view.showReadyMessage, false);
    assert.equal(view.readyCountLabel, "1/2 bidders ready");
});

test("ready update and countdown messages drive countdown UI", () => {
    const state = createAuctionProtocolState({
        people: ["Ada", "Bo"],
        roomNames: ["Blue", "Green"],
        roomSelections: [[0], [1]],
        selectedPerson: 1
    });

    const readyResult = applyAuctionProtocolMessage(state, {
        type: "ready_update",
        readyPeople: [0, 1],
        chosenPeople: [0, 1],
        auctionCountdownEndTime: 10000
    });
    assert.equal(readyResult.state.ready, true);
    assert.equal(readyResult.state.auctionCountdownEndTime, 10000);

    const countdownResult = applyAuctionProtocolMessage(readyResult.state, {
        type: "auction_countdown",
        countdownEndTime: 12000
    });
    const view = deriveAuctionProtocolView(countdownResult.state, { now: 9200 });
    assert.equal(view.showCountdown, true);
    assert.equal(view.countdownSeconds, 3);
});

test("local bidder selection intents update protocol state", () => {
    const state = createAuctionProtocolState({
        people: ["Ada", "Bo"],
        roomNames: ["Blue", "Green"],
        roomSelections: [[0], [1]],
        readyPeople: [1],
        actionError: "Previous error"
    });

    const selected = selectAuctionProtocolPerson(state, 1);
    assert.equal(selected.selectedPerson, 1);
    assert.equal(selected.userRoom, 1);
    assert.equal(selected.stage, "auction");
    assert.equal(selected.ready, true);
    assert.equal(selectAuctionProtocolPerson(state, 99), state);

    const moved = selectAuctionProtocolRoom(selected, 0);
    assert.equal(moved.userRoom, 0);
    assert.equal(moved.actionError, null);
    assert.equal(selectAuctionProtocolRoom(selected, 99), selected);
});

test("ready view state and optimistic ready intent stay in protocol state", () => {
    const readyPrompt = createAuctionProtocolState({
        people: ["Ada", "Bo"],
        roomNames: ["Blue", "Green"],
        roomSelections: [[0], [1]],
        selectedPerson: 1,
        userRoom: 1
    });
    assert.equal(deriveAuctionProtocolView(readyPrompt).showReadyButton, true);
    assert.equal(deriveAuctionProtocolView({ ...readyPrompt, auctionStarted: true }).showReadyButton, false);

    const readyState = readyAuctionProtocolPerson(readyPrompt);
    assert.equal(readyState.ready, true);
    assert.equal(readyState.selectedPerson, 1);
    assert.equal(readyState.userRoom, 1);
    assert.equal(readyState.auctionStarted, false);
    assert.equal(deriveAuctionProtocolView(readyState).showReadyMessage, true);
    assert.equal(deriveAuctionProtocolView({ ...readyState, auctionStarted: true }).showReadyMessage, false);
});

test("pause and countdown expiry keep existing auction start behaviour", () => {
    const paused = applyAuctionProtocolMessage(createAuctionProtocolState({ ready: true }), {
        type: "auction_paused"
    }).state;

    assert.equal(paused.auctionPaused, true);
    assert.equal(paused.auctionStarted, false);
    assert.equal(paused.auctionCountdownEndTime, null);
    assert.equal(paused.ready, false);
    assert.equal(paused.actionError, null);

    const expired = advanceAuctionProtocolClock(createAuctionProtocolState({
        ready: true,
        auctionCountdownEndTime: 1000
    }), 1000);

    assert.equal(expired.auctionCountdownEndTime, null);
    assert.equal(expired.ready, false);
    assert.equal(expired.auctionStarted, true);
});

test("terminal server messages expose reconnect blocking policy", () => {
    const unknownAuction = applyAuctionProtocolMessage(createAuctionProtocolState(), {
        type: "error",
        message: "Unknown auction"
    });

    assert.equal(unknownAuction.blockReconnect, true);
    assert.equal(unknownAuction.state.actionError, "Unknown auction");

    const ended = applyAuctionProtocolMessage(createAuctionProtocolState({
        selectedPerson: 0,
        stage: "auction"
    }), {
        type: "auction_end"
    });

    assert.equal(ended.state.auctionEnded, true);
    assert.equal(ended.state.selectedPerson, null);
    assert.equal(ended.state.stage, "select");
    assert.equal(deriveAuctionProtocolView(ended.state).showEndedHint, true);
});
