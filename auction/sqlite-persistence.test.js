import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { buildLogCsv, createSqliteAuctionPersistence } from './sqlite-persistence.js';

function createPersistence() {
    const database = new Database(':memory:');
    const persistence = createSqliteAuctionPersistence(database);
    persistence.initialize();
    return persistence;
}

const roster = {
    people: [
        { name: 'Ada', emoji: 'A' },
        { name: 'Ben', emoji: 'B' }
    ],
    rooms: [
        { name: 'North', description: 'Front room', initialPrice: 100 },
        { name: 'South', description: 'Back room', initialPrice: 120 }
    ]
};

test('saved roster is readable in auction order', () => {
    const persistence = createPersistence();
    persistence.saveRoster(roster);

    const result = persistence.readRoster();

    assert.deepEqual(result.people.map(({ name, emoji }) => ({ name, emoji })), roster.people);
    assert.deepEqual(result.rooms.map(({ name, description, initialPrice }) => ({ name, description, initialPrice })), roster.rooms);
});

test('saving a mismatched roster is rejected before persistence', () => {
    const persistence = createPersistence();

    assert.throws(
        () => persistence.saveRoster({
            people: [{ name: 'Ada', emoji: 'A' }, { name: 'Ben', emoji: 'B' }],
            rooms: [{ name: 'North', description: 'Front room', initialPrice: 100 }]
        }),
        /Room auction requires the same number of people and rooms\./
    );
});

test('reading an auction with no snapshots returns roster and empty ticks', () => {
    const persistence = createPersistence();
    persistence.saveRoster(roster);
    persistence.ensureAuctionRecord({ auctionDbId: 'auction-db', externalId: 'public-key', startedAtMs: 1000 });

    const log = persistence.readAuctionLog('auction-db', 'public-key');

    assert.equal(log.auctionId, 'public-key');
    assert.equal(log.auctionDbId, 'auction-db');
    assert.equal(log.ticks.length, 0);
    assert.equal(log.people.length, 2);
    assert.equal(log.rooms.length, 2);
});

test('appended log snapshot is readable with room selectors', () => {
    const persistence = createPersistence();
    persistence.saveRoster(roster);
    const savedRoster = persistence.readRoster();
    persistence.appendLogSnapshot({
        auctionDbId: 'auction-db',
        externalId: 'public-key',
        startedAtMs: 1000,
        tickTime: '2026-01-01T00:00:00.000Z',
        timer: 3,
        rooms: [
            { roomId: savedRoster.rooms[0].id, price: 105, selectors: [savedRoster.people[0].id] },
            { roomId: savedRoster.rooms[1].id, price: 115, selectors: [savedRoster.people[1].id] }
        ]
    });

    const log = persistence.readAuctionLog('auction-db', 'public-key');

    assert.equal(log.ticks.length, 1);
    assert.deepEqual(log.ticks[0].rooms, [
        { roomId: savedRoster.rooms[0].id, price: 105, selectors: [savedRoster.people[0].id] },
        { roomId: savedRoster.rooms[1].id, price: 115, selectors: [savedRoster.people[1].id] }
    ]);
});

test('CSV export keeps price and selector columns per room', () => {
    const persistence = createPersistence();
    persistence.saveRoster(roster);
    const savedRoster = persistence.readRoster();
    persistence.appendLogSnapshot({
        auctionDbId: 'auction-db',
        externalId: 'public-key',
        startedAtMs: 1000,
        tickTime: '2026-01-01T00:00:00.000Z',
        timer: 3,
        rooms: [
            { roomId: savedRoster.rooms[0].id, price: 105, selectors: [savedRoster.people[0].id] },
            { roomId: savedRoster.rooms[1].id, price: 115, selectors: [savedRoster.people[1].id] }
        ]
    });

    const csv = buildLogCsv(persistence.readAuctionLog('auction-db', 'public-key'));

    assert.match(csv, /tickTime,timer,NorthPrice,SouthPrice,NorthSelectors,SouthSelectors/);
    assert.match(csv, /2026-01-01T00:00:00.000Z,3,105,115,"A","B"/);
});
