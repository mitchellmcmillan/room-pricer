function findIndexById(records, id) {
    return records.findIndex(record => String(record.id) === String(id));
}

export function buildClientAuctionSnapshot(state, metadata) {
    const peopleRecords = Array.isArray(metadata?.peopleRecords) ? metadata.peopleRecords : [];
    const roomRecords = Array.isArray(metadata?.roomRecords) ? metadata.roomRecords : [];
    const roomSelections = roomRecords.map(() => []);

    Object.entries(state.selectedRoomByPersonId).forEach(([personId, roomId]) => {
        const personIdx = findIndexById(peopleRecords, personId);
        const roomIdx = findIndexById(roomRecords, roomId);
        if (personIdx >= 0 && roomIdx >= 0) {
            roomSelections[roomIdx].push(personIdx);
        }
    });

    return {
        chosenPeople: state.claimedPersonIds
            .map(personId => findIndexById(peopleRecords, personId))
            .filter(personIdx => personIdx >= 0),
        readyPeople: state.readyPersonIds
            .map(personId => findIndexById(peopleRecords, personId))
            .filter(personIdx => personIdx >= 0),
        roomPrices: roomRecords.map(room => state.roomPricesById[room.id] ?? 0),
        roomSelections
    };
}
