import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE } from './networkConfig';

function formatNumber(n) {
    return typeof n === 'number' ? Number(n).toLocaleString() : '-';
}

export default function RoomLogVisualiser({ onBack }) {
    const [auctionId, setAuctionId] = useState('');
    const [logData, setLogData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [tick, setTick] = useState(0);
    const [playing, setPlaying] = useState(false);
    const playTimeout = useRef(null);

    const maxTicks = logData?.ticks?.length || 0;

    useEffect(() => {
        if (!playing || maxTicks === 0) return;
        playTimeout.current = setTimeout(() => {
            setTick(t => (t >= maxTicks - 1 ? t : t + 1));
        }, 700);
        return () => clearTimeout(playTimeout.current);
    }, [playing, tick, maxTicks]);

    useEffect(() => {
        if (tick >= maxTicks) setTick(Math.max(0, maxTicks - 1));
    }, [tick, maxTicks]);

    const roomSeries = useMemo(() => {
        if (!logData) return [];
        const personLookup = new Map(logData.people.map(p => [p.id, p]));
        return logData.rooms.map((room, idx) => {
            const series = logData.ticks.map(t => {
                const state = (t.rooms || []).find(r => r.roomId === room.id) || {};
                return {
                    price: typeof state.price === 'number' ? state.price : null,
                    selectors: (state.selectors || []).map(pid => personLookup.get(pid)?.emoji || personLookup.get(pid)?.name || String(pid)),
                    tickTime: t.tickTime,
                    timer: typeof t.timer === 'number' ? t.timer : null,
                };
            });
            return { room, series, idx };
        });
    }, [logData]);

    const yBounds = useMemo(() => {
        if (!roomSeries.length) return { minY: 0, maxY: 1 };
        const prices = roomSeries.flatMap(r => r.series.map(p => p.price).filter(p => typeof p === 'number'));
        if (!prices.length) return { minY: 0, maxY: 1 };
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        const pad = Math.max(5, (max - min) * 0.05);
        return { minY: min - pad, maxY: max + pad };
    }, [roomSeries]);

    async function loadLogs() {
        const targetId = auctionId.trim();
        if (!targetId) {
            setError('Set an auction ID to load logs.');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`${API_BASE}/api/admin/auctions/${encodeURIComponent(targetId)}/logs`);
            const json = await res.json();
            if (!res.ok) {
                setError(json.error || 'Failed to load logs');
                setLogData(null);
                return;
            }
            setLogData(json);
            setPlaying(false);
            setTick(0);
        } catch {
            setError('Failed to load logs');
            setLogData(null);
        } finally {
            setLoading(false);
        }
    }

    function renderChart() {
        if (!roomSeries.length) return <div style={{ color: '#666' }}>No log data loaded.</div>;
        const width = 1000;
        const height = 500;
        const xStart = -0.1;
        const xEnd = Math.max(2, maxTicks + 1);

        const range = Math.max(1, yBounds.maxY - yBounds.minY);
        const roomData = roomSeries.map(({ room, series, idx }) => {
            const points = series.slice(0, tick + 1).map((data, t) => {
                const price = typeof data.price === 'number' ? data.price : yBounds.minY;
                const x = 40 + ((t - xStart) / (xEnd - xStart)) * 920;
                const y = height - 20 - ((price - yBounds.minY) / range) * (height - 40);
                return { x, y };
            });
            const colors = series.slice(1, tick + 1).map(data => {
                const n = data.selectors.length;
                if (n === 0) return '#888';
                if (n === 1) return '#1db954';
                return '#e53935';
            });
            return { room, points, colors, selectors: series[tick]?.selectors || [], idx };
        });

        const priceGroups = {};
        const epsilon = 12.5;
        roomData.forEach((rd, i) => {
            const data = rd.points[rd.points.length - 1];
            if (!data) return;
            const price = logData.ticks[tick]?.rooms?.find(r => r.roomId === rd.room.id)?.price;
            if (typeof price !== 'number') return;
            let found = false;
            for (const key in priceGroups) {
                if (Math.abs(Number(key) - price) < epsilon) {
                    priceGroups[key].push(i);
                    found = true;
                    break;
                }
            }
            if (!found) priceGroups[price] = [i];
        });
        const markerJitter = new Array(roomData.length).fill(0);
        const jitterGap = 38;
        for (const group of Object.values(priceGroups)) {
            if (group.length > 1) {
                const n = group.length;
                for (let k = 0; k < n; ++k) {
                    markerJitter[group[k]] = (k - (n - 1) / 2) * jitterGap;
                }
            }
        }

        const tickStep = 25;
        const topTick = Math.ceil(yBounds.maxY / tickStep) * tickStep;
        const bottomTick = Math.floor(yBounds.minY / tickStep) * tickStep;
        const ticks = [];
        for (let v = topTick; v >= bottomTick; v -= tickStep) ticks.push(v);

        return (
            <svg width={width} height={height} aria-label="Line chart for all rooms" tabIndex={0} style={{ background: '#fff', borderRadius: 8, boxShadow: '0 2px 8px #0001' }}>
                <defs>
                    <filter id="markerShadow" x="-20%" y="-20%" width="140%" height="140%">
                        <feDropShadow dx="0" dy="2" stdDeviation="2" floodColor="#000" floodOpacity="0.18" />
                    </filter>
                </defs>
                <line x1={40} y1={20} x2={40} y2={height - 20} stroke="#aaa" />
                {ticks.map(v => {
                    const y = height - 20 - ((v - yBounds.minY) / (yBounds.maxY - yBounds.minY)) * (height - 40);
                    return (
                        <g key={v}>
                            <line x1={35} y1={y} x2={40} y2={y} stroke="#aaa" />
                            <text x={30} y={y + 4} fill="#aaa" fontSize={14} textAnchor="end">{v}</text>
                        </g>
                    );
                })}
                <line x1={40} y1={height - 20} x2={width - 40} y2={height - 20} stroke="#aaa" />
                {roomData.map(({ room, points, colors }) => {
                    const segs = [];
                    if (points.length > 1) {
                        for (let i = 1; i < points.length; ++i) {
                            const a = points[i - 1];
                            const b = points[i];
                            segs.push(<path key={`seg-${room.id}-${i}`} d={`M${a.x},${a.y} L${b.x},${b.y}`} fill="none" stroke={colors[i - 1]} strokeWidth={3} />);
                        }
                    }
                    return <g key={`line-${room.id}`}>{segs}</g>;
                })}
                {roomData.map(({ room, points, selectors }, idx) => {
                    if (!points.length) return null;
                    const last = points[points.length - 1];
                    const jitter = markerJitter[idx];
                    let borderColor = '#888';
                    if (selectors.length === 1) borderColor = '#1db954';
                    else if (selectors.length > 1) borderColor = '#e53935';
                    const flagPos = selectors.map((_, i) => ({ x: (i - (selectors.length - 1) / 2) * 12, y: -4, scale: selectors.length > 3 ? 0.85 : 1 }));
                    return (
                        <g key={`marker-${room.id}`} transform={`translate(${last.x + jitter},${last.y})`}>
                            <circle r={18} fill="#fff" filter="url(#markerShadow)" stroke={borderColor} strokeWidth={3} />
                            <text x={0} y={-22} fontSize={18} fontWeight="bold" textAnchor="middle" fill="#222">{idx + 1}</text>
                            {selectors.map((emoji, i) => {
                                const { x, y, scale } = flagPos[i];
                                return (
                                    <g key={`${room.id}-flag-${i}`} transform={`translate(${x},${y}) scale(${scale})`}>
                                        <text x={0} y={7} fontSize={16} textAnchor="middle" alignmentBaseline="middle" role="img" aria-label={`${emoji} flag`}>
                                            {emoji}
                                        </text>
                                    </g>
                                );
                            })}
                        </g>
                    );
                })}
            </svg>
        );
    }

    return (
        <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: 16, color: '#000', padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div>
                    <h1 style={{ margin: 0 }}>Room Log Visualiser</h1>
                    <div style={{ color: '#666' }}>Inspect historical room prices and selections by tick.</div>
                </div>
                {onBack && (
                    <button
                        onClick={onBack}
                        style={{ padding: '0.6em 0.9em', borderRadius: 8, border: '1px solid #d5dce5', background: '#fff', cursor: 'pointer' }}
                    >
                        ← Back
                    </button>
                )}
            </div>

            <div className="panel" style={{ border: '1px solid #e0e6ed', borderRadius: 10, padding: 16, boxShadow: '0 2px 8px #0000000c' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
                    <input
                        type="text"
                        placeholder="Auction ID (short key or DB id)"
                        value={auctionId}
                        onChange={e => setAuctionId(e.target.value)}
                        style={{ flex: 1, minWidth: 260, padding: '0.6em 0.7em', borderRadius: 8, border: '1px solid #d5dce5' }}
                    />
                    <button
                        onClick={loadLogs}
                        disabled={loading}
                        style={{ padding: '0.6em 1em', borderRadius: 8, border: '1px solid #d5dce5', background: '#f5f7fa', fontWeight: 600, cursor: loading ? 'default' : 'pointer' }}
                    >
                        {loading ? 'Loading…' : 'Load logs'}
                    </button>
                </div>

                {error && <div style={{ color: '#d32f2f', marginBottom: 10, fontWeight: 600 }}>{error}</div>}
                {logData && (
                    <div style={{ marginBottom: 12, color: '#444' }}>
                        <div>Auction ID: {logData.auctionExternalId || logData.auctionId || auctionId || 'unknown'}</div>
                        <div>DB ID: {logData.auctionDbId || 'unknown'}</div>
                        <div>Rooms: {logData.rooms.length}, People: {logData.people.length}, Ticks: {maxTicks}</div>
                    </div>
                )}

                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
                    <button onClick={() => setPlaying(p => !p)} disabled={!logData} style={{ padding: '0.5em 1em', borderRadius: 8, border: '1px solid #d5dce5', background: '#fff' }}>
                        {playing ? 'Pause' : 'Play'}
                    </button>
                    <button onClick={() => setTick(t => Math.max(0, t - 1))} disabled={!logData || tick <= 0} style={{ padding: '0.5em 0.9em', borderRadius: 8, border: '1px solid #d5dce5', background: '#fff' }}>Prev</button>
                    <button onClick={() => setTick(t => Math.min(maxTicks - 1, t + 1))} disabled={!logData || tick >= maxTicks - 1} style={{ padding: '0.5em 0.9em', borderRadius: 8, border: '1px solid #d5dce5', background: '#fff' }}>Next</button>
                    <button onClick={() => setTick(0)} disabled={!logData} style={{ padding: '0.5em 0.9em', borderRadius: 8, border: '1px solid #d5dce5', background: '#fff' }}>Reset</button>
                    <span style={{ fontWeight: 600 }}>Tick: {tick}/{Math.max(0, maxTicks - 1)}</span>
                    {logData?.ticks?.[tick]?.tickTime && (
                        <span style={{ color: '#666' }}>
                            at {new Date(logData.ticks[tick].tickTime).toLocaleString()} (t={logData.ticks[tick].timer ?? '?'})
                        </span>
                    )}
                </div>

                <div style={{ overflowX: 'auto' }}>
                    {renderChart()}
                </div>
            </div>

            {logData && (
                <div className="panel" style={{ border: '1px solid #e0e6ed', borderRadius: 10, padding: 16, boxShadow: '0 2px 8px #0000000c' }}>
                    <h3 style={{ marginTop: 0, marginBottom: 10 }}>Latest Tick Snapshot</h3>
                    <table style={{ borderCollapse: 'collapse', width: '100%', maxWidth: 900 }}>
                        <thead>
                            <tr>
                                <th style={{ borderBottom: '1px solid #ddd', textAlign: 'left', paddingBottom: 6 }}>Room</th>
                                <th style={{ borderBottom: '1px solid #ddd', textAlign: 'left', paddingBottom: 6 }}>Price</th>
                                <th style={{ borderBottom: '1px solid #ddd', textAlign: 'left', paddingBottom: 6 }}>Selectors</th>
                            </tr>
                        </thead>
                        <tbody>
                            {roomSeries.map(({ room, series }) => {
                                const entry = series[tick] || {};
                                return (
                                    <tr key={room.id}>
                                        <td style={{ borderBottom: '1px solid #eee', padding: '8px 0' }}>{room.name}</td>
                                        <td style={{ borderBottom: '1px solid #eee', padding: '8px 0' }}>£{formatNumber(entry.price)}</td>
                                        <td style={{ borderBottom: '1px solid #eee', padding: '8px 0' }}>{(entry.selectors || []).join(' ') || '—'}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
