export function createSqliteAuctionPersistence(database, options = {}) {
    const tickIntervalMs = options.tickIntervalMs ?? 10000;
    const tickAmount = options.tickAmount ?? 1;

    function initialize() {
        database.pragma('foreign_keys = ON');
        database.pragma('journal_mode = WAL');
        database.exec(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS people (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                emoji TEXT NOT NULL,
                personOrder INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS rooms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                initialPrice INTEGER NOT NULL,
                roomOrder INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS auctions (
                id TEXT PRIMARY KEY,
                externalId TEXT,
                startedAt TEXT NOT NULL
            );
        `);
        ensureAuctionSchema(database);
        ensureTickSchema(database);
        seedDefaults(database, { tickIntervalMs, tickAmount });
    }

    function saveRoster(roster) {
        const incomingPeople = Array.isArray(roster?.people) ? roster.people : [];
        const incomingRooms = Array.isArray(roster?.rooms) ? roster.rooms : [];
        const tx = database.transaction(() => {
            database.exec(`
                DELETE FROM tick_room_people;
                DELETE FROM tick_room_states;
                DELETE FROM tick_logs;
                DELETE FROM auctions;
                DELETE FROM people;
                DELETE FROM rooms;
            `);
            const insertPerson = database.prepare('INSERT INTO people (name, emoji, personOrder) VALUES (?, ?, ?)');
            incomingPeople.forEach((person, idx) => insertPerson.run(person.name || '', person.emoji || '', idx));
            const insertRoom = database.prepare('INSERT INTO rooms (name, description, initialPrice, roomOrder) VALUES (?, ?, ?, ?)');
            incomingRooms.forEach((room, idx) => insertRoom.run(room.name || '', room.description || '', Number(room.initialPrice) || 0, idx));
        });
        tx();
    }

    function readRoster() {
        const people = database.prepare('SELECT id, name, emoji FROM people ORDER BY personOrder ASC').all();
        const rooms = database.prepare('SELECT id, name, description, initialPrice FROM rooms ORDER BY roomOrder ASC').all();
        const tickIntervalRow = database.prepare('SELECT value FROM settings WHERE key = ?').get('tickIntervalMs');
        const tickAmountRow = database.prepare('SELECT value FROM settings WHERE key = ?').get('tickAmount');
        return { people, rooms, tickIntervalMs: Number(tickIntervalRow?.value), tickAmount: Number(tickAmountRow?.value) };
    }

    function ensureAuctionRecord({ auctionDbId, externalId, startedAtMs }) {
        const dbId = auctionDbId || externalId;
        const startedAtIso = startedAtMs ? new Date(startedAtMs).toISOString() : new Date().toISOString();
        database.prepare('INSERT OR IGNORE INTO auctions (id, externalId, startedAt) VALUES (?, ?, ?)').run(dbId, externalId, startedAtIso);
        database.prepare('UPDATE auctions SET externalId = ? WHERE id = ?').run(externalId, dbId);
        return dbId;
    }

    function appendLogSnapshot(snapshot) {
        const auctionDbId = ensureAuctionRecord(snapshot);
        const insertTick = database.prepare(`
            INSERT INTO tick_logs (auctionId, tickTime, timer)
            VALUES (@auctionId, @tickTime, @timer)
        `);
        const insertRoomState = database.prepare(`
            INSERT INTO tick_room_states (tickId, roomId, price)
            VALUES (@tickId, @roomId, @price)
        `);
        const insertRoomPerson = database.prepare(`
            INSERT INTO tick_room_people (tickRoomStateId, personId)
            VALUES (@tickRoomStateId, @personId)
        `);
        const tx = database.transaction(() => {
            const tickResult = insertTick.run({
                auctionId: auctionDbId,
                tickTime: snapshot.tickTime || new Date().toISOString(),
                timer: snapshot.timer
            });
            const tickId = tickResult.lastInsertRowid;
            (snapshot.rooms || []).forEach(room => {
                const stateResult = insertRoomState.run({ tickId, roomId: room.roomId, price: room.price ?? 0 });
                const tickRoomStateId = stateResult.lastInsertRowid;
                (room.selectors || []).forEach(personId => insertRoomPerson.run({ tickRoomStateId, personId }));
            });
        });
        tx();
    }

    function resolveAuctionDbId(requestedId) {
        const row = database.prepare('SELECT id, externalId FROM auctions WHERE id = ? OR externalId = ? LIMIT 1').get(requestedId, requestedId);
        return row ? { auctionDbId: row.id, externalId: row.externalId || requestedId } : null;
    }

    function readAuctionLog(auctionDbId, externalId) {
        return readAuctionLogFromDatabase(database, auctionDbId, externalId);
    }

    return { initialize, saveRoster, readRoster, ensureAuctionRecord, appendLogSnapshot, resolveAuctionDbId, readAuctionLog };
}

export function ensureTickSchema(database) {
    const info = database.prepare('PRAGMA table_info(tick_logs)').all();
    const hasJsonCols = info.some(col => col.name === 'prices' || col.name === 'selections');
    const desiredColumns = ['id', 'auctionId', 'tickTime', 'timer'];
    const schemaMismatch = info.length > 0 && (
        info.some(col => !desiredColumns.includes(col.name)) ||
        desiredColumns.some(col => !info.some(c => c.name === col))
    );
    if (info.length === 0 || hasJsonCols || schemaMismatch) {
        database.exec(`
            DROP TABLE IF EXISTS tick_room_people;
            DROP TABLE IF EXISTS tick_room_states;
            DROP TABLE IF EXISTS tick_logs;
            DROP INDEX IF EXISTS idx_tick_logs_auction;
            DROP INDEX IF EXISTS idx_tick_room_states_tick;
            DROP INDEX IF EXISTS idx_tick_room_people_state;
        `);
    }
    database.exec(`
        CREATE TABLE IF NOT EXISTS tick_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            auctionId TEXT NOT NULL,
            tickTime TEXT NOT NULL,
            timer INTEGER,
            FOREIGN KEY (auctionId) REFERENCES auctions(id)
        );
        CREATE TABLE IF NOT EXISTS tick_room_states (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tickId INTEGER NOT NULL,
            roomId INTEGER NOT NULL,
            price INTEGER NOT NULL,
            FOREIGN KEY (tickId) REFERENCES tick_logs(id),
            FOREIGN KEY (roomId) REFERENCES rooms(id)
        );
        CREATE TABLE IF NOT EXISTS tick_room_people (
            tickRoomStateId INTEGER NOT NULL,
            personId INTEGER NOT NULL,
            FOREIGN KEY (tickRoomStateId) REFERENCES tick_room_states(id),
            FOREIGN KEY (personId) REFERENCES people(id)
        );
        CREATE INDEX IF NOT EXISTS idx_tick_logs_auction ON tick_logs(auctionId);
        CREATE INDEX IF NOT EXISTS idx_tick_room_states_tick ON tick_room_states(tickId);
        CREATE INDEX IF NOT EXISTS idx_tick_room_people_state ON tick_room_people(tickRoomStateId);
    `);
}

export function ensureAuctionSchema(database) {
    const info = database.prepare('PRAGMA table_info(auctions)').all();
    const hasExternalId = info.some(col => col.name === 'externalId');
    if (!hasExternalId) {
        database.exec('ALTER TABLE auctions ADD COLUMN externalId TEXT;');
    }
    database.exec('UPDATE auctions SET externalId = id WHERE externalId IS NULL;');
    database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_auctions_external_id ON auctions(externalId);');
}

export function seedDefaults(database, defaults) {
    const settings = database.prepare('SELECT key, value FROM settings').all().reduce((acc, row) => {
        acc[row.key] = row.value;
        return acc;
    }, {});
    if (!settings.tickIntervalMs) {
        database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('tickIntervalMs', String(defaults.tickIntervalMs));
    }
    if (!settings.tickAmount) {
        database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('tickAmount', String(defaults.tickAmount));
    }
}

export function readAuctionLogFromDatabase(database, auctionDbId, externalId) {
    const peopleRows = database.prepare('SELECT id, name, emoji FROM people ORDER BY personOrder ASC').all();
    const roomRows = database.prepare('SELECT id, name, description, initialPrice FROM rooms ORDER BY roomOrder ASC').all();
    const tickRows = database.prepare('SELECT id, tickTime, timer FROM tick_logs WHERE auctionId = ? ORDER BY id ASC').all(auctionDbId);
    if (tickRows.length === 0) {
        return {
            auctionId: externalId || auctionDbId,
            auctionDbId,
            auctionExternalId: externalId || null,
            rooms: roomRows,
            people: peopleRows,
            ticks: []
        };
    }
    const tickIds = tickRows.map(t => t.id);
    const roomStateRows = database.prepare(`SELECT id, tickId, roomId, price FROM tick_room_states WHERE tickId IN (${tickIds.map(() => '?').join(',')})`).all(...tickIds);
    const stateIds = roomStateRows.map(row => row.id);
    const roomPeopleRows = stateIds.length
        ? database.prepare(`SELECT tickRoomStateId, personId FROM tick_room_people WHERE tickRoomStateId IN (${stateIds.map(() => '?').join(',')})`).all(...stateIds)
        : [];
    const peopleByState = new Map();
    roomPeopleRows.forEach(row => {
        if (!peopleByState.has(row.tickRoomStateId)) peopleByState.set(row.tickRoomStateId, []);
        peopleByState.get(row.tickRoomStateId).push(row.personId);
    });
    const statesByTick = new Map();
    roomStateRows.forEach(row => {
        const selectors = peopleByState.get(row.id) || [];
        const state = { roomId: row.roomId, price: row.price, selectors };
        if (!statesByTick.has(row.tickId)) statesByTick.set(row.tickId, []);
        statesByTick.get(row.tickId).push(state);
    });
    return {
        auctionId: externalId || auctionDbId,
        auctionDbId,
        auctionExternalId: externalId || null,
        rooms: roomRows,
        people: peopleRows,
        ticks: tickRows.map(tick => ({
            tickId: tick.id,
            tickTime: tick.tickTime,
            timer: tick.timer,
            rooms: statesByTick.get(tick.id) || []
        }))
    };
}

export function buildLogCsv(logData) {
    const personLookup = new Map(logData.people.map(person => [person.id, person]));
    const header = ['tickTime', 'timer'];
    logData.rooms.forEach(room => header.push(`${room.name}Price`));
    logData.rooms.forEach(room => header.push(`${room.name}Selectors`));
    const lines = [header.join(',')];
    logData.ticks.forEach(tick => {
        const prices = [];
        const selectors = [];
        logData.rooms.forEach(room => {
            const state = (tick.rooms || []).find(entry => entry.roomId === room.id);
            prices.push(state ? state.price : '');
            const selectorText = state
                ? (state.selectors || []).map(personId => personLookup.get(personId)?.emoji || personLookup.get(personId)?.name || personId).join(';')
                : '';
            selectors.push(`"${selectorText}"`);
        });
        lines.push([tick.tickTime, tick.timer ?? '', ...prices, ...selectors].join(','));
    });
    return lines.join('\n');
}
