import React, { useEffect, useRef, useState } from "react";
import AuctionView from "./AuctionView";
import {
    advanceAuctionProtocolClock,
    applyAuctionProtocolMessage,
    applyAuctionProtocolSocketError,
    createAuctionProtocolState,
    deriveAuctionProtocolView,
    readyAuctionProtocolPerson,
    selectAuctionProtocolPerson,
    selectAuctionProtocolRoom
} from "./auctionProtocolState.js";
import { API_BASE, getWebSocketUrl } from "./networkConfig";

export default function NetworkAuction({ initialAuctionKey = "", autoCreate = false, onBack }) {
    const [auctionId, setAuctionId] = useState(initialAuctionKey || "");
    const [hoveringKey, setHoveringKey] = useState(false);
    const [connectionError, setConnectionError] = useState(null);
    const [loading, setLoading] = useState(true);
    const [protocolState, setProtocolState] = useState(() => createAuctionProtocolState());
    const reconnectTimeoutRef = useRef(null);
    const wsRef = useRef(null);
    const autoCreatedRef = useRef(false);
    const blockReconnectRef = useRef(false);

    const {
        people,
        roomNames,
        roomDescriptions,
        tickIntervalMs,
        stage,
        selectedPerson,
        roomPrices,
        roomSelections,
        timer,
        userRoom,
        auctionStartTime,
        smoothProgress,
        allocationFound,
        nextTickChanges,
        actionError,
        auctionEnded,
        chosenPeople,
        auctionCountdownEndTime,
        auctionPaused
    } = protocolState;
    const protocolView = deriveAuctionProtocolView(protocolState);

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
            setProtocolState(prev => ({ ...prev, auctionEnded: false }));
            setLoading(false);
        };
        ws.onmessage = (event) => {
            setLoading(false);
            try {
                const data = JSON.parse(event.data);
                setProtocolState(prev => {
                    const result = applyAuctionProtocolMessage(prev, data);
                    if (result.blockReconnect) {
                        blockReconnectRef.current = true;
                    }
                    return result.state;
                });
            } catch (e) {
                setConnectionError("Received invalid data from server.");
                console.error("WebSocket message error:", e);
            }
        };
        ws.onerror = (err) => {
            setLoading(false);
            setConnectionError("WebSocket error: " + (err.message || "connection issue"));
            setProtocolState(prev => applyAuctionProtocolSocketError(prev));
        };
        ws.onclose = () => {
            setLoading(false);
            setConnectionError("WebSocket connection closed.");
            setProtocolState(prev => applyAuctionProtocolSocketError(prev));
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
            setProtocolState(prev => ({ ...prev, smoothProgress: progress }));
            frame = requestAnimationFrame(animate);
        }
        frame = requestAnimationFrame(animate);
        return () => cancelAnimationFrame(frame);
    }, [auctionStartTime, tickIntervalMs]);

    useEffect(() => {
        if (!auctionCountdownEndTime) return;
        const msLeft = auctionCountdownEndTime - Date.now();
        if (msLeft <= 0) {
            setProtocolState(prev => advanceAuctionProtocolClock(prev));
            return;
        }
        const timeout = setTimeout(() => {
            setProtocolState(prev => advanceAuctionProtocolClock(prev));
        }, msLeft);
        const interval = setInterval(() => setProtocolState(prev => ({ ...prev, timer: Date.now() })), 200);
        return () => {
            clearTimeout(timeout);
            clearInterval(interval);
        };
    }, [auctionCountdownEndTime]);

    function handlePersonSelect(idx) {
        if (idx < 0 || idx >= people.length) return;
        setProtocolState(prev => selectAuctionProtocolPerson(prev, idx));
        wsRef.current?.send(JSON.stringify({
            type: "select_person",
            personIdx: idx
        }));
    }

    function handleRoomSelect(idx) {
        if (idx < 0 || idx >= roomNames.length) return;
        setProtocolState(prev => selectAuctionProtocolRoom(prev, idx));
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
                setProtocolState(prev => ({ ...prev, actionError: json.error || "Failed to create auction" }));
                setLoading(false);
                return;
            }
            const newKey = json.externalId || json.publicId || json.auctionId;
            setAuctionId(newKey);
            setProtocolState(prev => ({ ...prev, actionError: null }));
        } catch {
            setProtocolState(prev => ({ ...prev, actionError: "Failed to create auction" }));
        } finally {
            setLoading(false);
        }
    }

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
                {protocolView.showCountdown && (
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
                            {protocolView.countdownSeconds > 0 ? protocolView.countdownSeconds : 'Go!'}
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
                    allRoomsSelected={protocolView.allRoomsSelected}
                    readyUI={
                        protocolView.showReadyButton ? (
                            <div style={{ textAlign: 'center', width: '100%' }}>
                                <button
                                    style={{ fontSize: '1.2em', padding: '0.5em 1.5em', background: '#1976d2', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', margin: 0 }}
                                    onClick={() => {
                                        setProtocolState(prev => readyAuctionProtocolPerson(prev));
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
                                    {protocolView.readyCountLabel}
                                </div>
                            </div>
                        ) : protocolView.showReadyMessage ? (
                            <div style={{ textAlign: 'center', width: '100%' }}>
                                <div style={{ color: '#4caf50', fontWeight: 'bold', margin: 0 }}>
                                    Ready!
                                </div>
                                <div style={{ marginTop: 8, fontSize: '0.9em' }}>
                                    {protocolView.readyCountLabel}
                                </div>
                            </div>
                        ) : null
                    }
                />
                {(protocolView.showAuctionIdHint || protocolView.showEndedHint) && (
                    <div style={{ color: '#d32f2f', marginTop: 8 }}>
                        {protocolView.showAuctionIdHint && <div>Enter a valid auction key or try another.</div>}
                        {protocolView.showEndedHint && <div>The auction has ended. Create or join another auction.</div>}
                        {protocolView.showOwnershipHint && <div>Pick an available person you control; someone else already controls that person.</div>}
                        {protocolView.showFullHint && <div>The auction is full. Rejoin after a slot opens or host creates a new auction.</div>}
                    </div>
                )}
            </main>
        </div>
    );
}
