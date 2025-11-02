import { useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

const SERVER_URL = (import.meta as any).env?.VITE_SERVER_URL || 'http://localhost:4000';
const ROWS = 10;
const COLS = 10;

type Grid = string[][];

type Update = {
  row: number;
  col: number;
  char: string;
  by: string;
  at: number;
};

function makeEmptyGrid(): Grid {
  return Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => ''));
}

function firstGrapheme(s: string) {
  if (!s) return '';
  const arr = Array.from(s);
  return arr.length ? arr[0] : '';
}

function usePlayerId() {
  const key = 'unicode-grid-player-id';
  const [id] = useState(() => {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const gen = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? (crypto as any).randomUUID() : `u_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(key, gen);
    return gen;
  });
  return id;
}

export default function App() {
  const playerId = usePlayerId();
  const socketRef = useRef<Socket | null>(null);

  const [gridLive, setGridLive] = useState<Grid>(() => makeEmptyGrid());
  const [onlineCount, setOnlineCount] = useState(0);
  const [history, setHistory] = useState<Update[]>([]);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  const [row, setRow] = useState<number | null>(null);
  const [col, setCol] = useState<number | null>(null);
  const [char, setChar] = useState('');
  const [error, setError] = useState<string | null>(null);

  const lastSubmitKey = 'unicode-grid-last-submit';
  const [lastSubmitAt, setLastSubmitAt] = useState<number>(() => {
    const s = localStorage.getItem(lastSubmitKey);
    return s ? Number(s) : 0;
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const s = io(SERVER_URL, { transports: ['websocket'] });
    socketRef.current = s;

    s.on('connect', () => {});

    s.on('init', (payload: { grid: Grid; history: Update[]; onlineCount: number; cooldownSeconds: number }) => {
      setGridLive(payload.grid);
      setHistory(payload.history);
      setOnlineCount(payload.onlineCount);
      setCooldownSeconds(payload.cooldownSeconds || 0);
    });

    s.on('update', (upd: Update) => {
      setGridLive((g) => {
        const next = g.map((r) => r.slice());
        next[upd.row][upd.col] = upd.char;
        return next;
      });
      setHistory((h) => [...h, upd]);
    });

    s.on('onlineCount', (n: number) => setOnlineCount(n));

    return () => {
      s.close();
    };
  }, []);

  useEffect(() => {
    if (cooldownSeconds === 0 && lastSubmitAt > 0) return; 
    if (cooldownSeconds > 0) {
      const t = setInterval(() => setTick((x) => x + 1), 1000);
      return () => clearInterval(t);
    }
  }, [cooldownSeconds, lastSubmitAt]);

  const cooldownLeftMs = useMemo(() => {
    if (cooldownSeconds === 0) return lastSubmitAt > 0 ? Number.POSITIVE_INFINITY : 0;
    if (!lastSubmitAt) return 0;
    const elapsed = Date.now() - lastSubmitAt;
    const total = cooldownSeconds * 1000;
    return Math.max(0, total - elapsed);
  }, [cooldownSeconds, lastSubmitAt, tick]);

  const disabled = cooldownLeftMs > 0 && lastSubmitAt > 0;

  const pick = (r: number, c: number) => {
    if (disabled) return;
    setRow(r);
    setCol(c);
    setError(null);
  };

  const submit = () => {
    if (disabled) return;
    if (row == null || col == null) {
      setError('Pick a cell');
      return;
    }
    const ch = firstGrapheme(char.trim());
    if (!ch) {
      setError('Enter a character');
      return;
    }
    setError(null);
    socketRef.current?.emit('submit', { row, col, char: ch, playerId }, (ack: any) => {
      if (!ack?.ok) {
        if (ack?.permanent) {
          const at = Date.now();
          setLastSubmitAt(at);
          localStorage.setItem(lastSubmitKey, String(at));
        }
        setError(ack?.error || 'Submit failed');
        return;
      }
      const at = Number(ack.at) || Date.now();
      setLastSubmitAt(at);
      localStorage.setItem(lastSubmitKey, String(at));
      setChar('');
    });
  };

  const groupedBySecond = useMemo(() => {
    const groups = new Map<number, Update[]>();
    for (const u of history) {
      const sec = Math.floor(u.at / 1000);
      if (!groups.has(sec)) groups.set(sec, []);
      groups.get(sec)!.push(u);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0] - b[0]);
  }, [history]);

  const [viewSec, setViewSec] = useState<'live' | number>('live');

  const gridView = useMemo(() => {
    if (viewSec === 'live') return gridLive;
    const cutoff = (viewSec as number) * 1000 + 999;
    const g = makeEmptyGrid();
    const hist = history.slice().sort((a, b) => a.at - b.at);
    for (const u of hist) {
      if (u.at <= cutoff) g[u.row][u.col] = u.char;
      else break;
    }
    return g;
  }, [viewSec, gridLive, history]);

  const timeLeftSeconds = disabled && cooldownLeftMs !== Number.POSITIVE_INFINITY ? Math.ceil(cooldownLeftMs / 1000) : 0;

  return (
    <div className="container">
      <div className="header">
        <div className="title">Unicode Grid</div>
        <div className="badge">Online: {onlineCount}</div>
      </div>

      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="controls">
          <div className="subtle">Selected: {row == null ? '-' : row + 1}×{col == null ? '-' : col + 1}</div>
          <input
            className="input"
            type="text"
            value={char}
            onChange={(e) => setChar(firstGrapheme(e.target.value))}
            maxLength={2}
            placeholder="Enter a character"
            disabled={disabled}
          />
          <button className="button" onClick={submit} disabled={disabled}>Submit</button>
          {disabled && (
            <div className="subtle">
              {cooldownSeconds === 0 ? 'You already submitted.' : `Cooldown: ${timeLeftSeconds}s`}
            </div>
          )}
        </div>
        {error && <div style={{ color: '#ff6b6b', fontSize: 13 }}>{error}</div>}
      </div>

      <div className="grid">
        {gridView.map((r, ri) => (
          r.map((cell, ci) => {
            const isSel = row === ri && col === ci && viewSec === 'live';
            const cls = ['cell', isSel ? 'selected' : '', disabled ? 'disabled' : ''].filter(Boolean).join(' ');
            return (
              <div key={`${ri}-${ci}`} className={cls} onClick={() => pick(ri, ci)}>
                {cell || ''}
              </div>
            );
          })
        ))}
      </div>

      <div className="footer">
        <div className="legend"><span className="dot" /> Live updates</div>
        <div className="subtle">Player: {playerId.slice(0, 8)}</div>
      </div>

      <div className="panel history">
        <div className="title">History</div>
        <select className="select" value={String(viewSec)} onChange={(e) => setViewSec(e.target.value === 'live' ? 'live' : Number(e.target.value))}>
          <option value="live">Live</option>
          {groupedBySecond.map(([sec]) => (
            <option key={sec} value={sec}>{new Date(sec * 1000).toLocaleTimeString()}</option>
          ))}
        </select>
        <div className="subtle">View snapshots per second</div>
      </div>
    </div>
  );
}
