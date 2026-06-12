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

// ─── WebDAV – tylko do odczytu dla FolderSync ────────────────────────────────
// FolderSync łączy się przez: https://serwer/webdav/clips/
// Login: dowolny, Hasło: AUTH_TOKEN

function webdavAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="AudioCam WebDAV"');
    return res.status(401).send('Unauthorized');
  }
  const decoded = Buffer.from(auth.slice(6), 'base64').toString();
  const password = decoded.split(':').slice(1).join(':'); // wszystko po pierwszym ':'
  if (password !== AUTH_TOKEN) {
    res.set('WWW-Authenticate', 'Basic realm="AudioCam WebDAV"');
    return res.status(401).send('Unauthorized');
  }
  next();
}

// PROPFIND – lista plików (FolderSync używa tego do sprawdzenia co jest nowe)
app.use('/webdav', webdavAuth, (req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.set('DAV', '1');
    res.set('Allow', 'OPTIONS, GET, HEAD, PROPFIND');
    return res.status(200).end();
  }
  next();
});

app.propfind = app.propfind || ((path, ...handlers) => app.all(path, (req, res, next) => {
  if (req.method === 'PROPFIND') handlers[handlers.length - 1](req, res, next);
  else next();
}));

// Obsługa PROPFIND i GET dla /webdav/clips/
['PROPFIND', 'GET', 'HEAD'].forEach(method => {
  app[method.toLowerCase()] = app[method.toLowerCase()] || ((p, ...h) => app.all(p, (req, res, next) => {
    if (req.method === method) h[h.length-1](req, res, next); else next();
  }));
});

app.all('/webdav/clips', webdavAuth, (req, res) => {
  if (req.method === 'PROPFIND') return handlePropfind(req, res, SHORT_CLIPS_DIR, '/webdav/clips');
  res.redirect('/webdav/clips/');
});

app.all('/webdav/clips/', webdavAuth, (req, res) => {
  if (req.method === 'PROPFIND') return handlePropfind(req, res, SHORT_CLIPS_DIR, '/webdav/clips');
  res.status(200).end();
});

app.all('/webdav/clips/:filename', webdavAuth, (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(SHORT_CLIPS_DIR, filename);

  if (req.method === 'PROPFIND') {
    if (!fs.existsSync(filepath)) return res.status(404).end();
    const stat = fs.statSync(filepath);
    return res.status(207).set('Content-Type', 'application/xml').send(
      buildPropfindXml([{ name: filename, stat, href: `/webdav/clips/${filename}` }])
    );
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (!fs.existsSync(filepath)) return res.status(404).end();
    const stat = fs.statSync(filepath);
    res.set('Content-Type', 'video/webm');
    res.set('Content-Length', stat.size);
    res.set('Last-Modified', stat.mtime.toUTCString());
    if (req.method === 'HEAD') return res.end();
    return res.sendFile(filepath);
  }

  res.status(405).end();
});

function handlePropfind(req, res, dir, basePath) {
  const depth = req.headers['depth'] || '1';
  const entries = [];

  // Dodaj sam katalog
  entries.push({ name: '', stat: { size: 0, mtime: new Date(), isDirectory: () => true }, href: basePath + '/', isDir: true });

  // Dodaj pliki jeśli depth=1
  if (depth !== '0' && fs.existsSync(dir)) {
    fs.readdirSync(dir)
      .filter(f => f.match(/\.(webm|mp4)$/i))
      .forEach(f => {
        const stat = fs.statSync(path.join(dir, f));
        entries.push({ name: f, stat, href: `${basePath}/${f}`, isDir: false });
      });
  }

  res.status(207).set('Content-Type', 'application/xml; charset=utf-8').send(
    buildPropfindXml(entries)
  );
}

function buildPropfindXml(entries) {
  const responses = entries.map(e => {
    const isDir = e.isDir || (e.stat && e.stat.isDirectory && e.stat.isDirectory());
    const mtime = e.stat.mtime instanceof Date ? e.stat.mtime : new Date(e.stat.mtime);
    return `
  <D:response>
    <D:href>${e.href}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${e.name}</D:displayname>
        <D:getcontentlength>${isDir ? 0 : e.stat.size}</D:getcontentlength>
        <D:getlastmodified>${mtime.toUTCString()}</D:getlastmodified>
        <D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>
        <D:getcontenttype>${isDir ? 'httpd/unix-directory' : 'video/webm'}</D:getcontenttype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
  }).join('');

  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
${responses}
</D:multistatus>`;
}

app.use('/receiver', express.static(path.join(__dirname, '../receiver-client')));
app.use('/clips', express.static(SHORT_CLIPS_DIR));
app.use('/', express.static(path.join(__dirname, '../camera-client'))); // domyślnie kamera

// ─── API: Nagrywanie ─────────────────────────────────────────────────────────

// POST /api/upload/clip  – 10-sekundowy klip (→ FolderSync → drugi telefon)
app.post('/api/upload/clip', authMiddleware, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  const fileUrl = `/clips/${req.file.filename}`;
  console.log(`[CLIP] Saved: ${req.file.filename} (${(req.file.size / 1024).toFixed(1)} KB)`);

  // ntfy.sh – powiadomienie natychmiastowe
  fetch('https://ntfy.sh/e', {
    method: 'POST',
    body: `🔊 Dźwięk wykryty o ${new Date().toLocaleTimeString('pl-PL')}`,
    headers: { 'Title': 'AudioCam Alert', 'Priority': 'high' }
  }).catch(e => console.error('[NTFY]', e.message));

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
      // Kamera informuje serwer o wykryciu dźwięku – NATYCHMIAST push i broadcast
      console.log(`[SOUND] Level: ${msg.level} dB`);
      broadcast({ type: 'sound_alert', level: msg.level, timestamp: Date.now() }, ws);

      // ntfy.sh – natychmiast
      fetch('https://ntfy.sh/e', {
        method: 'POST',
        body: `🔊 Dźwięk ${msg.level} dB`,
        headers: { 'Title': 'AudioCam', 'Priority': 'high' }
      }).catch(e => console.error('[NTFY]', e.message));

      // Web Push (opcjonalnie, jeśli VAPID skonfigurowane)
      sendPushNotifications({
        title: '🔊 Wykryto dźwięk!',
        body: `Poziom: ${msg.level} dB`,
        url: '/receiver',
        timestamp: Date.now()
      });
      appendEventLog('sound_detected_live', { level: msg.level });
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
