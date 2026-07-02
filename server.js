const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 5e7,
  pingTimeout: 120000,
  pingInterval: 15000,
  transports: ['websocket', 'polling'],
  perMessageDeflate: false
});

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const uploadPdf = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files allowed'));
  }
});

const uploadAudio = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 500 * 1024 * 1024 }
});

const PORT = process.env.PORT || 4567;

// shared state
const rooms = new Map();

function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, {
      id,
      stations: [],
      notes: [],
      zines: [],
      users: new Map(),
      created: Date.now()
    });
  }
  return rooms.get(id);
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));

app.get('/api/room/:id', (req, res) => {
  const room = getRoom(req.params.id);
  res.json({
    id: room.id,
    stations: room.stations.map(s => ({
      id: s.id, name: s.name, x: s.x, y: s.y,
      reach: s.reach, hasAudio: s.hasAudio, live: s.live,
      owner: s.owner, type: s.type
    })),
    userCount: room.users.size
  });
});

app.get('/health', (req, res) => {
  const totalUsers = [...rooms.values()].reduce((s, r) => s + r.users.size, 0);
  res.json({ status: 'ok', rooms: rooms.size, users: totalUsers, uptime: Math.floor(process.uptime()) });
});

// zine upload endpoint
// audio upload endpoint
app.post('/api/audio/upload', uploadAudio.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const fileId = uuidv4().slice(0, 12);
  const ext = path.extname(req.file.originalname) || '.webm';
  const newPath = path.join(UPLOADS_DIR, fileId + ext);
  fs.renameSync(req.file.path, newPath);
  res.json({ fileId, ext, originalName: req.file.originalname, size: req.file.size });
});

// serve audio file
app.get('/api/audio/:fileId', (req, res) => {
  const dir = fs.readdirSync(UPLOADS_DIR);
  const match = dir.find(f => f.startsWith(req.params.fileId));
  if (match) {
    const filePath = path.join(UPLOADS_DIR, match);
    const ext = path.extname(match);
    const mimeMap = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.webm': 'audio/webm', '.m4a': 'audio/mp4' };
    res.setHeader('Content-Type', mimeMap[ext] || 'audio/webm');
    return fs.createReadStream(filePath).pipe(res);
  }
  res.status(404).json({ error: 'not found' });
});

app.post('/api/zine/upload', uploadPdf.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const fileId = uuidv4().slice(0, 12);
  const ext = '.pdf';
  const newPath = path.join(UPLOADS_DIR, fileId + ext);
  fs.renameSync(req.file.path, newPath);
  res.json({ fileId, originalName: req.file.originalname, size: req.file.size });
});

// serve zine PDF
app.get('/api/zine/:id/pdf', (req, res) => {
  for (const room of rooms.values()) {
    const zine = room.zines.find(z => z.id === req.params.id);
    if (zine && zine.fileId) {
      const filePath = path.join(UPLOADS_DIR, zine.fileId + '.pdf');
      if (fs.existsSync(filePath)) {
        res.setHeader('Content-Type', 'application/pdf');
        return fs.createReadStream(filePath).pipe(res);
      }
    }
  }
  res.status(404).json({ error: 'not found' });
});

// catch-all for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let idSeq = 1;

io.on('connection', (socket) => {
  let currentRoom = null;
  let userId = null;
  let userName = null;
  let userPos = { x: 0, y: 0 };

  let userAvatarUrl = null;

  socket.on('join-room', (data) => {
    const roomId = data.roomId || 'default';
    userName = data.name || 'listener ' + (Math.floor(Math.random() * 900) + 100);
    userAvatarUrl = data.avatarUrl || null;
    userId = uuidv4().slice(0, 8);
    currentRoom = getRoom(roomId);

    socket.join(roomId);
    currentRoom.users.set(userId, { id: userId, name: userName, x: 0, y: 0, socketId: socket.id, avatarUrl: userAvatarUrl });

    socket.emit('room-state', {
      userId,
      stations: currentRoom.stations.map(s => ({
        id: s.id, name: s.name, x: s.x, y: s.y,
        reach: s.reach, hasAudio: s.hasAudio, live: s.live,
        owner: s.owner, type: s.type, audioFileId: s.audioFileId || null,
        avatarUrl: s.avatarUrl || null
      })),
      notes: currentRoom.notes,
      zines: currentRoom.zines.map(z => ({ id: z.id, title: z.title, x: z.x, y: z.y, owner: z.owner, pages: z.pages })),
      users: [...currentRoom.users.values()].map(u => ({ id: u.id, name: u.name, x: u.x, y: u.y, avatarUrl: u.avatarUrl || null }))
    });

    socket.to(roomId).emit('user-joined', { id: userId, name: userName, x: 0, y: 0, avatarUrl: userAvatarUrl });
    io.to(roomId).emit('user-count', currentRoom.users.size);
    console.log(`+ ${userName} joined room ${roomId} (${currentRoom.users.size} users)`);
  });

  socket.on('move', (pos) => {
    if (!currentRoom || !userId) return;
    userPos = { x: pos.x, y: pos.y };
    const user = currentRoom.users.get(userId);
    if (user) { user.x = pos.x; user.y = pos.y; }
    socket.to(currentRoom.id).volatile.emit('user-moved', { id: userId, x: pos.x, y: pos.y });
  });

  socket.on('place-station', (data) => {
    if (!currentRoom || !userId) return;
    const station = {
      id: 'st_' + (idSeq++),
      name: data.name || 'untitled station',
      x: data.x, y: data.y,
      reach: data.reach || 460,
      hasAudio: false,
      live: false,
      owner: userId,
      type: 'empty',
      seed: Math.random() * 1000,
      avatarUrl: userAvatarUrl
    };
    currentRoom.stations.push(station);
    io.to(currentRoom.id).emit('station-placed', station);
  });

  socket.on('remove-station', (stationId) => {
    if (!currentRoom) return;
    currentRoom.stations = currentRoom.stations.filter(s => s.id !== stationId);
    io.to(currentRoom.id).emit('station-removed', stationId);
  });

  // audio file attached to a station
  socket.on('station-audio', (data) => {
    if (!currentRoom) return;
    const st = currentRoom.stations.find(s => s.id === data.stationId);
    if (!st) return;
    st.hasAudio = true;
    st.live = false;
    st.type = 'recording';
    st.audioFileId = data.audioFileId || null;
    io.to(currentRoom.id).emit('station-audio', {
      stationId: data.stationId,
      audioFileId: data.audioFileId,
      type: 'recording'
    });
  });

  // on-air: live mic stream
  socket.on('go-on-air', (stationId) => {
    if (!currentRoom) return;
    const st = currentRoom.stations.find(s => s.id === stationId);
    if (!st) return;
    st.hasAudio = true;
    st.live = true;
    st.type = 'live';
    io.to(currentRoom.id).emit('station-live', { stationId, userId, userName });
  });

  socket.on('stop-on-air', (stationId) => {
    if (!currentRoom) return;
    const st = currentRoom.stations.find(s => s.id === stationId);
    if (!st) return;
    st.live = false;
    st.hasAudio = false;
    st.type = 'empty';
    io.to(currentRoom.id).emit('station-off-air', stationId);
  });

  // live audio chunks (Int16 PCM)
  socket.on('live-audio', (data) => {
    if (!currentRoom) return;
    socket.to(currentRoom.id).volatile.emit('live-audio', {
      stationId: data.stationId,
      audio: data.audio
    });
  });

  // forward subversive-radio broadcast into a station
  socket.on('feed-broadcast', (data) => {
    if (!currentRoom) return;
    const st = currentRoom.stations.find(s => s.id === data.stationId);
    if (!st) return;
    st.hasAudio = true;
    st.live = true;
    st.type = 'broadcast';
    io.to(currentRoom.id).emit('station-broadcast', {
      stationId: data.stationId,
      broadcastUrl: data.broadcastUrl
    });
  });

  // notes
  socket.on('place-note', (data) => {
    if (!currentRoom || !userId) return;
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const note = {
      id: 'n_' + (idSeq++),
      text: (data.text || '').slice(0, 280),
      x: data.x, y: data.y,
      author: userName,
      owner: userId,
      time
    };
    currentRoom.notes.push(note);
    io.to(currentRoom.id).emit('note-placed', note);
  });

  socket.on('remove-note', (noteId) => {
    if (!currentRoom) return;
    currentRoom.notes = currentRoom.notes.filter(n => n.id !== noteId);
    io.to(currentRoom.id).emit('note-removed', noteId);
  });

  // zines
  socket.on('place-zine', (data) => {
    if (!currentRoom || !userId) return;
    const zine = {
      id: 'z_' + (idSeq++),
      title: (data.title || 'untitled zine').slice(0, 80),
      x: data.x, y: data.y,
      owner: userId,
      fileId: data.fileId,
      originalName: data.originalName || '',
      size: data.size || 0
    };
    currentRoom.zines.push(zine);
    io.to(currentRoom.id).emit('zine-placed', { id: zine.id, title: zine.title, x: zine.x, y: zine.y, owner: zine.owner, fileId: zine.fileId });
  });

  socket.on('remove-zine', (zineId) => {
    if (!currentRoom) return;
    const zine = currentRoom.zines.find(z => z.id === zineId);
    if (zine && zine.fileId) {
      const filePath = path.join(UPLOADS_DIR, zine.fileId + '.pdf');
      fs.unlink(filePath, () => {});
    }
    currentRoom.zines = currentRoom.zines.filter(z => z.id !== zineId);
    io.to(currentRoom.id).emit('zine-removed', zineId);
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !userId) return;
    // stop any live stations owned by this user
    currentRoom.stations.forEach(st => {
      if (st.owner === userId && st.live) {
        st.live = false;
        st.hasAudio = false;
        st.type = 'empty';
        io.to(currentRoom.id).emit('station-off-air', st.id);
      }
    });
    currentRoom.users.delete(userId);
    io.to(currentRoom.id).emit('user-left', userId);
    io.to(currentRoom.id).emit('user-count', currentRoom.users.size);
    console.log(`- ${userName} left (${currentRoom.users.size} users)`);
    if (currentRoom.users.size === 0 && currentRoom.stations.length === 0 && currentRoom.notes.length === 0 && currentRoom.zines.length === 0) {
      rooms.delete(currentRoom.id);
    }
  });
});

// cleanup empty rooms every 5 min
setInterval(() => {
  for (const [id, room] of rooms) {
    if (room.users.size === 0 && Date.now() - room.created > 300000) {
      rooms.delete(id);
    }
  }
}, 300000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🌾 Little Field — spatial audio platform`);
  console.log(`   http://localhost:${PORT}\n`);
});
