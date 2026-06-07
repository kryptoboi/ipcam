/**
 * AudioCam Server
 * - WebSocket signaling dla WebRTC
 * - REST API do odbierania nagrań
 * - Zapis nagrań lokalnie (do synchronizacji przez FolderSync)
 * - Powiadomienia push (Web Push)
 * - Serwowanie plików klientów (kamera + odbiornik)
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── Konfiguracja ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(__dirname, 'recordings');
const SHORT_CLIPS_DIR = path.join(RECORDINGS_DIR, 'clips');      // 10-sek klipy → FolderSync
const LONG_RECORDINGS_DIR = path.join(RECORDINGS_DIR, 'full');   // 5-min nagrania
const MAX_LONG_RECORDINGS = parseInt(process.env.MAX_RECORDINGS || '100');
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'changeme-strong-token';

// VAPID keys dla Web Push (wygeneruj własne: npx web-push generate-vapid-keys)
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:admin@example.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// ─── Upewnij się że katalogi istnieją ───────────────────────────────────────

[RECORDINGS_DIR, SHORT_CLIPS_DIR, LONG_RECORDINGS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── Przechowywanie subskrypcji push ────────────────────────────────────────

const SUBSCRIPTIONS_FILE = path.join(__dirname, 'subscriptions.json');
let pushSubscriptions = [];
try {
  if (fs.existsSync(SUBSCRIPTIONS_FILE)) {
    pushSubscriptions = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8'));
  }
} catch (e) { pushSubscriptions = []; }

function saveSubscriptions() {
  fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(pushSubscriptions, null, 2));
}

// ─── Multer – upload nagrań ──────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const isClip = req.path.includes('/clip');
    cb(null, isClip ? SHORT_CLIPS_DIR : LONG_RECORDINGS_DIR);
  },
  filename: (req, file, cb) => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = file.originalname.split('.').pop() || 'webm';
    const prefix = req.path.includes('/clip') ? 'clip' : 'rec';
    cb(null, `${prefix}_${ts}.${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['video/webm', 'video/mp4', 'video/x-matroska', 'application/octet-stream'];
    cb(null, true); // akceptuj wszystko z kamery
  }
});

// ─── Middleware ──────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());

// Autoryzacja dla endpointów API
function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Serwuj pliki statyczne (klienty)
app.use('/camera', express.static(path.join(__dirname, '../camera-client')));
app.use('/receiver', express.static(path.join(__dirname, '../receiver-client')));
app.use('/clips', express.static(SHORT_CLIPS_DIR));
app.use('/', express.static(path.join(__dirname, '../camera-client'))); // domyślnie kamera

// ─── API: Nagrywanie ─────────────────────────────────────────────────────────

// POST /api/upload/clip  – 10-sekundowy klip (→ FolderSync → drugi telefon)
app.post('/api/upload/clip', authMiddleware, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  const fileUrl = `/clips/${req.file.filename}`;
  console.log(`[CLIP] Saved: ${req.file.filename} (${(req.file.size / 1024).toFixed(1)} KB)`);

  // Wyślij powiadomienie push do wszystkich subskrybentów
  const notification = {
    title: '🔊 Wykryto dźwięk!',
    body: `Nagranie z ${new Date().toLocaleTimeString('pl-PL')}`,
    url: fileUrl,
    timestamp: Date.now()
  };
  await sendPushNotifications(notification);

  // Zapisz zdarzenie do logu
  appendEventLog('sound_detected', { file: req.file.filename, size: req.file.size });

  res.json({ success: true, file: req.file.filename, url: fileUrl });
});

// POST /api/upload/recording  – 5-minutowe nagranie ciągłe
app.post('/api/upload/recording', authMiddleware, upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  console.log(`[REC] Saved: ${req.file.filename} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);
  cleanupOldRecordings();
  appendEventLog('recording_saved', { file: req.file.filename, size: req.file.size });

  res.json({ success: true, file: req.file.filename });
});

// GET /api/clips  – lista ostatnich klipów
app.get('/api/clips', authMiddleware, (req, res) => {
  const files = getFileList(SHORT_CLIPS_DIR);
  res.json(files);
});

// GET /api/recordings  – lista długich nagrań
app.get('/api/recordings', authMiddleware, (req, res) => {
  const files = getFileList(LONG_RECORDINGS_DIR);
  res.json(files);
});

// GET /api/events  – log zdarzeń dźwiękowych
app.get('/api/events', authMiddleware, (req, res) => {
  const logFile = path.join(__dirname, 'events.json');
  if (!fs.existsSync(logFile)) return res.json([]);
  try {
    const events = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    res.json(events.slice(-100)); // ostatnie 100 zdarzeń
  } catch { res.json([]); }
});

// GET /api/status – status serwera
app.get('/api/status', (req, res) => {
  const clips = fs.existsSync(SHORT_CLIPS_DIR) ? fs.readdirSync(SHORT_CLIPS_DIR).length : 0;
  const recs = fs.existsSync(LONG_RECORDINGS_DIR) ? fs.readdirSync(LONG_RECORDINGS_DIR).length : 0;
  res.json({
    status: 'ok',
    clips,
    recordings: recs,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// ─── API: Web Push ───────────────────────────────────────────────────────────

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe', authMiddleware, (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  // Usuń duplikaty
  pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== subscription.endpoint);
  pushSubscriptions.push(subscription);
  saveSubscriptions();
  console.log(`[PUSH] New subscriber, total: ${pushSubscriptions.length}`);
  res.json({ success: true });
});

app.delete('/api/subscribe', authMiddleware, (req, res) => {
  const { endpoint } = req.body;
  pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== endpoint);
  saveSubscriptions();
  res.json({ success: true });
});

// ─── WebSocket – sygnalizacja WebRTC ─────────────────────────────────────────
// Używane do real-time preview między kamerą a odbiornikiem (opcjonalne)

const clients = new Map(); // id → ws

wss.on('connection', (ws, req) => {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  ws.id = id;
  clients.set(id, ws);
  console.log(`[WS] Connected: ${id}, total: ${clients.size}`);

  ws.send(JSON.stringify({ type: 'connected', id }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      handleSignaling(ws, msg);
    } catch (e) {
      console.error('[WS] Bad message:', e.message);
    }
  });

  ws.on('close', () => {
    clients.delete(id);
    console.log(`[WS] Disconnected: ${id}`);
    // Powiadom innych o rozłączeniu
    broadcast({ type: 'peer_disconnected', id }, ws);
  });

  ws.on('error', (e) => console.error('[WS] Error:', e.message));
});

function handleSignaling(ws, msg) {
  switch (msg.type) {
    case 'register':
      ws.role = msg.role; // 'camera' lub 'receiver'
      ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
      // Powiadom kamerę gdy pojawi się odbiornik i odwrotnie
      broadcast({ type: 'peer_joined', role: msg.role, id: ws.id }, ws);
      break;

    case 'offer':
    case 'answer':
    case 'ice_candidate':
      // Przekaż do konkretnego peera lub broadcast
      if (msg.targetId && clients.has(msg.targetId)) {
        clients.get(msg.targetId).send(JSON.stringify({ ...msg, fromId: ws.id }));
      } else {
        broadcast({ ...msg, fromId: ws.id }, ws);
      }
      break;

    case 'sound_event':
      // Kamera informuje serwer o wykryciu dźwięku (bez uploadu)
      console.log(`[SOUND] Level: ${msg.level} dB`);
      broadcast({ type: 'sound_alert', level: msg.level, timestamp: Date.now() }, ws);
      break;

    default:
      broadcast({ ...msg, fromId: ws.id }, ws);
  }
}

function broadcast(msg, exclude) {
  const data = JSON.stringify(msg);
  clients.forEach((client, id) => {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// ─── Pomocnicze ─────────────────────────────────────────────────────────────

async function sendPushNotifications(payload) {
  if (!VAPID_PUBLIC_KEY || pushSubscriptions.length === 0) return;
  const data = JSON.stringify(payload);
  const failed = [];
  for (const sub of pushSubscriptions) {
    try {
      await webpush.sendNotification(sub, data);
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) failed.push(sub.endpoint);
      else console.error('[PUSH] Error:', e.message);
    }
  }
  if (failed.length > 0) {
    pushSubscriptions = pushSubscriptions.filter(s => !failed.includes(s.endpoint));
    saveSubscriptions();
  }
}

function getFileList(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.match(/\.(webm|mp4|mkv)$/i))
    .map(f => {
      const stat = fs.statSync(path.join(dir, f));
      return { filename: f, size: stat.size, created: stat.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.created) - new Date(a.created));
}

function cleanupOldRecordings() {
  const files = getFileList(LONG_RECORDINGS_DIR);
  if (files.length > MAX_LONG_RECORDINGS) {
    const toDelete = files.slice(MAX_LONG_RECORDINGS);
    toDelete.forEach(f => {
      try { fs.unlinkSync(path.join(LONG_RECORDINGS_DIR, f.filename)); } catch {}
    });
    console.log(`[CLEANUP] Deleted ${toDelete.length} old recordings`);
  }
}

function appendEventLog(type, data) {
  const logFile = path.join(__dirname, 'events.json');
  let events = [];
  try {
    if (fs.existsSync(logFile)) events = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  } catch {}
  events.push({ type, ...data, timestamp: new Date().toISOString() });
  // Trzymaj max 1000 zdarzeń
  if (events.length > 1000) events = events.slice(-1000);
  fs.writeFileSync(logFile, JSON.stringify(events, null, 2));
}

// ─── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║         AudioCam Server v1.0             ║
╠══════════════════════════════════════════╣
║  Port:        ${PORT}                       ║
║  Kamera:      /camera                    ║
║  Odbiornik:   /receiver                  ║
║  API:         /api/status                ║
╚══════════════════════════════════════════╝
  `);
});

module.exports = { app, server };
