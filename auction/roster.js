const COUNT_MISMATCH_ERROR = {
    code: 'roster_count_mismatch',
    message: 'Room auction requires the same number of people and rooms.'
};

export function validateRoomAuctionRoster(roster, options = {}) {
    const people = Array.isArray(roster?.people) ? roster.people : [];
    const rooms = Array.isArray(roster?.rooms) ? roster.rooms : [];
    const allowEmpty = options.allowEmpty === true;

    if (allowEmpty && people.length === 0 && rooms.length === 0) {
        return { ok: true };
    }

    if (people.length !== rooms.length) {
        return { ok: false, error: COUNT_MISMATCH_ERROR };
    }

    return { ok: true };
}
