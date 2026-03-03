import React, { useEffect, useRef, useState } from "react";
import AuctionView from "./AuctionView";
import { API_BASE, getWebSocketUrl } from "./networkConfig";

export default function NetworkAuction({ initialAuctionKey = "", autoCreate = false, onBack }) {
    const [auctionId, setAuctionId] = useState(initialAuctionKey || "");
    const [hoveringKey, setHoveringKey] = useState(false);
    const [people, setPeople] = useState([]);
    const [roomNames, setRoomNames] = useState([]);
    const [roomDescriptions, setRoomDescriptions] = useState([]);
    const [tickIntervalMs, setTickIntervalMs] = useState(10000);
    const [tickAmount, setTickAmount] = useState(1);
    const [stage, setStage] = useState("select");
    const [selectedPerson, setSelectedPerson] = useState(null);
    const [roomPrices, setRoomPrices] = useState([]);
    const [roomSelections, setRoomSelections] = useState([]);
    const [timer, setTimer] = useState(0);
    const [userRoom, setUserRoom] = useState(null);
    const [auctionStartTime, setAuctionStartTime] = useState(null);
    const [smoothProgress, setSmoothProgress] = useState(0);
    const [allocationFound, setAllocationFound] = useState(false);
    const [nextTickChanges, setNextTickChanges] = useState([]);
    const [connectionError, setConnectionError] = useState(null);
    const [actionError, setActionError] = useState(null);
    const [auctionEnded, setAuctionEnded] = useState(false);
    const [loading, setLoading] = useState(true);
    const [chosenPeople, setChosenPeople] = useState([]);
    const [ready, setReady] = useState(false);
    const [readyPeople, setReadyPeople] = useState([]);
    const [auctionCountdownEndTime, setAuctionCountdownEndTime] = useState(null);
    const [auctionPaused, setAuctionPaused] = useState(false);
    const [auctionStarted, _setAuctionStarted] = useState(false);
    const setAuctionStarted = (val) => _setAuctionStarted(val);
    const reconnectTimeoutRef = useRef(null);
    const wsRef = useRef(null);
    const autoCreatedRef = useRef(false);
    const blockReconnectRef = useRef(false);

    useEffect(() => {
        setAuctionId(initialAuctionKey || "");
    }, [initialAuctionKey]);

    function connectWebSocket() {
        if (!auctionId) return;
        // When creating a new socket, detach handlers from any previous socket
        // so its close event cannot schedule stale reconnect attempts.
        if (wsRef.current) {
            wsRef.current.onopen = null;
            wsRef.current.onmessage = null;
            wsRef.current.onerror = null;
            wsRef.current.onclose = null;
            wsRef.current.close();
        }
        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
        }
        blockReconnectRef.current = false;
        setLoading(true);
        const ws = new window.WebSocket(getWebSocketUrl(auctionId));
        wsRef.current = ws;
        ws.onopen = () => {
            setConnectionError(null);
            setAuctionEnded(false);
            setLoading(false);
        };
        ws.onmessage = (event) => {
            setLoading(false);
            try {
                const data = JSON.parse(event.data);
                const hasCountdownField = Object.prototype.hasOwnProperty.call(data, "auctionCountdownEndTime");
                if (data.type === "auction_update") {
                    if (Array.isArray(data.people)) setPeople(data.people);
                    if (Array.isArray(data.roomNames)) setRoomNames(data.roomNames);
                    if (Array.isArray(data.roomDescriptions)) setRoomDescriptions(data.roomDescriptions);
                    if (typeof data.tickIntervalMs === "number") setTickIntervalMs(data.tickIntervalMs);
                    if (typeof data.tickAmount === "number") setTickAmount(data.tickAmount);
                    if (Array.isArray(data.readyPeople)) setReadyPeople(data.readyPeople);
                    const nextSelections = Array.isArray(data.roomSelections) ? data.roomSelections : [];
                    if (Array.isArray(data.roomPrices)) setRoomPrices(data.roomPrices);
                    setRoomSelections(nextSelections);
                    setSmoothProgress(data.smoothProgress);
                    setAuctionStartTime(data.auctionStartTime);
                    setAuctionStarted(!!data.auctionStartTime);
                    setAuctionPaused(!!data.auctionPaused);
                    setTimer(data.timer);
                    setNextTickChanges(nextSelections.map(arr => (arr.length - 1) * (typeof data.tickAmount === "number" ? data.tickAmount : tickAmount)));
                    setAllocationFound(
                        nextSelections.length > 0 &&
                        nextSelections.every(arr => arr.length === 1) &&
                        nextSelections.flat().length === (data.people ? data.people.length : people.length)
                    );
                    setAuctionEnded(false);
                    setChosenPeople(data.chosenPeople || []);
                    setAuctionCountdownEndTime(hasCountdownField ? data.auctionCountdownEndTime : null);
                    if (data.auctionPaused) {
                        setReady(false);
                        setAuctionCountdownEndTime(null);
                        setActionError(null);
                    } else if (data.auctionStartTime) {
                        setActionError(null);
                    }
                } else if (data.type === "ready_update") {
                    if (Array.isArray(data.people)) setPeople(data.people);
                    if (Array.isArray(data.roomNames)) setRoomNames(data.roomNames);
                    if (Array.isArray(data.roomDescriptions)) setRoomDescriptions(data.roomDescriptions);
                    if (typeof data.tickIntervalMs === "number") setTickIntervalMs(data.tickIntervalMs);
                    if (typeof data.tickAmount === "number") setTickAmount(data.tickAmount);
                    setReadyPeople(data.readyPeople || []);
                    setChosenPeople(data.chosenPeople || []);
                    setAuctionCountdownEndTime(hasCountdownField ? data.auctionCountdownEndTime : null);
                } else if (data.type === "auction_countdown") {
                    setAuctionCountdownEndTime(data.countdownEndTime);
                } else if (data.type === "auction_paused") {
                    setAuctionPaused(true);
                    setAuctionStarted(false);
                    setAuctionCountdownEndTime(null);
                    setReady(false);
                    setActionError(null);
                } else if (data.type === "auction_end") {
                    setAuctionEnded(true);
                    setActionError("Auction ended. Join or create a new auction to continue.");
                    setSelectedPerson(null);
                    setStage("select");
                } else if (data.type === "error") {
                    const msg = data.message || "Server rejected your action.";
                    setActionError(msg);
                    if (msg.toLowerCase().includes("unknown auction")) {
                        blockReconnectRef.current = true;
                    }
                    if (msg.toLowerCase().includes("ended")) {
                        setStage("select");
                        blockReconnectRef.current = true;
                    }
                    // Stop retry storms on server-side hard rejections.
                    if (
                        msg.toLowerCase().includes("unauthorized") ||
                        msg.toLowerCase().includes("auction is full") ||
                        msg.toLowerCase().includes("rate limit") ||
                        msg.toLowerCase().includes("roster empty") ||
                        msg.toLowerCase().includes("no person selected in time")
                    ) {
                        blockReconnectRef.current = true;
                    }
                }
            } catch (e) {
                setConnectionError("Received invalid data from server.");
                console.error("WebSocket message error:", e);
            }
        };
        ws.onerror = (err) => {
            setLoading(false);
            setConnectionError("WebSocket error: " + (err.message || "connection issue"));
            setSelectedPerson(null);
            setStage("select");
        };
        ws.onclose = () => {
            setLoading(false);
            setConnectionError("WebSocket connection closed.");
            setSelectedPerson(null);
            setStage("select");
            if (auctionId && !blockReconnectRef.current) {
                reconnectTimeoutRef.current = setTimeout(() => {
                    connectWebSocket();
                }, 3000);
            }
        };
    }

    useEffect(() => {
        if (!auctionId) return;
        connectWebSocket();
        return () => {
            blockReconnectRef.current = true;
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
                reconnectTimeoutRef.current = null;
            }
            if (wsRef.current) {
                wsRef.current.onopen = null;
                wsRef.current.onmessage = null;
                wsRef.current.onerror = null;
                wsRef.current.onclose = null;
                wsRef.current.close();
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [auctionId]);

    useEffect(() => {
        if (!autoCreate) return;
        if (autoCreatedRef.current) return;
        autoCreatedRef.current = true;
        handleCreateAuction();
    }, [autoCreate]);

    useEffect(() => {
        if (!auctionStartTime) return;
        let frame;
        function animate() {
            const now = Date.now();
            const cycleMs = tickIntervalMs || 10000;
            const elapsedMs = (now - auctionStartTime) % cycleMs;
            const progress = elapsedMs / cycleMs;
            setSmoothProgress(progress);
            frame = requestAnimationFrame(animate);
        }
        frame = requestAnimationFrame(animate);
        return () => cancelAnimationFrame(frame);
    }, [auctionStartTime, tickIntervalMs]);

    useEffect(() => {
        if (selectedPerson !== null && (selectedPerson < 0 || selectedPerson >= people.length)) {
            setSelectedPerson(null);
        }
        if (userRoom !== null && (userRoom < 0 || userRoom >= roomNames.length)) {
            setUserRoom(null);
        }
    }, [people, roomNames, selectedPerson, userRoom]);

    useEffect(() => {
        if (selectedPerson === null) {
            setUserRoom(null);
            return;
        }
        const roomIdx = roomSelections.findIndex(selection => selection.includes(selectedPerson));
        setUserRoom(roomIdx >= 0 ? roomIdx : null);
    }, [selectedPerson, roomSelections]);

    useEffect(() => {
        if (selectedPerson === null) {
            setReady(false);
            return;
        }
        setReady(readyPeople.includes(selectedPerson));
    }, [readyPeople, selectedPerson]);

    useEffect(() => {
        if (!auctionCountdownEndTime) return;
        const msLeft = auctionCountdownEndTime - Date.now();
        if (msLeft <= 0) {
            setAuctionCountdownEndTime(null);
            setReady(false);
            setAuctionStarted(true);
            return;
        }
        const timeout = setTimeout(() => {
            setAuctionCountdownEndTime(null);
            setReady(false);
            setAuctionStarted(true);
        }, msLeft);
        const interval = setInterval(() => setTimer(Date.now()), 200);
        return () => {
            clearTimeout(timeout);
            clearInterval(interval);
        };
    }, [auctionCountdownEndTime]);

    function handlePersonSelect(idx) {
        if (idx < 0 || idx >= people.length) return;
        setSelectedPerson(idx);
        wsRef.current?.send(JSON.stringify({
            type: "select_person",
            personIdx: idx
        }));
        setStage("auction");
    }

    function handleRoomSelect(idx) {
        if (idx < 0 || idx >= roomNames.length) return;
        setUserRoom(idx);
        setActionError(null);
        if (selectedPerson !== null) {
            wsRef.current?.send(JSON.stringify({
                type: "select_room",
                personIdx: selectedPerson,
                roomIdx: idx
            }));
        }
    }

    function handleReconnectClick() {
        setConnectionError(null);
        blockReconnectRef.current = false;
        connectWebSocket();
    }

    async function handleCopyAuctionLink() {
        if (!auctionId) return;
        const url = `${window.location.origin}${window.location.pathname}#/auction/${auctionId}`;
        try {
            await navigator.clipboard.writeText(url);
        } catch {
            // ignore clipboard failures silently for now
        }
    }

    async function handleCreateAuction() {
        try {
            setLoading(true);
            const res = await fetch(`${API_BASE}/api/auctions`, { method: "POST" });
            const json = await res.json();
            if (!res.ok) {
                setActionError(json.error || "Failed to create auction");
                setLoading(false);
                return;
            }
            const newKey = json.externalId || json.publicId || json.auctionId;
            setAuctionId(newKey);
            setActionError(null);
        } catch {
            setActionError("Failed to create auction");
        } finally {
            setLoading(false);
        }
    }

    const totalPeople = people.length;
    const allRoomsSelected = totalPeople > 0 && roomSelections.flat().length === totalPeople;
    const showReadyButton = allRoomsSelected && selectedPerson !== null && userRoom !== null && !ready && !auctionCountdownEndTime;
    const showCountdown = !!auctionCountdownEndTime;
    let countdownSeconds = 0;
    if (auctionCountdownEndTime) {
        countdownSeconds = Math.max(0, Math.ceil((auctionCountdownEndTime - Date.now()) / 1000));
    }

    const lowerActionError = (actionError || "").toLowerCase();
    const showAuctionIdHint = lowerActionError.includes("unknown auction");
    const showEndedHint = lowerActionError.includes("ended");
    const showOwnershipHint = lowerActionError.includes("person already controlled") || lowerActionError.includes("only move the person you control");
    const showFullHint = lowerActionError.includes("auction is full");

    return (
        <div style={{ width: '100%', maxWidth: 'min(1400px, calc(100vw - 32px))', margin: '0 auto', padding: 16, boxSizing: 'border-box' }}>
            <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                {onBack ? (
                    <button onClick={onBack} style={{ padding: '0.5em 0.9em', borderRadius: 8, border: '1px solid #d5dce5', background: '#fff' }}>
                        ← Back
                    </button>
                ) : <span />}
                <button onClick={connectWebSocket} style={{ padding: '0.5em 0.9em', borderRadius: 8, border: '1px solid #d5dce5', background: '#f5f7fa', fontWeight: 600 }}>
                    Reconnect
                </button>
            </div>

            <div style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 700 }}>Auction key:</div>
                <span style={{ position: 'relative', display: 'inline-block' }}>
                    <button
                        type="button"
                        onClick={handleCopyAuctionLink}
                        onMouseEnter={() => setHoveringKey(true)}
                        onMouseLeave={() => setHoveringKey(false)}
                        disabled={!auctionId}
                        style={{
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                            background: hoveringKey && auctionId ? '#dbe1ea' : '#e8edf3',
                            color: auctionId ? '#111' : '#666',
                            padding: '5px 8px',
                            borderRadius: 6,
                            border: '1px solid #c8d0dc',
                            cursor: auctionId ? 'copy' : 'default',
                            fontWeight: 600
                        }}
                        aria-label={auctionId ? 'Copy auction link' : 'Auction key unavailable'}
                    >
                        {auctionId || '—'}
                    </button>
                    {hoveringKey && auctionId && (
                        <span
                            style={{
                                position: 'absolute',
                                top: 'calc(100% + 6px)',
                                left: '50%',
                                transform: 'translateX(-50%)',
                                background: '#1f2937',
                                color: '#fff',
                                fontSize: 12,
                                padding: '4px 8px',
                                borderRadius: 6,
                                fontWeight: 600,
                                whiteSpace: 'nowrap',
                                zIndex: 5
                            }}
                        >
                            Copy link
                        </span>
                    )}
                </span>
            </div>

            <main aria-live="polite" aria-busy={loading} style={{ border: '1px solid #eee', padding: 12, borderRadius: 8 }}>
                {loading && (
                    <div style={{ color: 'blue', marginBottom: '1em', textAlign: 'center' }} role="status">
                        {auctionId ? 'Connecting to auction server...' : 'No auction key provided.'}
                    </div>
                )}
                {connectionError && (
                    <div style={{ color: 'red', marginBottom: '1em', textAlign: 'center' }} role="alert">
                        {connectionError}
                        <button style={{ marginLeft: '1em' }} onClick={handleReconnectClick} aria-label="Reconnect to auction server">
                            Reconnect
                        </button>
                    </div>
                )}
                {actionError && (
                    <div style={{ color: 'orange', marginBottom: '1em', textAlign: 'center' }} role="alert">
                        {actionError}
                    </div>
                )}
                {auctionEnded && (
                    <div style={{ color: 'green', marginBottom: '1em', textAlign: 'center' }} role="status">
                        Auction has ended. Thank you for participating!
                    </div>
                )}
                {auctionPaused && !auctionEnded && (
                    <div style={{ color: '#8a4b00', marginBottom: '1em', textAlign: 'center', fontWeight: 700 }} role="status">
                        Auction paused. All bidders must be ready to resume.
                    </div>
                )}
                {showCountdown && (
                    <div style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        width: '100vw',
                        height: '100vh',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        pointerEvents: 'none',
                        zIndex: 9999
                    }}>
                        <div style={{
                            fontSize: '10vw',
                            fontWeight: 'bold',
                            color: '#1976d2',
                            textAlign: 'center',
                            textShadow: '0 2px 12px #888',
                            background: 'none'
                        }}>
                            {countdownSeconds > 0 ? countdownSeconds : 'Go!'}
                        </div>
                    </div>
                )}
                <AuctionView
                    people={people}
                    roomNames={roomNames}
                    roomDescriptions={roomDescriptions}
                    stage={stage}
                    selectedPerson={selectedPerson}
                    roomPrices={roomPrices}
                    roomSelections={roomSelections}
                    timer={timer}
                    userRoom={userRoom}
                    auctionStartTime={auctionStartTime}
                    smoothProgress={smoothProgress}
                    allocationFound={allocationFound}
                    nextTickChanges={nextTickChanges}
                    onPersonSelect={handlePersonSelect}
                    onRoomSelect={handleRoomSelect}
                    chosenPeople={chosenPeople}
                    allRoomsSelected={allRoomsSelected}
                    readyUI={
                        (showReadyButton && !auctionStarted) ? (
                            <div style={{ textAlign: 'center', width: '100%' }}>
                                <button
                                    style={{ fontSize: '1.2em', padding: '0.5em 1.5em', background: '#1976d2', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', margin: 0 }}
                                    onClick={() => {
                                        setReady(true);
                                        wsRef.current?.send(JSON.stringify({
                                            type: "set_ready",
                                            personIdx: selectedPerson,
                                            ready: true
                                        }));
                                    }}
                                >
                                    I'm ready to start
                                </button>
                                <div style={{ marginTop: 8, fontSize: '0.9em' }}>
                                    {readyPeople.length}/{totalPeople || '?'} bidders ready
                                </div>
                            </div>
                        ) : (ready && !auctionCountdownEndTime && !auctionStarted) ? (
                            <div style={{ textAlign: 'center', width: '100%' }}>
                                <div style={{ color: '#4caf50', fontWeight: 'bold', margin: 0 }}>
                                    Ready!
                                </div>
                                <div style={{ marginTop: 8, fontSize: '0.9em' }}>
                                    {readyPeople.length}/{totalPeople || '?'} bidders ready
                                </div>
                            </div>
                        ) : null
                    }
                />
                {(showAuctionIdHint || showEndedHint) && (
                    <div style={{ color: '#d32f2f', marginTop: 8 }}>
                        {showAuctionIdHint && <div>Enter a valid auction key or try another.</div>}
                        {showEndedHint && <div>The auction has ended. Create or join another auction.</div>}
                        {showOwnershipHint && <div>Pick an available person you control; someone else already controls that person.</div>}
                        {showFullHint && <div>The auction is full. Rejoin after a slot opens or host creates a new auction.</div>}
                    </div>
                )}
            </main>
        </div>
    );
}
