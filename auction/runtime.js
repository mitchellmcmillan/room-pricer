import { applyAuctionCommand } from './engine.js';
import { buildClientAuctionSnapshot } from './snapshot.js';

export function personIdAt(auction, personIdx) {
    return auction.peopleRecords[personIdx]?.id;
}

export function roomIdAt(auction, roomIdx) {
    return auction.roomRecords[roomIdx]?.id;
}

export function applyRuntimeAuctionCommand(auction, command, now) {
    syncEngineStateFromRuntime(auction);
    const result = applyAuctionCommand(auction.engineState, command, now);
    if (!result.ok) return result;
    auction.engineState = result.state;
    syncRuntimeFromEngineState(auction);
    return result;
}

export function buildRuntimeAuctionLogSnapshot(auction, tickTime) {
    return {
        auctionDbId: auction.auctionDbId,
        externalId: auction.externalId || auction.id,
        startedAtMs: auction.auctionStartTime,
        tickTime,
        timer: auction.timer,
        rooms: auction.roomSelections.map((indices, idx) => ({
            roomId: auction.roomRecords[idx]?.id,
            price: auction.roomPrices[idx] ?? 0,
            selectors: indices
                .map(personIdx => auction.peopleRecords[personIdx]?.id)
                .filter(personId => personId !== undefined)
        })).filter(room => room.roomId !== undefined)
    };
}

function syncEngineStateFromRuntime(auction) {
    const selectedRoomByPersonId = {};
    auction.roomSelections.forEach((personIndices, roomIdx) => {
        const roomId = roomIdAt(auction, roomIdx);
        if (roomId === undefined) return;
        personIndices.forEach(personIdx => {
            const personId = personIdAt(auction, personIdx);
            if (personId !== undefined) selectedRoomByPersonId[personId] = roomId;
        });
    });
    auction.engineState = {
        ...auction.engineState,
        claimedPersonIds: auction.chosenPeople.map(personIdx => personIdAt(auction, personIdx)).filter(id => id !== undefined),
        readyPersonIds: auction.readyPeople.map(personIdx => personIdAt(auction, personIdx)).filter(id => id !== undefined),
        selectedRoomByPersonId,
        roomPricesById: Object.fromEntries(auction.roomRecords.map((room, idx) => [room.id, auction.roomPrices[idx] ?? 0])),
        tickAmount: auction.tickAmount,
        startedAt: auction.auctionStartTime,
        paused: auction.paused,
        pauseReason: auction.pauseReason,
        countdownEndsAt: auction.auctionCountdownEndTime,
        timer: auction.timer,
        allocationLocked: auction.allocationLocked,
        ended: !!auction.ended
    };
}

function syncRuntimeFromEngineState(auction) {
    const snapshot = buildClientAuctionSnapshot(auction.engineState, {
        peopleRecords: auction.peopleRecords,
        roomRecords: auction.roomRecords
    });
    auction.chosenPeople = snapshot.chosenPeople;
    auction.readyPeople = snapshot.readyPeople;
    auction.roomSelections = snapshot.roomSelections;
    auction.roomPrices = snapshot.roomPrices;
    auction.auctionStartTime = auction.engineState.startedAt;
    auction.paused = auction.engineState.paused;
    auction.pauseReason = auction.engineState.pauseReason;
    auction.auctionCountdownEndTime = auction.engineState.countdownEndsAt;
    auction.timer = auction.engineState.timer;
    auction.allocationLocked = auction.engineState.allocationLocked;
    auction.ended = auction.engineState.ended;
}
