// auction-server.js
// Simple Node.js websocket auction server for room auction and static file serving

import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { promises as fsp } from 'fs';
import Database from 'better-sqlite3';

const PORT = 8080;
const DIST_DIR = path.resolve('dist');
const INDEX_FILE = path.join(DIST_DIR, 'index.html');
const LOG_DIR = path.resolve('log');
const DB_PATH = path.join(LOG_DIR, 'auction-log.sqlite');

const DEFAULT_TICK_INTERVAL_MS = 10000;
const DEFAULT_TICK_AMOUNT = 1;
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
        auctionDbId: null,
        chosenPeople: [],
        readyPeople: [],
        allocationLocked: false,
        idleCloseTimeout: null,
        auctionCountdownTimeout: null,
        auctionCountdownEndTime: null,
        tickTimeout: null,
        peopleRecords: config.peopleRecords,
        roomRecords: config.roomRecords,
        clients: new Set(),
        clientPersonMap: new Map(),
        pendingJoinTimers: new Map()
    };
}

function isAllocationFound(auction) {
    if (!auction || auction.people.length === 0) return false;
    const totalSelected = auction.roomSelections.reduce((sum, arr) => sum + arr.length, 0);
    return totalSelected === auction.people.length && auction.roomSelections.every(arr => arr.length === 1);
}

function maybeLockAllocation(auction) {
    // Lock only after the auction has started.
    if (!auction || !auction.auctionStartTime || auction.allocationLocked) return;
    if (isAllocationFound(auction)) {
        auction.allocationLocked = true;
        console.log(`[AUCTION] Allocation found for ${auction.externalId || auction.id}; restart disabled.`);
    }
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
        auction.ended = true;
        cancelIdleCloseTimer(auction);
        if (auction.tickTimeout) clearTimeout(auction.tickTimeout);
        if (auction.auctionCountdownTimeout) clearTimeout(auction.auctionCountdownTimeout);
        auction.tickTimeout = null;
        auction.auctionCountdownTimeout = null;
        auction.auctionCountdownEndTime = null;
        auction.readyPeople = [];
        broadcast(auction, { type: 'auction_end', reason: 'inactivity_timeout' });
        console.log(`[AUCTION] ${auction.externalId || auction.id} ended after 1 hour with no connected bidders.`);
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
    if (auction.auctionCountdownEndTime && !auction.auctionStartTime) {
        payload.auctionCountdownEndTime = auction.auctionCountdownEndTime;
    }
    return payload;
}

function broadcast(auction, data) {
    const payload = {
        ...data,
        ...auctionPayload(auction)
    };
    if (auction.auctionCountdownEndTime && !auction.auctionStartTime) {
        payload.auctionCountdownEndTime = auction.auctionCountdownEndTime;
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
        timer: auction.timer,
        serverTime: Date.now(),
        chosenPeople: auction.chosenPeople,
        readyPeople: auction.readyPeople,
        ...extra
    });
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
            const database = await initDatabase();
            const tx = database.transaction(() => {
                // Clear dependent historical data first to satisfy FK constraints
                // before replacing the roster.
                database.exec(`
                    DELETE FROM tick_room_people;
                    DELETE FROM tick_room_states;
                    DELETE FROM tick_logs;
                    DELETE FROM auctions;
                    DELETE FROM people;
                    DELETE FROM rooms;
                `);
                const insertPerson = database.prepare('INSERT INTO people (name, emoji, personOrder) VALUES (?, ?, ?)');
                incomingPeople.forEach((p, idx) => insertPerson.run(p.name || '', p.emoji || '', idx));
                const insertRoom = database.prepare('INSERT INTO rooms (name, description, initialPrice, roomOrder) VALUES (?, ?, ?, ?)');
                incomingRooms.forEach((r, idx) => insertRoom.run(r.name || '', r.description || '', Number(r.initialPrice) || 0, idx));
            });
            tx();
            // Stop any live auctions before replacing base config.
            auctions.forEach((auction) => {
                auction.ended = true;
                cancelIdleCloseTimer(auction);
                if (auction.tickTimeout) clearTimeout(auction.tickTimeout);
                if (auction.auctionCountdownTimeout) clearTimeout(auction.auctionCountdownTimeout);
                auction.tickTimeout = null;
                auction.auctionCountdownTimeout = null;
                auction.auctionCountdownEndTime = null;
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
        auction.ended = true;
        if (auction.tickTimeout) clearTimeout(auction.tickTimeout);
        if (auction.auctionCountdownTimeout) clearTimeout(auction.auctionCountdownTimeout);
        auction.auctionCountdownEndTime = null;
        broadcast(auction, { type: 'auction_end' });
        auction.readyPeople = [];
        auction.clients.forEach(client => client.close());
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
                const csv = buildLogCsv(logData);
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
    // Production: serve static files from dist
    server = http.createServer(async (req, res) => {
        if (await handleApi(req, res)) return;
        let filePath = req.url === '/' ? INDEX_FILE : path.join(DIST_DIR, req.url);
        fs.stat(filePath, (err, stats) => {
            if (err || !stats.isFile()) {
                // SPA fallback: serve index.html for non-API routes
                fs.readFile(INDEX_FILE, (readErr, data) => {
                    if (readErr) {
                        res.writeHead(404, { 'Content-Type': 'text/plain' });
                        res.end('404 Not Found');
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(data);
                });
                return;
            }
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes = {
                '.html': 'text/html',
                '.js': 'application/javascript',
                '.css': 'text/css',
                '.svg': 'image/svg+xml',
                '.json': 'application/json',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.ico': 'image/x-icon',
            };
            res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
            fs.createReadStream(filePath).pipe(res);
        });
    });
    console.log('Running in production mode: static files served from dist/.');
}

const wss = new WebSocketServer({ server });
await loadConfigFromDatabase();
server.listen(PORT, () => {
    console.log(`Auction server running on http://localhost:${PORT}`);
});

function updateAuctionLogic(auction) {
    if (!auction.auctionStartTime) {
        console.log('[TICK] Auction not started, skipping tick logic.');
        return;
    }
    // Pricing logic: change = (number of persons choosing the room - 1) * tickAmount
    console.log(`[TICK] Price update at timer=${auction.timer} for ${auction.id}`);
    let newPrices = [...auction.roomPrices];
    auction.roomSelections.forEach((arr, i) => {
        const change = (arr.length - 1) * auction.tickAmount;
        newPrices[i] += change;
    });
    newPrices = newPrices.map(p => Math.round(p));
    console.log(`[TICK] Prices before: ${JSON.stringify(auction.roomPrices)}`);
    console.log(`[TICK] Prices after:  ${JSON.stringify(newPrices)}`);
    auction.roomPrices = newPrices;
    auction.timer += 1;
}

async function ensureLogDir() {
    try {
        await fsp.mkdir(LOG_DIR, { recursive: true });
    } catch {
        // ignore
    }
}

function seedDefaults(database) {
    const settings = database.prepare('SELECT key, value FROM settings').all().reduce((acc, row) => {
        acc[row.key] = row.value;
        return acc;
    }, {});
    if (!settings.tickIntervalMs) {
        database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('tickIntervalMs', String(DEFAULT_TICK_INTERVAL_MS));
    }
    if (!settings.tickAmount) {
        database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('tickAmount', String(DEFAULT_TICK_AMOUNT));
    }
}

function ensureTickSchema(database) {
    const info = database.prepare('PRAGMA table_info(tick_logs)').all();
    const hasJsonCols = info.some(col => col.name === 'prices' || col.name === 'selections');
    const desiredColumns = ['id', 'auctionId', 'tickTime', 'timer'];
    const schemaMismatch = info.length > 0 && (
        info.some(col => !desiredColumns.includes(col.name)) ||
        desiredColumns.some(col => !info.some(c => c.name === col))
    );
    const shouldRebuild = info.length === 0 || hasJsonCols || schemaMismatch;
    if (shouldRebuild) {
        console.warn('[DB] Migrating tick logging schema to normalized tables (dropping old tick data).');
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

function ensureAuctionSchema(database) {
    const info = database.prepare('PRAGMA table_info(auctions)').all();
    const hasExternalId = info.some(col => col.name === 'externalId');
    if (!hasExternalId) {
        console.warn('[DB] Adding externalId column to auctions table.');
        database.exec('ALTER TABLE auctions ADD COLUMN externalId TEXT;');
    }
    database.exec('UPDATE auctions SET externalId = id WHERE externalId IS NULL;');
    database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_auctions_external_id ON auctions(externalId);');
}

async function initDatabase() {
    if (db) return db;
    await ensureLogDir();
    db = new Database(DB_PATH);
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.exec(`
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
    ensureAuctionSchema(db);
    ensureTickSchema(db);
    seedDefaults(db);
    return db;
}

async function loadConfigFromDatabase(options = {}) {
    const { resetDefaultAuction = false } = options;
    const database = await initDatabase();
    const peopleRows = database.prepare('SELECT id, name, emoji FROM people ORDER BY personOrder ASC').all();
    const roomRows = database.prepare('SELECT id, name, description, initialPrice FROM rooms ORDER BY roomOrder ASC').all();
    const tickIntervalRow = database.prepare('SELECT value FROM settings WHERE key = ?').get('tickIntervalMs');
    const tickAmountRow = database.prepare('SELECT value FROM settings WHERE key = ?').get('tickAmount');

    peopleRecords = peopleRows;
    roomRecords = roomRows;
    people = peopleRows.map(({ name, emoji }) => ({ name, emoji }));
    roomNames = roomRows.map(r => r.name);
    roomDescriptions = roomRows.map(r => r.description || '');
    initialPrices = roomRows.map(r => r.initialPrice);
    const parsedInterval = Number(tickIntervalRow?.value ?? DEFAULT_TICK_INTERVAL_MS);
    const parsedTickAmount = Number(tickAmountRow?.value ?? DEFAULT_TICK_AMOUNT);
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
    const hasRoster = peopleRecords.length > 0 && roomRecords.length > 0;
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
    const database = await initDatabase();
    const externalId = auction.externalId || auction.id;
    // Use a stable DB id per public auction key. If a legacy row already exists
    // for this externalId, reuse its id to keep FK relationships valid.
    if (!auction.auctionDbId) {
        const existing = database.prepare('SELECT id FROM auctions WHERE externalId = ? LIMIT 1').get(externalId);
        auction.auctionDbId = existing?.id || externalId;
    }
    const startedAtIso = startTimeMs ? new Date(startTimeMs).toISOString() : new Date().toISOString();
    database.prepare('INSERT OR IGNORE INTO auctions (id, externalId, startedAt) VALUES (?, ?, ?)').run(auction.auctionDbId, externalId, startedAtIso);
    database.prepare('UPDATE auctions SET externalId = ? WHERE id = ?').run(externalId, auction.auctionDbId);
    return database;
}

async function logTick(auction) {
    try {
        await ensureLogDir();
        const database = await ensureAuctionRecord(auction, auction.auctionStartTime);
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
        const tickTime = new Date().toISOString();
        const logTransaction = database.transaction(() => {
            const tickResult = insertTick.run({ auctionId: auction.auctionDbId, tickTime, timer: auction.timer });
            const tickId = tickResult.lastInsertRowid;
            auction.roomSelections.forEach((indices, idx) => {
                const roomMeta = auction.roomRecords[idx];
                if (!roomMeta) return;
                const stateResult = insertRoomState.run({
                    tickId,
                    roomId: roomMeta.id,
                    price: auction.roomPrices[idx] ?? 0
                });
                const tickRoomStateId = stateResult.lastInsertRowid;
                indices.forEach(personIdx => {
                    const personMeta = auction.peopleRecords[personIdx];
                    if (!personMeta) return;
                    insertRoomPerson.run({
                        tickRoomStateId,
                        personId: personMeta.id
                    });
                });
            });
        });
        logTransaction();
    } catch (e) {
        console.error('[LOG] Failed to write log tick to sqlite:', e);
    }
}

async function resolveAuctionDbId(requestedId) {
    const database = await initDatabase();
    const active = getAuctionByKey(requestedId);
    if (active) {
        await ensureAuctionRecord(active, active.auctionStartTime);
        return {
            auctionDbId: active.auctionDbId || active.id || requestedId,
            externalId: active.externalId || active.id || requestedId
        };
    }
    const row = database.prepare('SELECT id, externalId FROM auctions WHERE id = ? OR externalId = ? LIMIT 1').get(requestedId, requestedId);
    if (row) {
        return { auctionDbId: row.id, externalId: row.externalId || requestedId };
    }
    return null;
}

async function readAuctionLog(auctionDbId, externalId) {
    const database = await initDatabase();
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
    const stateIds = roomStateRows.map(r => r.id);
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
    const ticks = tickRows.map(t => ({
        tickId: t.id,
        tickTime: t.tickTime,
        timer: t.timer,
        rooms: statesByTick.get(t.id) || []
    }));
    return {
        auctionId: externalId || auctionDbId,
        auctionDbId,
        auctionExternalId: externalId || null,
        rooms: roomRows,
        people: peopleRows,
        ticks
    };
}

function buildLogCsv(logData) {
    const personLookup = new Map(logData.people.map(p => [p.id, p]));
    const header = ['tickTime', 'timer'];
    logData.rooms.forEach(r => {
        header.push(`${r.name}Price`);
    });
    logData.rooms.forEach(r => {
        header.push(`${r.name}Selectors`);
    });
    const lines = [header.join(',')];
    logData.ticks.forEach(tick => {
        const prices = [];
        const selectors = [];
        logData.rooms.forEach(room => {
            const state = (tick.rooms || []).find(r => r.roomId === room.id);
            prices.push(state ? state.price : '');
            const sel = state ? (state.selectors || []).map(pid => personLookup.get(pid)?.emoji || personLookup.get(pid)?.name || pid).join(';') : '';
            selectors.push(`"${sel}"`);
        });
        lines.push([
            tick.tickTime,
            tick.timer ?? '',
            ...prices,
            ...selectors
        ].join(','));
    });
    return lines.join('\n');
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
    auction.roomSelections = auction.roomSelections.map(arr => arr.filter(i => i !== data.personIdx));
    auction.roomSelections[data.roomIdx].push(data.personIdx);
    maybeLockAllocation(auction);
    sendAuctionState(auction, {
        ...(auction.auctionCountdownEndTime && !auction.auctionStartTime ? { auctionCountdownEndTime: auction.auctionCountdownEndTime } : {})
    });
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
    const currentOwnerEntry = [...auction.clientPersonMap.entries()].find(([, idx]) => idx === data.personIdx);
    if (currentOwnerEntry && currentOwnerEntry[0] !== ws) {
        ws.send(JSON.stringify({ type: 'error', message: 'Person already controlled by another participant.' }));
        return false;
    }
    const prevIdx = auction.clientPersonMap.get(ws);
    if (typeof prevIdx === 'number' && prevIdx !== data.personIdx) {
        auction.chosenPeople = auction.chosenPeople.filter(idx => idx !== prevIdx);
    }
    if (!auction.chosenPeople.includes(data.personIdx)) {
        auction.chosenPeople.push(data.personIdx);
    }
    auction.clientPersonMap.set(ws, data.personIdx);
    sendAuctionState(auction, {
        ...(auction.auctionCountdownEndTime && !auction.auctionStartTime ? { auctionCountdownEndTime: auction.auctionCountdownEndTime } : {})
    });
    return true;
}

function releasePerson(auction, personIdx) {
    if (typeof personIdx !== 'number' || personIdx < 0 || personIdx >= auction.people.length) return false;
    auction.chosenPeople = auction.chosenPeople.filter(idx => idx !== personIdx);
    auction.roomSelections = auction.roomSelections.map(arr => arr.filter(i => i !== personIdx));
    auction.readyPeople = auction.readyPeople.filter(idx => idx !== personIdx);
    if (auction.auctionCountdownTimeout) {
        clearTimeout(auction.auctionCountdownTimeout);
        auction.auctionCountdownTimeout = null;
        auction.auctionCountdownEndTime = null;
    }
    return true;
}

function cleanupIpHistory(now) {
    for (const [ip, timestamps] of ipConnectionHistory.entries()) {
        const recent = timestamps.filter(ts => now - ts < IP_HISTORY_TTL_MS);
        if (recent.length > 0) {
            ipConnectionHistory.set(ip, recent);
        } else {
            ipConnectionHistory.delete(ip);
        }
    }
}

function cleanupApiHistory(now) {
    for (const [ip, timestamps] of apiIpHistory.entries()) {
        const recent = timestamps.filter(ts => now - ts < 60000);
        if (recent.length > 0) {
            apiIpHistory.set(ip, recent);
        } else {
            apiIpHistory.delete(ip);
        }
    }
}

function handleDeselectPerson(auction, ws, data) {
    if (typeof data.personIdx === 'number' && data.personIdx >= 0 && data.personIdx < auction.people.length) {
        if (releasePerson(auction, data.personIdx)) {
            auction.clientPersonMap.delete(ws);
            broadcast(auction, {
                type: 'ready_update',
                readyPeople: auction.readyPeople,
                chosenPeople: auction.chosenPeople,
                ...(auction.auctionCountdownEndTime && !auction.auctionStartTime ? { auctionCountdownEndTime: auction.auctionCountdownEndTime } : {})
            });
            sendAuctionState(auction, {
                ...(auction.auctionCountdownEndTime && !auction.auctionStartTime ? { auctionCountdownEndTime: auction.auctionCountdownEndTime } : {})
            });
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
    if (auction.auctionStartTime) return false;
    if (auction.allocationLocked) return false;
    auction.auctionStartTime = Date.now();
    auction.timer = 0;
    maybeLockAllocation(auction);
    await ensureAuctionRecord(auction, auction.auctionStartTime);
    console.log(`[AUCTION] Auction ${auction.id} started, scheduling first tick.`);
    scheduleNextTick(auction);
    sendAuctionState(auction, {
        ...(auction.auctionCountdownEndTime && !auction.auctionStartTime ? { auctionCountdownEndTime: auction.auctionCountdownEndTime } : {})
    });
    return true;
}

function handleReadyUpdate(auction, ws, data) {
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
    auction.readyPeople = auction.readyPeople.filter(idx => idx !== data.personIdx);
    if (data.ready) {
        auction.readyPeople.push(data.personIdx);
    } else if (auction.auctionCountdownTimeout) {
        clearTimeout(auction.auctionCountdownTimeout);
        auction.auctionCountdownTimeout = null;
        auction.auctionCountdownEndTime = null;
    }
    broadcast(auction, {
        type: 'ready_update',
        readyPeople: auction.readyPeople,
        chosenPeople: auction.chosenPeople,
        ...(auction.auctionCountdownEndTime && !auction.auctionStartTime ? { auctionCountdownEndTime: auction.auctionCountdownEndTime } : {})
    });
    const allClaimed = auction.chosenPeople.length === auction.people.length;
    if (auction.readyPeople.length === auction.people.length && auction.people.length > 0 && allClaimed && !auction.auctionCountdownEndTime && !auction.auctionStartTime && !auction.allocationLocked) {
        auction.auctionCountdownEndTime = Date.now() + 5000;
        broadcast(auction, {
            type: 'auction_countdown',
            countdownEndTime: auction.auctionCountdownEndTime
        });
        auction.auctionCountdownTimeout = setTimeout(async () => {
            auction.auctionStartTime = Date.now();
            auction.timer = 0;
            maybeLockAllocation(auction);
            await ensureAuctionRecord(auction, auction.auctionStartTime);
            auction.auctionCountdownEndTime = null;
            scheduleNextTick(auction);
            sendAuctionState(auction);
        }, 5000);
    }
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
        updateAuctionLogic(auction);
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
        if (auction.auctionCountdownTimeout) clearTimeout(auction.auctionCountdownTimeout);
        auction.auctionCountdownEndTime = null;
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
    if (auction.chosenPeople.length >= auction.people.length) {
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
    incMetric('ws_connects_total');

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
                if (handleReadyUpdate(auction, ws, data)) {
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
            releasePerson(auction, personIdx);
            auction.clientPersonMap.delete(ws);
            broadcast(auction, {
                type: 'ready_update',
                readyPeople: auction.readyPeople,
                chosenPeople: auction.chosenPeople,
                ...(auction.auctionCountdownEndTime && !auction.auctionStartTime ? { auctionCountdownEndTime: auction.auctionCountdownEndTime } : {})
            });
            sendAuctionState(auction);
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
        timer: auction.timer,
        chosenPeople: auction.chosenPeople,
        readyPeople: auction.readyPeople,
        ...(auction.auctionCountdownEndTime && !auction.auctionStartTime ? { auctionCountdownEndTime: auction.auctionCountdownEndTime } : {})
    })));
    broadcast(auction, {
        type: 'ready_update',
        readyPeople: auction.readyPeople,
        chosenPeople: auction.chosenPeople,
        ...(auction.auctionCountdownEndTime && !auction.auctionStartTime ? { auctionCountdownEndTime: auction.auctionCountdownEndTime } : {})
    });
    incMetric('ws_connects_total');
});
