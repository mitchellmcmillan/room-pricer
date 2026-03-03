import React, { useEffect, useState } from 'react';
import './App.css';
import './fill-root.css';
import NetworkAuction from './NetworkAuction';
import RoomLogVisualiser from './RoomLogVisualiser';
import {
  HashRouter,
  Routes,
  Route,
  useNavigate,
  useParams
} from 'react-router-dom';
import 'emoji-picker-element';
import { API_BASE } from './networkConfig';

function Landing({ onJoin, onCreate, onVisualise }) {
  const [joinWords, setJoinWords] = useState(['', '', '', '']);
  const ready = joinWords.every(w => w.trim().length > 0);
  const navigate = useNavigate();
  const [joinErrorText, setJoinErrorText] = useState(null);
  const [showJoinError, setShowJoinError] = useState(false);
  const [checkingJoin, setCheckingJoin] = useState(false);
  const joinErrorTimeout = React.useRef(null);
  const joinInputRefs = React.useRef([]);

  const sanitizeJoinWord = (val) => val.toLowerCase().replace(/[^a-z]/g, '');
  const joinKey = joinWords.map(w => w.trim()).join('-');

  const copyJoinKeyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(joinKey);
      return true;
    } catch {
      return false;
    }
  };

  const selectAllJoinInputs = () => {
    const first = joinInputRefs.current[0];
    if (first) first.focus();
    joinInputRefs.current.forEach((input) => {
      if (!input) return;
      try {
        input.setSelectionRange(0, input.value.length);
      } catch {
        // ignore
      }
    });
  };

  const handleJoinInputKeyDown = (e) => {
    const isAccel = e.metaKey || e.ctrlKey;
    if (!isAccel) return;
    const key = e.key.toLowerCase();
    const code = e.code;
    const isSelectAll = key === 'a' || code === 'KeyA';
    const isCopy = key === 'c' || code === 'KeyC';
    const isCut = key === 'x' || code === 'KeyX';

    if (isSelectAll) {
      e.preventDefault();
      selectAllJoinInputs();
      return;
    }

    if (isCopy) {
      e.preventDefault();
      copyJoinKeyToClipboard();
      return;
    }

    if (isCut) {
      e.preventDefault();
      copyJoinKeyToClipboard();
      setJoinWords(['', '', '', '']);
    }
  };

  const handleJoinInputPaste = (e) => {
    const raw = e.clipboardData?.getData('text') || '';
    const parts = raw
      .split('-')
      .map(sanitizeJoinWord)
      .filter(Boolean);

    if (parts.length === 4) {
      e.preventDefault();
      setJoinWords(parts);
    }
  };
  React.useEffect(() => {
    function handleClickOutside() {
      setShowJoinError(false);
    }
    if (showJoinError) {
      document.addEventListener('click', handleClickOutside);
      if (joinErrorTimeout.current) clearTimeout(joinErrorTimeout.current);
      joinErrorTimeout.current = setTimeout(() => setShowJoinError(false), 5000);
    }
    return () => {
      document.removeEventListener('click', handleClickOutside);
      if (joinErrorTimeout.current) clearTimeout(joinErrorTimeout.current);
    };
  }, [showJoinError]);
  React.useEffect(() => {
    let t;
    if (!showJoinError && joinErrorText) {
      t = setTimeout(() => setJoinErrorText(null), 200);
    }
    return () => {
      if (t) clearTimeout(t);
    };
  }, [showJoinError, joinErrorText]);
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, color: '#000', padding: 24 }}>
      <h1 style={{ marginBottom: 8 }}>Room Auction</h1>
      <h4 style={{ marginTop: 0, color: '#666' }}>N-way bidirectional Dutch auctions to settle your sharehouse debate!</h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%', maxWidth: 760 }}>
        <div style={{ padding: 16, border: '1px solid #e0e6ed', borderRadius: 12, boxShadow: '0 4px 12px #0000000c', background: '#f9fbff' }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Join an auction</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            {joinWords.map((w, idx) => (
              <React.Fragment key={idx}>
                {idx > 0 && <span style={{ fontWeight: 700 }}>-</span>}
                <input
                  ref={el => { joinInputRefs.current[idx] = el; }}
                  type="text"
                  value={w}
                  onChange={e => {
                    const next = [...joinWords];
                    next[idx] = sanitizeJoinWord(e.target.value);
                    setJoinWords(next);
                  }}
                  onKeyDown={handleJoinInputKeyDown}
                  onPaste={handleJoinInputPaste}
                  onCopy={e => {
                    e.preventDefault();
                    e.clipboardData.setData('text/plain', joinKey);
                  }}
                  onCut={e => {
                    e.preventDefault();
                    e.clipboardData.setData('text/plain', joinKey);
                    setJoinWords(['', '', '', '']);
                  }}
                  placeholder="word"
                  style={{ width: 132, padding: '0.65em 0.75em', borderRadius: 8, border: '1px solid #d5dce5', textAlign: 'center', fontWeight: 600 }}
                />
              </React.Fragment>
            ))}
          </div>
          <div style={{ position: 'relative', marginTop: 12 }}>
            <button
              style={{ width: '100%', padding: '0.8em', borderRadius: 10, border: 'none', background: ready ? '#1a2a5a' : '#c7ced9', color: '#fff', fontWeight: 700, cursor: ready ? 'pointer' : 'not-allowed' }}
              disabled={!ready || checkingJoin}
              onClick={async () => {
                const key = joinWords.map(w => w.trim()).join('-');
                setJoinErrorText(null);
                setShowJoinError(false);
                setCheckingJoin(true);
                try {
                  const res = await fetch(`${API_BASE}/api/auctions/${encodeURIComponent(key)}`);
                  if (res.ok) {
                    onJoin(key);
                    navigate(`/auction/${key}`);
                  } else {
                    setJoinErrorText('No running auction for that key.');
                    setShowJoinError(true);
                  }
                } catch {
                  setJoinErrorText('Failed to check auction. Try again.');
                  setShowJoinError(true);
                } finally {
                  setCheckingJoin(false);
                }
              }}
            >
              {checkingJoin ? 'Checking...' : 'Join'}
            </button>
            {joinErrorText && (
              <div style={{
                position: 'absolute',
                top: '100%',
                left: '50%',
                transform: `translate(-50%, ${showJoinError ? '10px' : '2px'})`,
                background: '#fff8f8',
                color: '#b00020',
                border: '1px solid #f5c6cb',
                borderRadius: 8,
                padding: '8px 12px',
                boxShadow: '0 6px 18px #0000001a',
                zIndex: 10,
                whiteSpace: 'nowrap',
                fontWeight: 600,
                opacity: showJoinError ? 1 : 0,
                transition: 'opacity 180ms ease, transform 180ms ease',
                pointerEvents: 'none'
              }}>
                {joinErrorText}
              </div>
            )}
          </div>
        </div>
        <div style={{ padding: 16, border: '1px solid #e0e6ed', borderRadius: 12, boxShadow: '0 4px 12px #0000000c', background: '#f9fbff' }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Host</div>
          <button
            style={{ width: '100%', padding: '0.8em', borderRadius: 10, border: 'none', background: '#1db954', color: '#fff', fontWeight: 700, cursor: 'pointer' }}
            onClick={() => {
              onCreate();
              navigate('/start');
            }}
          >
            Start a new auction
          </button>
        </div>
        <button
          onClick={() => {
            onVisualise();
            navigate('/visualiser');
          }}
          style={{ marginTop: 4, padding: '0.7em 1em', borderRadius: 8, border: '1px solid #d5dce5', background: '#fff', fontWeight: 600, cursor: 'pointer' }}
        >
          Visualise auction logs
        </button>
      </div>
    </div>
  );
}

function StartPage() {
  const generateId = () => crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
  const [people, setPeople] = useState([{ id: generateId(), name: '', emoji: '' }]);
  const [rooms, setRooms] = useState([{ id: generateId(), name: '', description: '', initialPrice: '' }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [createdKey, setCreatedKey] = useState('');
  const [emojiError, setEmojiError] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(null);
  const [removingPersonIds, setRemovingPersonIds] = useState(new Set());
  const [removingRoomIds, setRemovingRoomIds] = useState(new Set());
  const pickerRefs = React.useRef({});
  const navigate = useNavigate();

  const isValidEmoji = (val) => {
    if (!val) return true;
    // Accept pictographs plus flag components (regional indicators), ZWJ and variation selector.
    // eslint-disable-next-line no-misleading-character-class
    return /^[\p{Extended_Pictographic}\p{Regional_Indicator}\u200D\uFE0F]+$/u.test(val.trim());
  };

  const totalInitialAmount = rooms.reduce((sum, room) => {
    const value = Number(room.initialPrice);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);

  const formatAmount = (value) => new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(value);

  const moveItem = (list, fromIndex, toIndex) => {
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= list.length || toIndex >= list.length || fromIndex === toIndex) return list;
    const next = [...list];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    return next;
  };

  React.useEffect(() => {
    if (pickerOpen === null) return;
    const el = pickerRefs.current[pickerOpen];
    if (!el) return;
    const handler = (event) => {
      const val = event.detail?.unicode || event.detail?.emoji?.unicode || event.detail?.emoji || event.detail?.native || '';
      if (isValidEmoji(val)) {
        setPeople(prev => prev.map(person => person.id === pickerOpen ? { ...person, emoji: val } : person));
        setEmojiError(null);
        setPickerOpen(null);
      } else {
        setEmojiError('Please enter an emoji only.');
      }
    };
    el.addEventListener('emoji-click', handler);
    return () => el.removeEventListener('emoji-click', handler);
  }, [pickerOpen]);

  async function handleSaveAndCreate() {
    const validPeople = people.filter(p => p.name && p.name.trim());
    const validRooms = rooms.filter(r => r.name && r.name.trim());
    if (validPeople.length === 0 || validRooms.length === 0) {
      setError('Add at least one person and one room before continuing.');
      return;
    }

    setSaving(true);
    setError(null);
    setEmojiError(null);
    try {
      const resRoster = await fetch(`${API_BASE}/api/roster`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          people: validPeople.map(p => ({ name: p.name, emoji: p.emoji })),
          rooms: validRooms.map(r => ({ name: r.name, description: r.description, initialPrice: r.initialPrice }))
        })
      });
      const rosterJson = await resRoster.json();
      if (!resRoster.ok) {
        setError(rosterJson.error || 'Failed to save roster');
        setSaving(false);
        return;
      }
      const resAuction = await fetch(`${API_BASE}/api/auctions`, { method: 'POST' });
      const auctionJson = await resAuction.json();
      if (!resAuction.ok) {
        setError(auctionJson.error || 'Failed to create auction');
        setSaving(false);
        return;
      }
      const key = auctionJson.externalId || auctionJson.publicId || auctionJson.auctionId;
      setCreatedKey(key);
      navigate(`/auction/${key}`);
    } catch {
      setError('Failed to save or create auction.');
    } finally {
      setSaving(false);
    }
  }


  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: 16, color: '#000', padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ margin: 0 }}>Host a new auction</h1>
          <div style={{ color: '#666' }}>Share the key with participants to join.</div>
        </div>
        <button onClick={() => navigate('/')} style={{ padding: '0.6em 0.9em', borderRadius: 8, border: '1px solid #d5dce5', background: '#fff', cursor: 'pointer' }}>
          ← Back
        </button>
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color: '#1a2a5a' }}>
        Auction key: <span style={{ fontFamily: 'monospace', background: '#f0f4ff', padding: '4px 6px', borderRadius: 6 }}>{createdKey || 'Will be generated when created'}</span>
      </div>
      {error && <div style={{ color: '#b00020', fontWeight: 600 }}>{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'flex-start' }}>
        <div className="panel" style={{ border: '1px solid #e0e6ed', borderRadius: 10, padding: 16, boxShadow: '0 2px 8px #0000000c' }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>People</div>
          {people.map((p, idx) => (
            <div
              key={p.id}
              className={`list-row ${removingPersonIds.has(p.id) ? 'removing' : ''}`}
              style={{ display: 'flex', gap: 8, marginBottom: 10, paddingBottom: 8, borderBottom: idx === people.length - 1 ? '1px dashed #e0e6ed' : 'none' }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <button
                  type="button"
                  aria-label={`Move ${p.name || `person ${idx + 1}`} up`}
                  title="Move up"
                  disabled={idx === 0}
                  onClick={() => {
                    if (idx === 0) return;
                    setPeople(prev => moveItem(prev, idx, idx - 1));
                    setPickerOpen(null);
                  }}
                  style={{
                    width: 36,
                    height: 19,
                    borderRadius: 8,
                    border: '1px solid #d5dce5',
                    background: idx === 0 ? '#f5f7fa' : '#fff',
                    color: idx === 0 ? '#9aa3ad' : '#667085',
                    cursor: idx === 0 ? 'not-allowed' : 'pointer',
                    fontSize: 13,
                    lineHeight: '1em',
                    padding: 0
                  }}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move ${p.name || `person ${idx + 1}`} down`}
                  title="Move down"
                  disabled={idx === people.length - 1}
                  onClick={() => {
                    if (idx === people.length - 1) return;
                    setPeople(prev => moveItem(prev, idx, idx + 1));
                    setPickerOpen(null);
                  }}
                  style={{
                    width: 36,
                    height: 19,
                    borderRadius: 8,
                    border: '1px solid #d5dce5',
                    background: idx === people.length - 1 ? '#f5f7fa' : '#fff',
                    color: idx === people.length - 1 ? '#9aa3ad' : '#667085',
                    cursor: idx === people.length - 1 ? 'not-allowed' : 'pointer',
                    fontSize: 13,
                    lineHeight: '1em',
                    padding: 0
                  }}
                >
                  ↓
                </button>
              </div>
              <input
                type="text"
                placeholder="Name"
                value={p.name}
                onChange={e => {
                  setPeople(prev => prev.map(person => person.id === p.id ? { ...person, name: e.target.value } : person));
                }}
                style={{ flex: 1, padding: '0.55em 0.6em', borderRadius: 8, border: '1px solid #d5dce5', height: 42 }}
              />
              <span
                style={{
                  width: 64,
                  height: 42,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 0,
                  border: 'none',
                  background: 'transparent',
                  fontSize: 28,
                  lineHeight: '1em',
                  color: p.emoji ? '#000' : '#bbb'
                }}
                aria-label={p.emoji ? `Selected emoji ${p.emoji}` : 'No emoji selected'}
              >
                {p.emoji || '∅'}
              </span>
              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => setPickerOpen(pickerOpen === p.id ? null : p.id)}
                  style={{ padding: '0.55em 0.6em', borderRadius: 8, border: '1px solid #d5dce5', background: '#f5f7fa', cursor: 'pointer', height: 42 }}
                >
                  Pick
                </button>
                {pickerOpen === p.id && (
                  <div
                    style={{
                      position: 'absolute',
                      top: '110%',
                      left: 0,
                      zIndex: 20,
                      width: 'min(360px, calc(100vw - 48px))',
                      minWidth: 260,
                      background: '#fff',
                      border: '1px solid #d5dce5',
                      borderRadius: 8,
                      boxShadow: '0 6px 18px #0000001a',
                      padding: 8,
                      overflow: 'visible'
                    }}
                  >
                    <emoji-picker
                      ref={el => { if (el) pickerRefs.current[p.id] = el; }}
                      style={{ width: '100%', height: 320, '--border-radius': '8px' }}
                    ></emoji-picker>
                  </div>
                )}
              </div>
              <button
                onClick={() => {
                  if (people.length <= 1) return;
                  setRemovingPersonIds(prev => new Set(prev).add(p.id));
                  setTimeout(() => {
                    setPeople(prev => prev.filter(person => person.id !== p.id));
                    setRemovingPersonIds(prev => {
                      const next = new Set(prev);
                      next.delete(p.id);
                      return next;
                    });
                  }, 220);
                }}
                disabled={people.length <= 1}
                style={{
                  padding: '0.45em 0.6em',
                  borderRadius: 8,
                  border: '1px solid #d5dce5',
                  background: people.length <= 1 ? '#f5f7fa' : '#fff5f5',
                  color: people.length <= 1 ? '#9aa3ad' : '#8a1c1c',
                  cursor: people.length <= 1 ? 'not-allowed' : 'pointer'
                }}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            onClick={() => setPeople([...people, { id: generateId(), name: '', emoji: '' }])}
            style={{ padding: '0.6em 0.8em', borderRadius: 8, border: '1px solid #d5dce5', background: '#f5f7fa', fontWeight: 600, cursor: 'pointer' }}
          >
            + Add person
          </button>
        </div>
        <div className="panel" style={{ border: '1px solid #e0e6ed', borderRadius: 10, padding: 16, boxShadow: '0 2px 8px #0000000c' }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Rooms</div>
          {rooms.map((r, idx) => (
            <div
              key={r.id}
              className={`list-row ${removingRoomIds.has(r.id) ? 'removing' : ''}`}
              style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10, borderBottom: '1px dashed #e0e6ed', paddingBottom: 8 }}
            >
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <button
                    type="button"
                    aria-label={`Move ${r.name || `room ${idx + 1}`} up`}
                    title="Move up"
                    disabled={idx === 0}
                    onClick={() => {
                      if (idx === 0) return;
                      setRooms(prev => moveItem(prev, idx, idx - 1));
                    }}
                    style={{
                      width: 36,
                      height: 19,
                      borderRadius: 8,
                      border: '1px solid #d5dce5',
                      background: idx === 0 ? '#f5f7fa' : '#fff',
                      color: idx === 0 ? '#9aa3ad' : '#667085',
                      cursor: idx === 0 ? 'not-allowed' : 'pointer',
                      fontSize: 13,
                      lineHeight: '1em',
                      padding: 0
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${r.name || `room ${idx + 1}`} down`}
                    title="Move down"
                    disabled={idx === rooms.length - 1}
                    onClick={() => {
                      if (idx === rooms.length - 1) return;
                      setRooms(prev => moveItem(prev, idx, idx + 1));
                    }}
                    style={{
                      width: 36,
                      height: 19,
                      borderRadius: 8,
                      border: '1px solid #d5dce5',
                      background: idx === rooms.length - 1 ? '#f5f7fa' : '#fff',
                      color: idx === rooms.length - 1 ? '#9aa3ad' : '#667085',
                      cursor: idx === rooms.length - 1 ? 'not-allowed' : 'pointer',
                      fontSize: 13,
                      lineHeight: '1em',
                      padding: 0
                    }}
                  >
                    ↓
                  </button>
                </div>
                <input
                  type="text"
                  placeholder="Room name"
                  value={r.name}
                  onChange={e => {
                    setRooms(prev => prev.map(room => room.id === r.id ? { ...room, name: e.target.value } : room));
                  }}
                  style={{ flex: 1, padding: '0.45em 0.6em', borderRadius: 8, border: '1px solid #d5dce5' }}
                />
                <input
                  type="number"
                  placeholder="Initial price"
                  value={r.initialPrice}
                  onChange={e => {
                    setRooms(prev => prev.map(room => room.id === r.id ? { ...room, initialPrice: e.target.value } : room));
                  }}
                  style={{ width: 140, padding: '0.45em 0.6em', borderRadius: 8, border: '1px solid #d5dce5' }}
                />
                <button
                  onClick={() => {
                    if (rooms.length <= 1) return;
                    setRemovingRoomIds(prev => new Set(prev).add(r.id));
                    setTimeout(() => {
                      setRooms(prev => prev.filter(room => room.id !== r.id));
                      setRemovingRoomIds(prev => {
                        const next = new Set(prev);
                        next.delete(r.id);
                        return next;
                      });
                    }, 220);
                  }}
                  disabled={rooms.length <= 1}
                  style={{
                    padding: '0.45em 0.6em',
                    borderRadius: 8,
                    border: '1px solid #d5dce5',
                    background: rooms.length <= 1 ? '#f5f7fa' : '#fff5f5',
                    color: rooms.length <= 1 ? '#9aa3ad' : '#8a1c1c',
                    cursor: rooms.length <= 1 ? 'not-allowed' : 'pointer'
                  }}
                >
                  ✕
                </button>
              </div>
              <textarea
                placeholder="Description"
                value={r.description}
                onChange={e => {
                  setRooms(prev => prev.map(room => room.id === r.id ? { ...room, description: e.target.value } : room));
                }}
                rows={2}
                style={{ width: '100%', padding: '0.45em 0.6em', borderRadius: 8, border: '1px solid #d5dce5', resize: 'vertical' }}
              />
            </div>
          ))}
          <button
            onClick={() => setRooms([...rooms, { id: generateId(), name: '', description: '', initialPrice: '' }])}
            style={{ padding: '0.6em 0.8em', borderRadius: 8, border: '1px solid #d5dce5', background: '#f5f7fa', fontWeight: 600, cursor: 'pointer' }}
          >
            + Add room
          </button>
        </div>
      </div>
      <div>
        <div style={{ marginBottom: 12, border: '1px solid #d5dce5', borderRadius: 10, padding: 12, background: '#f8faff' }}>
          <div style={{ fontWeight: 700, color: '#1a2a5a' }}>
            Total initial amount: £{formatAmount(totalInitialAmount)}
          </div>
          <div style={{ marginTop: 4, color: '#555' }}>
            This total stays constant throughout the auction as room prices adjust.
          </div>
        </div>
        <button
          onClick={handleSaveAndCreate}
          disabled={saving}
          style={{ padding: '0.8em 1.4em', borderRadius: 10, border: 'none', background: '#1a2a5a', color: '#fff', fontWeight: 700, cursor: 'pointer' }}
        >
          {saving ? 'Creating…' : 'Next'}
        </button>
        {emojiError && <div style={{ color: '#b00020', marginTop: 8, fontWeight: 600 }}>{emojiError}</div>}
      </div>
    </div>
  );
}

function AuctionRoute() {
  const { key } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState('checking'); // checking | ok | error

  useEffect(() => {
    let cancelled = false;
    setStatus('checking');
    fetch(`${API_BASE}/api/auctions/${encodeURIComponent(key || '')}`)
      .then(res => {
        if (cancelled) return;
        if (res.ok) setStatus('ok');
        else setStatus('error');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => { cancelled = true; };
  }, [key]);

  if (status === 'checking') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#000' }}>
        Checking auction {key}...
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: '#b00020' }}>Auction not found</div>
        <div style={{ color: '#555' }}>No running auction for key “{key}”.</div>
        <button onClick={() => navigate('/')} style={{ padding: '0.7em 1.1em', borderRadius: 8, border: '1px solid #d5dce5', background: '#fff', fontWeight: 600 }}>
          Back home
        </button>
      </div>
    );
  }
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', color: '#000', paddingTop: 32 }}>
      <NetworkAuction
        initialAuctionKey={key || ''}
        autoCreate={false}
        onBack={() => navigate('/')}
      />
    </div>
  );
}

function VisualiserRoute() {
  const navigate = useNavigate();
  return <RoomLogVisualiser onBack={() => navigate('/')} />;
}

function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Landing onJoin={() => { }} onCreate={() => { }} onVisualise={() => { }} />} />
        <Route path="/auction/:key" element={<AuctionRoute />} />
        <Route path="/start" element={<StartPage />} />
        <Route path="/visualiser" element={<VisualiserRoute />} />
        <Route path="*" element={<Landing onJoin={() => { }} onCreate={() => { }} onVisualise={() => { }} />} />
      </Routes>
    </HashRouter>
  );
}

export default App
