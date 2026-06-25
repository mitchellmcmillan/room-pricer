export function createAuctionProtocolState(overrides = {}) {
    return {
        people: [],
        roomNames: [],
        roomDescriptions: [],
        tickIntervalMs: 10000,
        tickAmount: 1,
        stage: "select",
        selectedPerson: null,
        roomPrices: [],
        roomSelections: [],
        timer: 0,
        userRoom: null,
        auctionStartTime: null,
        smoothProgress: 0,
        allocationFound: false,
        nextTickChanges: [],
        actionError: null,
        auctionEnded: false,
        chosenPeople: [],
        ready: false,
        readyPeople: [],
        auctionCountdownEndTime: null,
        auctionPaused: false,
        auctionStarted: false,
        ...overrides
    };
}

export function applyAuctionProtocolMessage(state, message) {
    const data = message || {};
    const hasCountdownField = Object.prototype.hasOwnProperty.call(data, "auctionCountdownEndTime");
    let nextState = state;
    let blockReconnect = false;

    if (data.type === "auction_update") {
        const nextPeople = Array.isArray(data.people) ? data.people : state.people;
        const nextRoomNames = Array.isArray(data.roomNames) ? data.roomNames : state.roomNames;
        const nextSelections = Array.isArray(data.roomSelections) ? data.roomSelections : [];
        const nextTickAmount = typeof data.tickAmount === "number" ? data.tickAmount : state.tickAmount;
        nextState = normalizeSelectedState({
            ...state,
            people: nextPeople,
            roomNames: nextRoomNames,
            roomDescriptions: Array.isArray(data.roomDescriptions) ? data.roomDescriptions : state.roomDescriptions,
            tickIntervalMs: typeof data.tickIntervalMs === "number" ? data.tickIntervalMs : state.tickIntervalMs,
            tickAmount: nextTickAmount,
            readyPeople: Array.isArray(data.readyPeople) ? data.readyPeople : state.readyPeople,
            roomPrices: Array.isArray(data.roomPrices) ? data.roomPrices : state.roomPrices,
            roomSelections: nextSelections,
            smoothProgress: data.smoothProgress,
            auctionStartTime: data.auctionStartTime,
            auctionStarted: !!data.auctionStartTime,
            auctionPaused: !!data.auctionPaused,
            timer: data.timer,
            nextTickChanges: nextSelections.map(arr => (arr.length - 1) * nextTickAmount),
            allocationFound: hasCompleteAllocation(nextSelections, nextPeople.length),
            auctionEnded: false,
            chosenPeople: data.chosenPeople || [],
            auctionCountdownEndTime: hasCountdownField ? data.auctionCountdownEndTime : null
        });
        if (data.auctionPaused) {
            nextState = {
                ...nextState,
                ready: false,
                auctionCountdownEndTime: null,
                actionError: null
            };
        } else if (data.auctionStartTime) {
            nextState = { ...nextState, actionError: null };
        }
    } else if (data.type === "ready_update") {
        nextState = normalizeSelectedState({
            ...state,
            people: Array.isArray(data.people) ? data.people : state.people,
            roomNames: Array.isArray(data.roomNames) ? data.roomNames : state.roomNames,
            roomDescriptions: Array.isArray(data.roomDescriptions) ? data.roomDescriptions : state.roomDescriptions,
            tickIntervalMs: typeof data.tickIntervalMs === "number" ? data.tickIntervalMs : state.tickIntervalMs,
            tickAmount: typeof data.tickAmount === "number" ? data.tickAmount : state.tickAmount,
            readyPeople: data.readyPeople || [],
            chosenPeople: data.chosenPeople || [],
            auctionCountdownEndTime: hasCountdownField ? data.auctionCountdownEndTime : null
        });
    } else if (data.type === "auction_countdown") {
        nextState = {
            ...state,
            auctionCountdownEndTime: data.countdownEndTime
        };
    } else if (data.type === "auction_paused") {
        nextState = {
            ...state,
            auctionPaused: true,
            auctionStarted: false,
            auctionCountdownEndTime: null,
            ready: false,
            actionError: null
        };
    } else if (data.type === "auction_end") {
        nextState = {
            ...state,
            auctionEnded: true,
            actionError: "Auction ended. Join or create a new auction to continue.",
            selectedPerson: null,
            userRoom: null,
            stage: "select"
        };
    } else if (data.type === "error") {
        const actionError = data.message || "Server rejected your action.";
        nextState = { ...state, actionError };
        const lowerMessage = actionError.toLowerCase();
        if (lowerMessage.includes("ended")) {
            nextState = { ...nextState, stage: "select" };
        }
        blockReconnect = shouldBlockReconnectForError(actionError);
    }

    return { state: nextState, blockReconnect };
}

export function applyAuctionProtocolSocketError(state) {
    return {
        ...state,
        selectedPerson: null,
        userRoom: null,
        stage: "select"
    };
}

export function selectAuctionProtocolPerson(state, personIdx) {
    if (personIdx < 0 || personIdx >= state.people.length) return state;
    const roomIdx = state.roomSelections.findIndex(selection => selection.includes(personIdx));
    return {
        ...state,
        selectedPerson: personIdx,
        userRoom: roomIdx >= 0 ? roomIdx : null,
        stage: "auction",
        ready: state.readyPeople.includes(personIdx)
    };
}

export function selectAuctionProtocolRoom(state, roomIdx) {
    if (roomIdx < 0 || roomIdx >= state.roomNames.length) return state;
    return {
        ...state,
        userRoom: roomIdx,
        actionError: null
    };
}

export function advanceAuctionProtocolClock(state, now = Date.now()) {
    if (!state.auctionCountdownEndTime) return state;
    if (state.auctionCountdownEndTime > now) return state;
    return {
        ...state,
        auctionCountdownEndTime: null,
        ready: false,
        auctionStarted: true
    };
}

export function deriveAuctionProtocolView(state, options = {}) {
    const now = options.now ?? Date.now();
    const totalPeople = state.people.length;
    const allRoomsSelected = totalPeople > 0 && state.roomSelections.flat().length === totalPeople;
    const showReadyButton = allRoomsSelected &&
        state.selectedPerson !== null &&
        state.userRoom !== null &&
        !state.ready &&
        !state.auctionCountdownEndTime;
    const showCountdown = !!state.auctionCountdownEndTime;
    const countdownSeconds = showCountdown
        ? Math.max(0, Math.ceil((state.auctionCountdownEndTime - now) / 1000))
        : 0;
    const lowerActionError = (state.actionError || "").toLowerCase();

    return {
        totalPeople,
        allRoomsSelected,
        showReadyButton,
        showCountdown,
        countdownSeconds,
        readyCountLabel: `${state.readyPeople.length}/${totalPeople || "?"} bidders ready`,
        showAuctionIdHint: lowerActionError.includes("unknown auction"),
        showEndedHint: lowerActionError.includes("ended"),
        showOwnershipHint: lowerActionError.includes("person already controlled") ||
            lowerActionError.includes("only move the person you control"),
        showFullHint: lowerActionError.includes("auction is full")
    };
}

function normalizeSelectedState(state) {
    const selectedPerson = state.selectedPerson !== null &&
        (state.selectedPerson < 0 || state.selectedPerson >= state.people.length)
        ? null
        : state.selectedPerson;
    const userRoom = selectedPerson === null
        ? null
        : findUserRoom(state.roomSelections, selectedPerson, state.roomNames.length);
    return {
        ...state,
        selectedPerson,
        userRoom,
        ready: selectedPerson !== null && state.readyPeople.includes(selectedPerson)
    };
}

function hasCompleteAllocation(roomSelections, peopleCount) {
    return roomSelections.length > 0 &&
        roomSelections.every(arr => arr.length === 1) &&
        roomSelections.flat().length === peopleCount;
}

function findUserRoom(roomSelections, selectedPerson, roomCount) {
    const roomIdx = roomSelections.findIndex(selection => selection.includes(selectedPerson));
    return roomIdx >= 0 && roomIdx < roomCount ? roomIdx : null;
}

function shouldBlockReconnectForError(message) {
    const lowerMessage = message.toLowerCase();
    return lowerMessage.includes("unknown auction") ||
        lowerMessage.includes("ended") ||
        lowerMessage.includes("unauthorized") ||
        lowerMessage.includes("auction is full") ||
        lowerMessage.includes("rate limit") ||
        lowerMessage.includes("roster empty") ||
        lowerMessage.includes("no person selected in time");
}
