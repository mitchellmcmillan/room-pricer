import { validateRoomAuctionRoster } from './roster.js';

function commandError(code, message) {
    return { ok: false, error: { code, message } };
}

function normalizeId(id) {
    return String(id);
}

function withoutId(ids, id) {
    const target = normalizeId(id);
    return ids.filter(existing => normalizeId(existing) !== target);
}

function hasId(ids, id) {
    const target = normalizeId(id);
    return ids.some(existing => normalizeId(existing) === target);
}

export function createAuctionEngineState(config) {
    const people = Array.isArray(config?.people) ? config.people : [];
    const rooms = Array.isArray(config?.rooms) ? config.rooms : [];
    const validation = validateRoomAuctionRoster({ people, rooms });
    if (!validation.ok) {
        throw new Error(validation.error.message);
    }

    return {
        personIds: people.map(person => person.id),
        roomIds: rooms.map(room => room.id),
        tickAmount: Number.isFinite(Number(config.tickAmount)) ? Number(config.tickAmount) : 1,
        roomPricesById: { ...(config.initialPricesByRoomId || {}) },
        selectedRoomByPersonId: {},
        claimedPersonIds: [],
        readyPersonIds: [],
        startedAt: null,
        paused: false,
        pauseReason: null,
        countdownEndsAt: null,
        timer: 0,
        allocationLocked: false,
        ended: false
    };
}

export function applyAuctionCommand(state, command, now) {
    switch (command?.type) {
        case 'claim_person':
            return claimPerson(state, command.personId);
        case 'release_person':
            return releasePerson(state, command.personId, command.reason);
        case 'select_room':
            return selectRoom(state, command.personId, command.roomId);
        case 'set_ready':
            return setReady(state, command.personId, command.ready, command.countdownMs, now);
        case 'countdown_elapsed':
            return countdownElapsed(state, now);
        case 'start':
            return startAuction(state, now);
        case 'tick':
            return tickAuction(state, command.tickAmount);
        case 'end':
            return endAuction(state);
        default:
            return commandError('unknown_command', 'Unknown auction command.');
    }
}

function claimPerson(state, personId) {
    if (!hasId(state.personIds, personId)) {
        return commandError('unknown_person', 'Unknown person.');
    }
    if (hasId(state.claimedPersonIds, personId)) {
        return commandError('person_already_claimed', 'Person already controlled by another participant.');
    }

    return {
        ok: true,
        state: {
            ...state,
            claimedPersonIds: [...state.claimedPersonIds, personId]
        },
        events: [{ type: 'person_selected', personId }],
        effects: []
    };
}

function releasePerson(state, personId, reason) {
    if (!hasId(state.personIds, personId)) {
        return commandError('unknown_person', 'Unknown person.');
    }

    const selectedRoomByPersonId = { ...state.selectedRoomByPersonId };
    delete selectedRoomByPersonId[personId];

    const nextState = {
        ...state,
        claimedPersonIds: withoutId(state.claimedPersonIds, personId),
        readyPersonIds: withoutId(state.readyPersonIds, personId),
        selectedRoomByPersonId
    };
    const events = [{ type: 'person_deselected', personId }];
    const effects = [];

    if (reason === 'disconnect' && state.startedAt !== null) {
        nextState.startedAt = null;
        nextState.paused = true;
        nextState.pauseReason = 'bidder_disconnected';
        nextState.readyPersonIds = [];
        effects.push({ type: 'cancel_tick' }, { type: 'cancel_countdown' });
        events.push({ type: 'auction_paused', reason: 'bidder_disconnected' });
    }

    return { ok: true, state: nextState, events, effects };
}

function selectRoom(state, personId, roomId) {
    if (!hasId(state.personIds, personId)) {
        return commandError('unknown_person', 'Unknown person.');
    }
    if (!hasId(state.roomIds, roomId)) {
        return commandError('unknown_room', 'Unknown room.');
    }
    if (!hasId(state.claimedPersonIds, personId)) {
        return commandError('person_not_claimed', 'Person must be claimed before selecting a room.');
    }

    const nextState = maybeLockAllocation({
        ...state,
        selectedRoomByPersonId: {
            ...state.selectedRoomByPersonId,
            [personId]: roomId
        }
    });
    const events = [{ type: 'room_selected', personId, roomId }];
    if (!state.allocationLocked && nextState.allocationLocked) {
        events.push({ type: 'allocation_locked' });
    }

    return {
        ok: true,
        state: nextState,
        events,
        effects: []
    };
}

function setReady(state, personId, ready, countdownMs = 5000, now) {
    if (!hasId(state.personIds, personId)) {
        return commandError('unknown_person', 'Unknown person.');
    }
    if (!hasId(state.claimedPersonIds, personId)) {
        return commandError('person_not_claimed', 'Person must be claimed before getting ready.');
    }
    if (typeof ready !== 'boolean') {
        return commandError('invalid_ready', 'Ready value must be boolean.');
    }

    const readyPersonIds = ready
        ? [...withoutId(state.readyPersonIds, personId), personId]
        : withoutId(state.readyPersonIds, personId);
    const nextState = { ...state, readyPersonIds };
    const events = [{ type: 'ready_changed', personId, ready }];
    const effects = [];

    if (!ready && state.countdownEndsAt !== null) {
        nextState.countdownEndsAt = null;
        effects.push({ type: 'cancel_countdown' });
    }

    const allClaimed = state.claimedPersonIds.length === state.personIds.length;
    const allReady = readyPersonIds.length === state.personIds.length;
    if (ready && allClaimed && allReady && state.startedAt === null && state.countdownEndsAt === null && !state.allocationLocked) {
        const durationMs = Math.max(1, Math.floor(countdownMs));
        const endsAt = now + durationMs;
        nextState.countdownEndsAt = endsAt;
        effects.push({ type: 'start_countdown', endsAt, durationMs });
    }

    return { ok: true, state: nextState, events, effects };
}

function countdownElapsed(state, now) {
    if (state.countdownEndsAt === null) {
        return commandError('countdown_not_active', 'Countdown is not active.');
    }
    return startAuction({ ...state, countdownEndsAt: null }, now);
}

function startAuction(state, now) {
    if (state.ended) {
        return commandError('auction_already_started', 'Auction already started or ended.');
    }
    if (state.startedAt !== null) {
        return commandError('auction_already_started', 'Auction already started or ended.');
    }
    if (state.allocationLocked) {
        return commandError('allocation_locked', 'Auction cannot be restarted once allocation has been found.');
    }
    const resumingPausedAuction = state.paused === true;
    const nextState = maybeLockAllocation({
        ...state,
        startedAt: now,
        countdownEndsAt: null,
        paused: false,
        pauseReason: null,
        timer: resumingPausedAuction ? state.timer : 0
    });
    const events = [{ type: 'auction_started' }];
    if (!state.allocationLocked && nextState.allocationLocked) {
        events.push({ type: 'allocation_locked' });
    }
    return {
        ok: true,
        state: nextState,
        events,
        effects: [
            ...(state.countdownEndsAt !== null ? [{ type: 'cancel_countdown' }] : []),
            { type: 'schedule_tick' }
        ]
    };
}

function tickAuction(state, tickAmount) {
    if (state.startedAt === null || state.ended) {
        return commandError('auction_not_started', 'Auction not started.');
    }
    const amount = Number.isFinite(Number(tickAmount)) ? Number(tickAmount) : state.tickAmount;
    const roomPricesById = {};
    state.roomIds.forEach(roomId => {
        const selectorCount = Object.values(state.selectedRoomByPersonId)
            .filter(selectedRoomId => normalizeId(selectedRoomId) === normalizeId(roomId))
            .length;
        const currentPrice = Number(state.roomPricesById[roomId] ?? 0);
        roomPricesById[roomId] = Math.round(currentPrice + ((selectorCount - 1) * amount));
    });
    const nextState = maybeLockAllocation({
        ...state,
        roomPricesById,
        timer: state.timer + 1
    });
    const events = [{ type: 'tick_applied' }];
    if (!state.allocationLocked && nextState.allocationLocked) {
        events.push({ type: 'allocation_locked' });
    }
    return { ok: true, state: nextState, events, effects: [] };
}

function endAuction(state) {
    return {
        ok: true,
        state: {
            ...state,
            ended: true,
            startedAt: null,
            countdownEndsAt: null,
            readyPersonIds: []
        },
        events: [{ type: 'auction_ended' }],
        effects: [{ type: 'cancel_tick' }, { type: 'cancel_countdown' }, { type: 'close_connections' }]
    };
}

function maybeLockAllocation(state) {
    if (state.allocationLocked || state.startedAt === null) return state;
    const selectedRoomIds = Object.values(state.selectedRoomByPersonId);
    const allPeopleSelected = state.personIds.every(personId => state.selectedRoomByPersonId[personId] !== undefined);
    const everyRoomSelectedOnce = state.roomIds.every(roomId => (
        selectedRoomIds.filter(selectedRoomId => normalizeId(selectedRoomId) === normalizeId(roomId)).length === 1
    ));
    if (!allPeopleSelected || !everyRoomSelectedOnce) return state;
    return { ...state, allocationLocked: true };
}
