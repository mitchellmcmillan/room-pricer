// auction-server.js
// Simple Node.js websocket auction server for room auction and static file serving

import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { promises as fsp } from 'fs';
import Database from 'better-sqlite3';
import { applyAuctionCommand, createAuctionEngineState } from './auction/engine.js';
import { validateRoomAuctionRoster } from './auction/roster.js';
import { buildClientAuctionSnapshot } from './auction/snapshot.js';
import { buildLogCsv as buildLogCsvFromLog, createSqliteAuctionPersistence } from './auction/sqlite-persistence.js';
import { applyRuntimeAuctionCommand, personIdAt, roomIdAt } from './auction/runtime.js';

const PORT = 8080;
const LOG_DIR = path.resolve('log');
const DB_PATH = path.join(LOG_DIR, 'auction-log.sqlite');

const DEFAULT_TICK_INTERVAL_MS = 10000;
const DEFAULT_TICK_AMOUNT = 1;
const AUCTION_READY_COUNTDOWN_MS = 5000;
const WORD_LIST_LOCAL = path.resolve('wordlists/english-lowercase.txt');
const WORD_LIST_PATHS = [
    WORD_LIST_LOCAL,
    '/usr/share/dict/words',
    '/usr/share/dict/web2'
];

// Auction state (populated from DB/defaults)
let people = [];
let roomNames = [];
let roomDescriptions = [];
let initialPrices = [];
let roomRecords = [];
let peopleRecords = [];
let tickIntervalMs = DEFAULT_TICK_INTERVAL_MS;
let tickAmount = DEFAULT_TICK_AMOUNT;

let baseConfig = null;
const auctions = new Map(); // auctionId -> auction state
const connectionAuctionMap = new Map(); // ws -> auctionId
let db = null;
let auctionPersistence = null;
let defaultAuctionId = null; // internal id
let defaultAuctionPublicId = null; // three-word key
const PENDING_JOIN_TIMEOUT_MS = 10 * 60 * 1000;
const AUCTION_IDLE_CLOSE_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_CONNECTIONS = 200;
const MAX_CONNECTIONS_PER_MINUTE = 30;
const ipConnectionHistory = new Map(); // ip -> timestamps
const IP_HISTORY_TTL_MS = 60000;
const metricsCounters = new Map(); // key -> number
const API_RATE_LIMIT_PER_MINUTE = 120;
const apiIpHistory = new Map(); // ip -> timestamps
let cachedWordList = null;

function generateShortId(length = 6) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < length; i++) {
        out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
}

function loadWordList() {
    if (cachedWordList) return cachedWordList;
    for (const p of WORD_LIST_PATHS) {
        try {
            const buf = fs.readFileSync(p, 'utf8');
            const words = buf.split(/\r?\n/).map(w => w.trim().toLowerCase()).filter(w => /^[a-z]{3,12}$/.test(w));
            if (words.length > 0) {
                cachedWordList = words;
                return cachedWordList;
            }
        } catch {
            // try next word list source
        }
    }
    cachedWordList = [
        'apple', 'river', 'stone', 'forest', 'ocean', 'mountain', 'sunset', 'breeze', 'comet', 'ember',
        'glacier', 'harbor', 'island', 'jungle', 'meadow', 'nebula', 'orchard', 'prairie', 'quartz', 'ridge',
        'summit', 'thicket', 'valley', 'willow', 'zephyr', 'aurora', 'canyon', 'dune', 'fir', 'grove'
    ];
    return cachedWordList;
}

function generateThreeWordKey() {
    const words = loadWordList();
    const pick = () => words[Math.floor(Math.random() * words.length)];
    let w1, w2, w3, w4;
    for (let i = 0; i < 7; i++) {
        w1 = pick(); w2 = pick(); w3 = pick(); w4 = pick();
        if (new Set([w1, w2, w3, w4]).size === 4) break;
    }
    return `${w1}-${w2}-${w3}-${w4}`;
}

function createAuctionState(id, config) {
    if (!config) throw new Error('Base config not loaded yet');
    const engineState = createAuctionEngineState({
        people: config.peopleRecords,
        rooms: config.roomRecords,
        tickAmount: config.tickAmount,
        initialPricesByRoomId: Object.fromEntries(config.roomRecords.map((room, idx) => [room.id, config.initialPrices[idx] ?? 0]))
    });
    return {
        id,
        externalId: id,
        people: config.people,
        roomNames: config.roomNames,
        roomDescriptions: config.roomDescriptions,
        initialPrices: config.initialPrices,
        roomPrices: [...config.initialPrices],
        roomSelections: config.roomNames.map(() => []),
        tickIntervalMs: config.tickIntervalMs,
        tickAmount: config.tickAmount,
        auctionStartTime: null,
        smoothProgress: 0,
        timer: 0,
        paused: false,
        pauseReason: null,
        auctionDbId: null,
        chosenPeople: [],
        readyPeople: [],
        allocationLocked: false,
        idleCloseTimeout: null,
        auctionCountdownTimeout: null,
        auctionCountdownEndTime: null,
        auctionCountdownRemainingMs: null,
        tickTimeout: null,
        peopleRecords: config.peopleRecords,
        roomRecords: config.roomRecords,
        clients: new Set(),
        clientPersonMap: new Map(),
        pendingJoinTimers: new Map(),
        engineState
    };
}

function getPersonIdByIndex(auction, personIdx) {
    return auction.peopleRecords[personIdx]?.id;
}

function getRoomIdByIndex(auction, roomIdx) {
    return auction.roomRecords[roomIdx]?.id;
}

function syncEngineStateFromAuction(auction) {
    const selectedRoomByPersonId = {};
    auction.roomSelections.forEach((personIndices, roomIdx) => {
        const roomId = getRoomIdByIndex(auction, roomIdx);
        if (roomId === undefined) return;
        personIndices.forEach(personIdx => {
            const personId = getPersonIdByIndex(auction, personIdx);
            if (personId !== undefined) selectedRoomByPersonId[personId] = roomId;
        });
    });
    auction.engineState = {
        ...auction.engineState,
        claimedPersonIds: auction.chosenPeople.map(personIdx => getPersonIdByIndex(auction, personIdx)).filter(id => id !== undefined),
        readyPersonIds: auction.readyPeople.map(personIdx => getPersonIdByIndex(auction, personIdx)).filter(id => id !== undefined),
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

function syncAuctionFromEngineState(auction) {
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

function applyEngineEffects(auction, effects) {
    effects.forEach(effect => {
        if (effect.type === 'cancel_tick' && auction.tickTimeout) {
            clearTimeout(auction.tickTimeout);
            auction.tickTimeout = null;
        }
        if (effect.type === 'cancel_countdown') {
            cancelAuctionCountdown(auction);
        }
        if (effect.type === 'start_countdown') {
            startEngineCountdown(auction, effect);
        }
        if (effect.type === 'schedule_tick') {
            scheduleNextTick(auction);
        }
        if (effect.type === 'close_connections') {
            setTimeout(() => {
                auction.clients.forEach(client => client.close());
            }, 0);
        }
    });
}

function sendEngineError(ws, result) {
    ws.send(JSON.stringify({ type: 'error', message: result.error.message, code: result.error.code }));
}

function cancelIdleCloseTimer(auction) {
    if (!auction?.idleCloseTimeout) return;
    clearTimeout(auction.idleCloseTimeout);
    auction.idleCloseTimeout = null;
}

function scheduleIdleCloseIfEmpty(auction) {
    if (!auction || auction.ended) return;
    if (auction.clients.size > 0) return;
    if (auction.idleCloseTimeout) return;
    auction.idleCloseTimeout = setTimeout(() => {
        auction.idleCloseTimeout = null;
        if (auction.ended || auction.clients.size > 0) return;
        const timedOutAuctionId = auction.id;
        const timedOutExternalId = auction.externalId || auction.id;
        const wasDefaultAuction = defaultAuctionId === timedOutAuctionId;
        auction.ended = true;
        cancelIdleCloseTimer(auction);
        if (auction.tickTimeout) clearTimeout(auction.tickTimeout);
        auction.tickTimeout = null;
        cancelAuctionCountdown(auction);
        auction.readyPeople = [];
        broadcast(auction, { type: 'auction_end', reason: 'inactivity_timeout' });
        auctions.delete(timedOutAuctionId);
        if (wasDefaultAuction) {
            const rosterValidation = validateRoomAuctionRoster({ people: peopleRecords, rooms: roomRecords }, { allowEmpty: true });
            const hasRoster = peopleRecords.length > 0 && roomRecords.length > 0 && rosterValidation.ok;
            if (hasRoster) {
                const replacement = createAuctionFromBase();
                defaultAuctionId = replacement.id;
                defaultAuctionPublicId = replacement.externalId;
                console.log(`[AUCTION] Replaced timed-out default auction ${timedOutExternalId} with ${replacement.externalId} (${replacement.id}).`);
            } else {
                defaultAuctionId = null;
                defaultAuctionPublicId = null;
                console.log(`[AUCTION] Default auction ${timedOutExternalId} removed after inactivity; no roster available for replacement.`);
            }
        }
        console.log(`[AUCTION] ${timedOutExternalId} ended and was deleted after 1 hour with no connected bidders.`);
    }, AUCTION_IDLE_CLOSE_TIMEOUT_MS);
}

function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 1e6) {
                reject(new Error('Body too large'));
                req.connection.destroy();
            }
        });
        req.on('end', () => {
            if (!body) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function createAuctionFromBase() {
    if (!baseConfig) throw new Error('Base configuration not loaded yet');
    const auctionId = generateShortId();
    let externalId = generateThreeWordKey();
    const existingKeys = new Set(Array.from(auctions.values()).map(a => a.externalId));
    let guard = 0;
    while (existingKeys.has(externalId) && guard < 20) {
        externalId = generateThreeWordKey();
        guard++;
    }
    const auction = createAuctionState(auctionId, baseConfig);
    auction.externalId = externalId;
    auctions.set(auctionId, auction);
    return auction;
}

function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function isApiAuthorized(req, url) {
    // const requiredToken = process.env.AUCTION_API_TOKEN;
    // hard code for now to avoid env issues
    const requiredToken = 'supersecretapitoken';

    if (!requiredToken) return true;
    const header = req.headers['authorization'] || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
    const queryToken = url.searchParams.get('api_token');
    return bearer === requiredToken || queryToken === requiredToken;
}

function isProtectedApiPath(pathname) {
    // Keep admin endpoints protected except auction log reading, which is public.
    const isAdminPath = pathname.startsWith('/api/admin/');
    const isAuctionLogsPath = /^\/api\/admin\/auctions\/[^/]+\/logs$/.test(pathname);
    return isAdminPath && !isAuctionLogsPath;
}

function incMetric(key) {
    metricsCounters.set(key, (metricsCounters.get(key) || 0) + 1);
}

function getMetrics() {
    const lines = [];
    lines.push(`# HELP active_auctions Number of active auctions`);
    lines.push(`# TYPE active_auctions gauge`);
    lines.push(`active_auctions ${auctions.size}`);
    lines.push(`# HELP active_sockets Number of active websocket connections`);
    lines.push(`# TYPE active_sockets gauge`);
    lines.push(`active_sockets ${wss.clients.size}`);
    lines.push(`# HELP default_auction_id Default auction identifier as a label (value is always 1)`);
    lines.push(`# TYPE default_auction_id gauge`);
    if (defaultAuctionId) {
        lines.push(`default_auction_id{auction_id="${defaultAuctionId}"} 1`);
    }
    metricsCounters.forEach((val, key) => {
        lines.push(`# TYPE ${key} counter`);
        lines.push(`${key} ${val}`);
    });
    return lines.join('\n') + '\n';
}

function auctionPayload(auction) {
    return {
        people: auction.people,
        roomNames: auction.roomNames,
        roomDescriptions: auction.roomDescriptions,
        tickIntervalMs: auction.tickIntervalMs,
        tickAmount: auction.tickAmount
    };
}

function withConfigPayload(auction, data = {}) {
    const payload = {
        ...data,
        ...auctionPayload(auction)
    };
    if (!auction.auctionStartTime) {
        payload.auctionCountdownEndTime = auction.auctionCountdownEndTime || null;
    }
    return payload;
}

function countdownPayload(auction) {
    return auction.auctionCountdownEndTime && !auction.auctionStartTime
        ? { auctionCountdownEndTime: auction.auctionCountdownEndTime }
        : {};
}

function broadcast(auction, data) {
    const payload = {
        ...data,
        ...auctionPayload(auction)
    };
    if (!auction.auctionStartTime) {
        payload.auctionCountdownEndTime = auction.auctionCountdownEndTime || null;
    }
    const msg = JSON.stringify(payload);
    auction.clients.forEach(client => {
        if (client.readyState === client.OPEN) {
            client.send(msg);
        }
    });
}

function sendAuctionState(auction, extra = {}) {
    broadcast(auction, {
        type: 'auction_update',
        roomPrices: auction.roomPrices,
        roomSelections: auction.roomSelections,
        smoothProgress: auction.smoothProgress,
        auctionStartTime: auction.auctionStartTime,
        auctionPaused: !!auction.paused,
        auctionPauseReason: auction.pauseReason || null,
        timer: auction.timer,
        serverTime: Date.now(),
        chosenPeople: auction.chosenPeople,
        readyPeople: auction.readyPeople,
        ...extra
    });
}

function cancelAuctionCountdown(auction) {
    if (!auction) return;
    if (auction.auctionCountdownTimeout) {
        clearTimeout(auction.auctionCountdownTimeout);
        auction.auctionCountdownTimeout = null;
    }
    auction.auctionCountdownEndTime = null;
    auction.auctionCountdownRemainingMs = null;
    if (auction.engineState) {
        auction.engineState = { ...auction.engineState, countdownEndsAt: null };
    }
}

function pauseAuctionCountdown(auction) {
    if (!auction || !auction.auctionCountdownEndTime || auction.auctionStartTime) return false;
    const msLeft = Math.max(0, auction.auctionCountdownEndTime - Date.now());
    if (auction.auctionCountdownTimeout) {
        clearTimeout(auction.auctionCountdownTimeout);
        auction.auctionCountdownTimeout = null;
    }
    auction.auctionCountdownEndTime = null;
    auction.auctionCountdownRemainingMs = msLeft;
    return true;
}

function startEngineCountdown(auction, effect) {
    const countdownMs = Math.max(1, Math.floor(effect.endsAt - Date.now()));
    if (auction.auctionCountdownTimeout) {
        clearTimeout(auction.auctionCountdownTimeout);
    }
    auction.auctionCountdownEndTime = effect.endsAt;
    auction.auctionCountdownRemainingMs = null;
    broadcast(auction, {
        type: 'auction_countdown',
        countdownEndTime: auction.auctionCountdownEndTime
    });
    auction.auctionCountdownTimeout = setTimeout(async () => {
        auction.auctionCountdownTimeout = null;
        syncEngineStateFromAuction(auction);
        const result = applyAuctionCommand(auction.engineState, { type: 'countdown_elapsed' }, Date.now());
        if (!result.ok) {
            console.error(`[AUCTION] Countdown elapsed failed for ${auction.id}: ${result.error.message}`);
            return;
        }
        auction.engineState = result.state;
        syncAuctionFromEngineState(auction);
        await ensureAuctionRecord(auction, auction.auctionStartTime);
        applyEngineEffects(auction, result.effects);
        sendAuctionState(auction);
    }, countdownMs);
}

async function handleApi(req, res) {
    const url = new URL(req.url, 'http://localhost');
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return true;
    }

    if (isProtectedApiPath(url.pathname) && !isApiAuthorized(req, url)) {
        sendJson(res, 401, { error: 'Unauthorized', code: 'unauthorized' });
        return true;
    }

    if (url.pathname.startsWith('/api/')) {
        const ip = req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        cleanupApiHistory(now);
        const recent = (apiIpHistory.get(ip) || []).filter(ts => now - ts < 60000);
        recent.push(now);
        apiIpHistory.set(ip, recent);
        if (recent.length > API_RATE_LIMIT_PER_MINUTE) {
            sendJson(res, 429, { error: 'Too many requests', code: 'rate_limited' });
            return true;
        }
    }

    if (url.pathname === '/healthz') {
        let dbOk = true;
        try {
            await initDatabase();
            db.prepare('SELECT 1').get();
        } catch {
            dbOk = false;
        }
        sendJson(res, dbOk ? 200 : 503, {
            ok: dbOk,
            db: dbOk ? 'ok' : 'error',
            activeAuctions: auctions.size,
            activeSockets: wss.clients.size,
            defaultAuctionId: defaultAuctionPublicId || defaultAuctionId,
            defaultAuctionPublicId,
            rosterPeople: peopleRecords.length,
            rosterRooms: roomRecords.length
        });
        return true;
    }

    if (url.pathname === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(getMetrics());
        return true;
    }

    if (url.pathname === '/api/roster' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const incomingPeople = Array.isArray(body.people) ? body.people : [];
            const incomingRooms = Array.isArray(body.rooms) ? body.rooms : [];
            if (incomingPeople.length === 0 || incomingRooms.length === 0) {
                sendJson(res, 400, { error: 'Roster must include people and rooms', code: 'roster_invalid' });
                return true;
            }
            const rosterValidation = validateRoomAuctionRoster({ people: incomingPeople, rooms: incomingRooms });
            if (!rosterValidation.ok) {
                sendJson(res, 400, { error: rosterValidation.error.message, code: rosterValidation.error.code });
                return true;
            }
            await initDatabase();
            auctionPersistence.saveRoster({ people: incomingPeople, rooms: incomingRooms });
            // Stop any live auctions before replacing base config.
            auctions.forEach((auction) => {
                auction.ended = true;
                cancelIdleCloseTimer(auction);
                if (auction.tickTimeout) clearTimeout(auction.tickTimeout);
                auction.tickTimeout = null;
                cancelAuctionCountdown(auction);
            });
            auctions.clear();
            await loadConfigFromDatabase({ resetDefaultAuction: true });
            sendJson(res, 200, { ok: true, people: incomingPeople.length, rooms: incomingRooms.length, defaultAuctionId: defaultAuctionPublicId || defaultAuctionId, defaultAuctionPublicId });
            incMetric('api_requests_total');
        } catch (e) {
            console.error('[ROSTER] Failed to update roster:', e);
            sendJson(res, 400, { error: `Invalid roster payload: ${e?.message || 'unknown error'}`, code: 'roster_invalid' });
        }
        return true;
    }
    if (url.pathname === '/api/roster' && req.method === 'GET') {
        await loadConfigFromDatabase(); // ensure baseConfig is fresh
        sendJson(res, 200, {
            people: peopleRecords.map(p => ({ name: p.name, emoji: p.emoji })),
            rooms: roomRecords.map(r => ({ name: r.name, description: r.description, initialPrice: r.initialPrice })),
            counts: { people: peopleRecords.length, rooms: roomRecords.length },
            defaultAuctionId: defaultAuctionPublicId || defaultAuctionId,
            defaultAuctionPublicId
        });
        incMetric('api_requests_total');
        return true;
    }

    if (url.pathname === '/api/config/reload' && req.method === 'POST') {
        sendJson(res, 410, { error: 'Deprecated endpoint. Use /api/admin/config/reload.', code: 'deprecated' });
        return true;
    }

    if (url.pathname === '/api/admin/config/reload' && req.method === 'POST') {
        const previousDefaultAuctionId = defaultAuctionId;
        await loadConfigFromDatabase({ resetDefaultAuction: true });
        sendJson(res, 200, { ok: true, defaultAuctionId, previousDefaultAuctionId });
        incMetric('api_requests_total');
        return true;
    }

    if (url.pathname === '/api/auctions' && req.method === 'POST') {
        if (!baseConfig) {
            sendJson(res, 503, { error: 'Base configuration not loaded', code: 'config_missing' });
            return true;
        }
        if (peopleRecords.length === 0 || roomRecords.length === 0) {
            sendJson(res, 409, { error: 'Roster missing', code: 'roster_missing' });
            return true;
        }
        const rosterValidation = validateRoomAuctionRoster({ people: peopleRecords, rooms: roomRecords });
        if (!rosterValidation.ok) {
            sendJson(res, 409, { error: rosterValidation.error.message, code: rosterValidation.error.code });
            return true;
        }
        const auction = createAuctionFromBase();
        const auctionId = auction.id;
        sendJson(res, 201, { auctionId, externalId: auction.externalId, publicId: auction.externalId, capacity: auction.people.length });
        console.log(`[AUCTION] Created auction ${auction.externalId} (${auctionId})`);
        incMetric('api_requests_total');
        return true;
    }

    if (url.pathname === '/api/auctions' && req.method === 'GET') {
        sendJson(res, 410, { error: 'Moved to /api/admin/auctions', code: 'deprecated' });
        return true;
    }

    if (url.pathname === '/api/admin/auctions' && req.method === 'GET') {
        sendJson(res, 200, {
            auctions: Array.from(auctions.values()).map(a => ({
                auctionId: a.id,
                auctionDbId: a.auctionDbId || null,
                externalId: a.externalId || a.id || null,
                capacity: a.people.length,
                connected: a.clients.size,
                chosen: a.chosenPeople.length,
                readyCount: a.readyPeople.length,
                startedAt: a.auctionStartTime,
                ended: !!a.ended
            }))
        });
        incMetric('api_requests_total');
        return true;
    }

    if (url.pathname.startsWith('/api/auctions/') && url.pathname.endsWith('/start') && req.method === 'POST') {
        const parts = url.pathname.split('/');
        const auctionKey = parts[3] || '';
        const auction = getAuctionByKey(auctionKey);
        if (!auction) {
            sendJson(res, 404, { error: 'Auction not found', code: 'not_found' });
            return true;
        }
        if (auction.allocationLocked) {
            sendJson(res, 400, { error: 'Auction cannot be restarted once allocation has been found', code: 'allocation_locked' });
            return true;
        }
        const started = await handleStartAuction(auction);
        if (!started) {
            sendJson(res, 400, { error: 'Auction already started or ended', code: 'invalid_state' });
            return true;
        }
        sendJson(res, 200, { auctionId: auction.id, externalId: auction.externalId, startedAt: auction.auctionStartTime });
        incMetric('api_requests_total');
        return true;
    }

    if (url.pathname.startsWith('/api/auctions/') && url.pathname.endsWith('/clone') && req.method === 'POST') {
        const parts = url.pathname.split('/');
        const sourceKey = parts[3] || '';
        const sourceAuction = getAuctionByKey(sourceKey);
        if (!sourceAuction) {
            sendJson(res, 404, { error: 'Auction not found', code: 'not_found' });
            return true;
        }
        try {
            const auction = createAuctionFromBase();
            sendJson(res, 201, { auctionId: auction.id, externalId: auction.externalId, capacity: auction.people.length });
            console.log(`[AUCTION] Cloned auction ${sourceKey} into ${auction.externalId} (${auction.id})`);
        } catch {
            sendJson(res, 500, { error: 'Failed to clone auction', code: 'server_error' });
        }
        incMetric('api_requests_total');
        return true;
    }

    if (url.pathname.startsWith('/api/auctions/') && url.pathname.endsWith('/end') && req.method === 'POST') {
        const parts = url.pathname.split('/');
        const auctionKey = parts[3] || '';
        const auction = getAuctionByKey(auctionKey);
        if (!auction) {
            sendJson(res, 404, { error: 'Auction not found', code: 'not_found' });
            return true;
        }
        syncEngineStateFromAuction(auction);
        const result = applyAuctionCommand(auction.engineState, { type: 'end' }, Date.now());
        auction.engineState = result.state;
        syncAuctionFromEngineState(auction);
        applyEngineEffects(auction, result.effects);
        broadcast(auction, { type: 'auction_end' });
        sendJson(res, 200, { auctionId: auction.id, externalId: auction.externalId, ended: true });
        incMetric('api_requests_total');
        return true;
    }

    if (url.pathname.startsWith('/api/auctions/') && url.pathname.endsWith('/config') && req.method === 'GET') {
        const parts = url.pathname.split('/');
        const auctionKey = parts[3] || '';
        const auction = getAuctionByKey(auctionKey);
        if (!auction) {
            sendJson(res, 404, { error: 'Auction not found', code: 'not_found' });
            return true;
        }
        sendJson(res, 200, auctionPayload(auction));
        return true;
    }

    if (url.pathname.startsWith('/api/auctions/') && url.pathname.endsWith('/logs') && req.method === 'GET') {
        sendJson(res, 410, { error: 'Moved to /api/admin/auctions/:id/logs', code: 'deprecated' });
        return true;
    }

    if (url.pathname.startsWith('/api/admin/auctions/') && url.pathname.endsWith('/logs') && req.method === 'GET') {
        const parts = url.pathname.split('/');
        const auctionId = parts[4] || '';
        const resolved = await resolveAuctionDbId(auctionId);
        if (!resolved) {
            sendJson(res, 404, { error: 'Auction not found', code: 'not_found' });
            return true;
        }
        try {
            const logData = await readAuctionLog(resolved.auctionDbId, resolved.externalId);
            res.setHeader('X-Auction-Id', resolved.externalId || auctionId);
            res.setHeader('X-Auction-Db-Id', resolved.auctionDbId);
            const format = url.searchParams.get('format') || 'json';
            if (format === 'csv') {
                const csv = buildLogCsvFromLog(logData);
                res.writeHead(200, { 'Content-Type': 'text/csv' });
                res.end(csv);
            } else {
                sendJson(res, 200, logData);
            }
            incMetric('api_requests_total');
        } catch (e) {
            console.error('[LOG] Failed to read auction log:', e);
            sendJson(res, 500, { error: 'Failed to read auction log', code: 'server_error' });
        }
        return true;
    }

    if (url.pathname.startsWith('/api/auctions/') && req.method === 'GET') {
        const auctionKey = url.pathname.split('/')[3] || '';
        const auction = getAuctionByKey(auctionKey);
        if (!auction) {
            sendJson(res, 404, { error: 'Auction not found', code: 'not_found' });
            return true;
        }
        sendJson(res, 200, {
            auctionId: auction.id,
            auctionDbId: auction.auctionDbId || null,
            externalId: auction.externalId || auctionKey,
            capacity: auction.people.length,
            connected: auction.clients.size,
            startedAt: auction.auctionStartTime,
            readyCount: auction.readyPeople.length
        });
        incMetric('api_requests_total');
        return true;
    }

    return false;
}

const isDev = process.env.NODE_ENV === 'development';

let server;
if (isDev) {
    // Development: only WebSocket server, let Vite serve static files
    server = http.createServer(async (req, res) => {
        if (await handleApi(req, res)) return;
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Static file serving disabled in development. Use Vite dev server.');
    });
    console.log('Running in development mode: static files served by Vite dev server.');
} else {
    // Production: API/WebSocket only (static serving disabled)
    server = http.createServer(async (req, res) => {
        if (await handleApi(req, res)) return;
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Static file serving is disabled.');
    });
    console.log('Running in production mode: API/WebSocket only, static files disabled.');
}

const wss = new WebSocketServer({ server });
await loadConfigFromDatabase();
server.listen(PORT, () => {
    console.log(`Auction server running on http://localhost:${PORT}`);
});

function updateAuctionLogic(auction) {
    const result = applyRuntimeAuctionCommand(auction, { type: 'tick' }, Date.now());
    if (!result.ok) {
        console.log(`[TICK] ${result.error.message}`);
        return false;
    }
    console.log(`[TICK] Price update at timer=${auction.timer} for ${auction.id}`);
    console.log(`[TICK] Prices before: ${JSON.stringify(auction.roomPrices)}`);
    console.log(`[TICK] Prices after:  ${JSON.stringify(auction.roomPrices)}`);
    if (result.events.some(event => event.type === 'allocation_locked')) {
        console.log(`[AUCTION] Allocation found for ${auction.externalId || auction.id}; restart disabled.`);
    }
    return true;
}

async function ensureLogDir() {
    try {
        await fsp.mkdir(LOG_DIR, { recursive: true });
    } catch {
        // ignore
    }
}

async function initDatabase() {
    if (db) return db;
    await ensureLogDir();
    db = new Database(DB_PATH);
    auctionPersistence = createSqliteAuctionPersistence(db, {
        tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
        tickAmount: DEFAULT_TICK_AMOUNT
    });
    auctionPersistence.initialize();
    return db;
}

async function loadConfigFromDatabase(options = {}) {
    const { resetDefaultAuction = false } = options;
    await initDatabase();
    const roster = auctionPersistence.readRoster();
    const peopleRows = roster.people;
    const roomRows = roster.rooms;

    peopleRecords = peopleRows;
    roomRecords = roomRows;
    people = peopleRows.map(({ name, emoji }) => ({ name, emoji }));
    roomNames = roomRows.map(r => r.name);
    roomDescriptions = roomRows.map(r => r.description || '');
    initialPrices = roomRows.map(r => r.initialPrice);
    const parsedInterval = Number(roster.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
    const parsedTickAmount = Number(roster.tickAmount ?? DEFAULT_TICK_AMOUNT);
    tickIntervalMs = Number.isFinite(parsedInterval) ? parsedInterval : DEFAULT_TICK_INTERVAL_MS;
    tickAmount = Number.isFinite(parsedTickAmount) ? parsedTickAmount : DEFAULT_TICK_AMOUNT;

    baseConfig = {
        people,
        roomNames,
        roomDescriptions,
        initialPrices,
        tickIntervalMs,
        tickAmount,
        peopleRecords,
        roomRecords
    };
    const rosterValidation = validateRoomAuctionRoster({ people: peopleRecords, rooms: roomRecords }, { allowEmpty: true });
    const hasRoster = peopleRecords.length > 0 && roomRecords.length > 0 && rosterValidation.ok;
    if (!defaultAuctionId || resetDefaultAuction) {
        if (hasRoster) {
            const auction = createAuctionFromBase();
            defaultAuctionId = auction.id;
            defaultAuctionPublicId = auction.externalId;
            console.log(`[AUCTION] Default auction created with id ${auction.id} (public ${auction.externalId})`);
        } else {
            defaultAuctionId = null;
            defaultAuctionPublicId = null;
            console.log('[AUCTION] No roster found; default auction not created.');
        }
    }
}

async function ensureAuctionRecord(auction, startTimeMs) {
    await initDatabase();
    const externalId = auction.externalId || auction.id;
    if (!auction.auctionDbId) {
        const existing = auctionPersistence.resolveAuctionDbId(externalId);
        auction.auctionDbId = existing?.auctionDbId || externalId;
    }
    auctionPersistence.ensureAuctionRecord({ auctionDbId: auction.auctionDbId, externalId, startedAtMs: startTimeMs });
    return db;
}

async function logTick(auction) {
    try {
        await ensureLogDir();
        await ensureAuctionRecord(auction, auction.auctionStartTime);
        auctionPersistence.appendLogSnapshot({
            auctionDbId: auction.auctionDbId,
            externalId: auction.externalId || auction.id,
            startedAtMs: auction.auctionStartTime,
            tickTime: new Date().toISOString(),
            timer: auction.timer,
            rooms: auction.roomSelections.map((indices, idx) => ({
                roomId: auction.roomRecords[idx]?.id,
                price: auction.roomPrices[idx] ?? 0,
                selectors: indices
                    .map(personIdx => auction.peopleRecords[personIdx]?.id)
                    .filter(personId => personId !== undefined)
            })).filter(room => room.roomId !== undefined)
        });
    } catch (e) {
        console.error('[LOG] Failed to write log tick to sqlite:', e);
    }
}

async function resolveAuctionDbId(requestedId) {
    await initDatabase();
    const active = getAuctionByKey(requestedId);
    if (active) {
        await ensureAuctionRecord(active, active.auctionStartTime);
        return {
            auctionDbId: active.auctionDbId || active.id || requestedId,
            externalId: active.externalId || active.id || requestedId
        };
    }
    return auctionPersistence.resolveAuctionDbId(requestedId);
}

async function readAuctionLog(auctionDbId, externalId) {
    await initDatabase();
    return auctionPersistence.readAuctionLog(auctionDbId, externalId);
}

function handleSelectRoom(auction, ws, data) {
    if (typeof data.personIdx !== 'number' || typeof data.roomIdx !== 'number') {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid select_room data.' }));
        return false;
    }
    if (data.personIdx < 0 || data.personIdx >= auction.people.length || data.roomIdx < 0 || data.roomIdx >= auction.roomSelections.length) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid room or person selection.' }));
        return false;
    }
    const owner = auction.clientPersonMap.get(ws);
    if (owner !== data.personIdx) {
        ws.send(JSON.stringify({ type: 'error', message: 'You may only move the person you control.' }));
        return false;
    }
    const personId = personIdAt(auction, data.personIdx);
    const roomId = roomIdAt(auction, data.roomIdx);
    const result = applyRuntimeAuctionCommand(auction, { type: 'select_room', personId, roomId }, Date.now());
    if (!result.ok) {
        sendEngineError(ws, result);
        return false;
    }
    sendAuctionState(auction, countdownPayload(auction));
    return true;
}

function handleSelectPerson(auction, ws, data) {
    if (typeof data.personIdx !== 'number') {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid select_person data.' }));
        return false;
    }
    if (data.personIdx < 0 || data.personIdx >= auction.people.length) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown person.' }));
        return false;
    }
    const seatTaken = auction.chosenPeople.length >= auction.people.length && !auction.chosenPeople.includes(data.personIdx);
    if (seatTaken) {
        ws.send(JSON.stringify({ type: 'error', message: 'Auction is full.' }));
        return false;
    }
    const prevIdx = auction.clientPersonMap.get(ws);
    if (prevIdx === data.personIdx) {
        sendAuctionState(auction, countdownPayload(auction));
        return true;
    }
    if (typeof prevIdx === 'number') {
        const releaseResult = releasePerson(auction, prevIdx);
        if (releaseResult && !releaseResult.ok) {
            sendEngineError(ws, releaseResult);
            return false;
        }
    }
    const personId = personIdAt(auction, data.personIdx);
    const result = applyRuntimeAuctionCommand(auction, { type: 'claim_person', personId }, Date.now());
    if (!result.ok) {
        sendEngineError(ws, result);
        return false;
    }
    auction.clientPersonMap.set(ws, data.personIdx);
    sendAuctionState(auction, countdownPayload(auction));
    return true;
}

function releasePerson(auction, personIdx, reason = 'deselect') {
    if (typeof personIdx !== 'number' || personIdx < 0 || personIdx >= auction.people.length) return null;
    const personId = personIdAt(auction, personIdx);
    if (personId === undefined) return null;
    const result = applyRuntimeAuctionCommand(auction, { type: 'release_person', personId, reason }, Date.now());
    if (!result.ok) return result;
    applyEngineEffects(auction, result.effects);
    if (reason !== 'disconnect') {
        pauseAuctionCountdown(auction);
    }
    return result;
}

function cleanupIpHistory(now) {
    cleanupHistory(ipConnectionHistory, now, IP_HISTORY_TTL_MS);
}

function cleanupApiHistory(now) {
    cleanupHistory(apiIpHistory, now, 60000);
}

function cleanupHistory(history, now, ttlMs) {
    for (const [ip, timestamps] of history.entries()) {
        const recent = timestamps.filter(ts => now - ts < ttlMs);
        if (recent.length > 0) {
            history.set(ip, recent);
        } else {
            history.delete(ip);
        }
    }
}

function handleDeselectPerson(auction, ws, data) {
    if (typeof data.personIdx === 'number' && data.personIdx >= 0 && data.personIdx < auction.people.length) {
        const releaseResult = releasePerson(auction, data.personIdx);
        if (releaseResult?.ok) {
            auction.clientPersonMap.delete(ws);
            broadcast(auction, {
                type: 'ready_update',
                readyPeople: auction.readyPeople,
                chosenPeople: auction.chosenPeople,
                ...countdownPayload(auction)
            });
            sendAuctionState(auction, countdownPayload(auction));
            return true;
        }
    }
    return false;
}

function getAuctionByKey(key) {
    if (!key) return null;
    const direct = auctions.get(key);
    if (direct) return direct;
    for (const a of auctions.values()) {
        if (a.externalId === key) return a;
    }
    return null;
}

async function handleStartAuction(auction) {
    if (auction.ended) return false;
    const result = applyRuntimeAuctionCommand(auction, { type: 'start' }, Date.now());
    if (!result.ok) {
        return false;
    }
    await ensureAuctionRecord(auction, auction.auctionStartTime);
    console.log(`[AUCTION] Auction ${auction.id} started, scheduling first tick.`);
    applyEngineEffects(auction, result.effects);
    sendAuctionState(auction, countdownPayload(auction));
    return true;
}

async function handleReadyUpdate(auction, ws, data) {
    if (typeof data.personIdx !== 'number' || typeof data.ready !== 'boolean') {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid set_ready data.' }));
        return;
    }
    if (data.personIdx < 0 || data.personIdx >= auction.people.length) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown person.' }));
        return;
    }
    const owner = auction.clientPersonMap.get(ws);
    if (owner !== data.personIdx) {
        ws.send(JSON.stringify({ type: 'error', message: 'You may only ready the person you control.' }));
        return;
    }
    const personId = personIdAt(auction, data.personIdx);
    const result = applyRuntimeAuctionCommand(auction, {
        type: 'set_ready',
        personId,
        ready: data.ready,
        countdownMs: auction.auctionCountdownRemainingMs ?? AUCTION_READY_COUNTDOWN_MS
    }, Date.now());
    if (!result.ok) {
        sendEngineError(ws, result);
        return false;
    }
    applyEngineEffects(auction, result.effects);
    broadcast(auction, {
        type: 'ready_update',
        readyPeople: auction.readyPeople,
        chosenPeople: auction.chosenPeople,
        ...countdownPayload(auction)
    });
    return true;
}
// Auction tick logic: event-driven except for 10s tick
function scheduleNextTick(auction) {
    if (!auction.auctionStartTime || auction.ended) {
        console.log('[TICK] Auction not started, not scheduling tick.');
        return;
    }
    const cycleMs = Math.max(100, auction.tickIntervalMs || DEFAULT_TICK_INTERVAL_MS);
    if (auction.tickTimeout) clearTimeout(auction.tickTimeout);
    auction.tickTimeout = setTimeout(async () => {
        if (auction.ended) return;
        console.log(`[TICK] Tick fired at ${new Date().toISOString()} (timer=${auction.timer}) for ${auction.id}`);
        if (!updateAuctionLogic(auction)) return;
        console.log('[TICK] Broadcasting auction_update on tick.');
        sendAuctionState(auction);
        await logTick(auction);
        scheduleNextTick(auction);
    }, cycleMs);
    console.log(`[TICK] Next tick scheduled in ${cycleMs}ms for ${auction.id}.`);
}

// Graceful shutdown
function shutdown() {
    console.log('Shutting down server...');
    // Stop future ticks/countdowns and broadcast end
    auctions.forEach((auction) => {
        auction.ended = true;
        cancelIdleCloseTimer(auction);
        if (auction.tickTimeout) clearTimeout(auction.tickTimeout);
        cancelAuctionCountdown(auction);
        broadcast(auction, { type: 'auction_end', reason: 'shutdown' });
    });
    // Close servers
    server.close(() => {
        console.log('HTTP server closed.');
    });
    wss.clients.forEach(client => client.close());
    wss.close(() => {
        console.log('WebSocket server closed.');
        process.exit(0);
    });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

wss.on('error', err => {
    console.error('WebSocket server error:', err);
});
server.on('error', err => {
    console.error('HTTP server error:', err);
});

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const requestedKey = url.searchParams.get('auctionId') || defaultAuctionPublicId || defaultAuctionId;
    const auction = getAuctionByKey(requestedKey);
    if (!auction) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown auction.' }));
        ws.close();
        return;
    }
    if (auction.people.length === 0 || auction.roomNames.length === 0) {
        ws.send(JSON.stringify({ type: 'error', message: 'Roster empty. Host must add people and rooms first.' }));
        ws.close();
        return;
    }
    if (wss.clients.size >= MAX_CONNECTIONS) {
        ws.send(JSON.stringify({ type: 'error', message: 'Server connection limit reached.' }));
        ws.close();
        return;
    }
    const ip = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    cleanupIpHistory(now);
    const recent = (ipConnectionHistory.get(ip) || []).filter(ts => now - ts < IP_HISTORY_TTL_MS);
    recent.push(now);
    if (recent.length > 0) {
        ipConnectionHistory.set(ip, recent);
    } else {
        ipConnectionHistory.delete(ip);
    }
    if (recent.length > MAX_CONNECTIONS_PER_MINUTE) {
        ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded.' }));
        ws.close();
        return;
    }
    if (auction.ended) {
        ws.send(JSON.stringify({ type: 'error', message: 'Auction has ended.' }));
        ws.close();
        return;
    }
    const ownedPeople = new Set(auction.clientPersonMap.values());
    const hasReclaimableSeat = auction.chosenPeople.some(idx => !ownedPeople.has(idx));
    if (auction.chosenPeople.length >= auction.people.length && !hasReclaimableSeat) {
        ws.send(JSON.stringify({ type: 'error', message: 'Auction is full.' }));
        ws.close();
        return;
    }

    console.log(`WebSocket connected to auction ${auction.externalId} (${auction.id})`);
    cancelIdleCloseTimer(auction);
    auction.clients.add(ws);
    connectionAuctionMap.set(ws, auction.id);
    const pendingTimer = setTimeout(() => {
        if (!auction.clientPersonMap.has(ws)) {
            ws.send(JSON.stringify({ type: 'error', message: 'No person selected in time.' }));
            ws.close();
        }
    }, PENDING_JOIN_TIMEOUT_MS);
    auction.pendingJoinTimers.set(ws, pendingTimer);

    ws.on('error', err => {
        console.error('WebSocket connection error:', err);
    });

    ws.on('message', async message => {
        let data;
        try {
            data = JSON.parse(message);
        } catch {
            console.error('Invalid JSON from client:', message);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON format.' }));
            return;
        }
        if (!data || typeof data !== 'object' || !data.type) {
            console.error('Invalid message format:', data);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format.' }));
            return;
        }
        if (auction.ended) {
            ws.send(JSON.stringify({ type: 'error', message: 'Auction has ended.' }));
            ws.close();
            return;
        }

        switch (data.type) {
            case 'select_room':
                if (handleSelectRoom(auction, ws, data)) {
                    await logTick(auction);
                }
                break;
            case 'select_person':
                if (handleSelectPerson(auction, ws, data)) {
                    const t = auction.pendingJoinTimers.get(ws);
                    if (t) {
                        clearTimeout(t);
                        auction.pendingJoinTimers.delete(ws);
                    }
                    await logTick(auction);
                }
                break;
            case 'deselect_person':
                if (handleDeselectPerson(auction, ws, data)) {
                    await logTick(auction);
                }
                break;
            case 'start_auction':
                if (auction.allocationLocked) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Auction cannot be restarted once allocation has been found.' }));
                    break;
                }
                if (await handleStartAuction(auction)) {
                    await logTick(auction);
                }
                break;
            case 'set_ready':
                if (await handleReadyUpdate(auction, ws, data)) {
                    await logTick(auction);
                }
                break;
            default:
                ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type.' }));
        }
    });

    ws.on('close', () => {
        const auctionId = connectionAuctionMap.get(ws);
        const auction = auctionId ? auctions.get(auctionId) : null;
        connectionAuctionMap.delete(ws);
        if (!auction) return;
        auction.clients.delete(ws);
        const pendingTimer = auction.pendingJoinTimers.get(ws);
        if (pendingTimer) clearTimeout(pendingTimer);
        auction.pendingJoinTimers.delete(ws);
        const personIdx = auction.clientPersonMap.get(ws);
        if (typeof personIdx === 'number') {
            const wasStarted = !!auction.auctionStartTime;
            auction.clientPersonMap.delete(ws);
            const releaseResult = releasePerson(auction, personIdx, wasStarted ? 'disconnect' : 'deselect');
            if (releaseResult?.ok) {
                broadcast(auction, {
                    type: 'ready_update',
                    readyPeople: auction.readyPeople,
                    chosenPeople: auction.chosenPeople,
                    ...countdownPayload(auction)
                });
                if (releaseResult.events.some(event => event.type === 'auction_paused')) {
                    broadcast(auction, {
                        type: 'auction_paused',
                        reason: 'bidder_disconnected',
                        message: 'Auction paused because a bidder disconnected. Reconnect and mark ready to resume.'
                    });
                }
                sendAuctionState(auction);
            }
        }
        if (auction.clients.size === 0) {
            scheduleIdleCloseIfEmpty(auction);
        }
        incMetric('ws_disconnects_total');
    });

    ws.send(JSON.stringify(withConfigPayload(auction, {
        type: 'auction_update',
        roomPrices: auction.roomPrices,
        roomSelections: auction.roomSelections,
        smoothProgress: auction.smoothProgress,
        auctionStartTime: auction.auctionStartTime,
        auctionPaused: !!auction.paused,
        auctionPauseReason: auction.pauseReason || null,
        timer: auction.timer,
        chosenPeople: auction.chosenPeople,
        readyPeople: auction.readyPeople,
        ...countdownPayload(auction)
    })));
    broadcast(auction, {
        type: 'ready_update',
        readyPeople: auction.readyPeople,
        chosenPeople: auction.chosenPeople,
        ...countdownPayload(auction)
    });
    incMetric('ws_connects_total');
});
