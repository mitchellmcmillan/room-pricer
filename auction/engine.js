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
        roomPricesById: { ...(config.initialPricesByRoomId || {}) },
        selectedRoomByPersonId: {},
        claimedPersonIds: [],
        readyPersonIds: [],
        startedAt: null,
        paused: false,
        pauseReason: null,
        countdownEndsAt: null,
        timer: 0,
        allocationLocked: false
    };
}

export function applyAuctionCommand(state, command, now) {
    switch (command?.type) {
        case 'claim_person':
            return claimPerson(state, command.personId);
        case 'release_person':
            return releasePerson(state, command.personId, command.reason);
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
