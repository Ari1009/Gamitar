import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
const originsEnv = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const allowedOrigins = originsEnv.split(',').map((s) => s.trim()).filter(Boolean);
const cooldownSeconds = process.env.COOLDOWN_SECONDS ? parseInt(process.env.COOLDOWN_SECONDS, 10) : 0;

const corsOrigin = (requestOrigin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
  if (process.env.CORS_ANY === '1') return callback(null, true);
  if (!requestOrigin) return callback(null, true);
  if (allowedOrigins.includes(requestOrigin)) return callback(null, true);
  return callback(null, false);
};

app.use(cors({ origin: corsOrigin }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
});

const ROWS = 10;
const COLS = 10;

type Grid = string[][];
type Update = { row: number; col: number; char: string; by: string; at: number };

const makeEmptyGrid = (): Grid => Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => ''));

let grid: Grid = makeEmptyGrid();
const history: Update[] = [];
const onlineSockets = new Set<string>();
const lastSubmitAtByPlayer = new Map<string, number>();

function firstGrapheme(s: string): string {
  if (!s) return '';
  const arr = Array.from(s);
  return arr.length ? arr[0] : '';
}

function canSubmit(playerId: string): { ok: boolean; retryAfterMs?: number; permanent?: boolean } {
  const last = lastSubmitAtByPlayer.get(playerId) || 0;
  if (cooldownSeconds === 0) {
    if (last > 0) return { ok: false, permanent: true };
    return { ok: true };
  }
  const now = Date.now();
  const delta = now - last;
  if (delta < cooldownSeconds * 1000) {
    return { ok: false, retryAfterMs: cooldownSeconds * 1000 - delta };
  }
  return { ok: true };
}

function broadcastOnline() {
  io.emit('onlineCount', onlineSockets.size);
}

io.on('connection', (socket) => {
  onlineSockets.add(socket.id);
  broadcastOnline();

  socket.emit('init', { grid, history, onlineCount: onlineSockets.size, cooldownSeconds });

  socket.on('submit', (payload: any, ack?: (resp: any) => void) => {
    try {
      const { row, col, char, playerId } = payload || {};
      if (typeof row !== 'number' || typeof col !== 'number' || row < 0 || row >= ROWS || col < 0 || col >= COLS) {
        const msg = 'Invalid coordinates';
        ack && ack({ ok: false, error: msg });
        return;
      }
      const ch = firstGrapheme(String(char || '').trim());
      if (!ch) {
        const msg = 'Character required';
        ack && ack({ ok: false, error: msg });
        return;
      }
      const id = String(playerId || '').trim();
      if (!id) {
        const msg = 'playerId required';
        ack && ack({ ok: false, error: msg });
        return;
      }
      const permit = canSubmit(id);
      if (!permit.ok) {
        ack && ack({ ok: false, error: 'On cooldown', retryAfterMs: permit.retryAfterMs, permanent: !!permit.permanent });
        return;
      }
      const now = Date.now();
      grid[row][col] = ch;
      const upd: Update = { row, col, char: ch, by: id, at: now };
      history.push(upd);
      lastSubmitAtByPlayer.set(id, now);
      io.emit('update', upd);
      ack && ack({ ok: true, at: now });
    } catch (e) {
      ack && ack({ ok: false, error: 'Server error' });
    }
  });

  socket.on('disconnect', () => {
    onlineSockets.delete(socket.id);
    broadcastOnline();
  });
});

httpServer.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${port}`);
});
