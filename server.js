require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');

const PORT = Number(process.env.PORT) || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || (IS_PRODUCTION ? null : 'dev-only-secret-change-me');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (IS_PRODUCTION ? null : 'admin021');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_PATH = path.join(DATA_DIR, 'db.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const AUTO_REPLY_TEXT = 'Recebemos sua mensagem. Dentro de alguns minutos, um atendente humano irá conversar com você.';

if (!JWT_SECRET) throw new Error('JWT_SECRET precisa ser definido em produção.');
if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD precisa ser definido em produção.');

function emptyDB() {
  return { users: {}, threads: [], messages: {} };
}

function normalizeThread(thread) {
  const source = thread && typeof thread === 'object' ? thread : {};
  const status = ['open', 'closed', 'archived'].includes(source.status) ? source.status : 'open';
  return {
    ...source,
    id: String(source.id || ''),
    name: String(source.name || source.id || 'Conversa'),
    kind: source.kind === 'guest' ? 'guest' : 'client',
    status,
    createdAt: Number(source.createdAt) || Date.now(),
    updatedAt: Number(source.updatedAt) || Number(source.createdAt) || Date.now(),
  };
}

function normalizeDB(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    users: source.users && typeof source.users === 'object' ? source.users : {},
    threads: Array.isArray(source.threads) ? source.threads.map(normalizeThread).filter((thread) => thread.id) : [],
    messages: source.messages && typeof source.messages === 'object' ? source.messages : {},
  };
}

function loadDB() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) return emptyDB();
  try {
    return normalizeDB(JSON.parse(fs.readFileSync(DB_PATH, 'utf8')));
  } catch (error) {
    console.error('Falha ao ler db.json; iniciando um banco novo:', error.message);
    return emptyDB();
  }
}

let db = loadDB();
let writeQueue = Promise.resolve();
let bootstrapPromise = null;

function saveDB() {
  writeQueue = writeQueue.then(async () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tempPath = DB_PATH + '.tmp';
    await fs.promises.writeFile(tempPath, JSON.stringify(db, null, 2));
    await fs.promises.rename(tempPath, DB_PATH);
  });
  return writeQueue;
}

async function ensureAdmin() {
  const admin = db.users.admin;
  if (admin && admin.passwordHash) return;
  db.users.admin = {
    username: 'admin',
    name: 'Administrador',
    role: 'admin',
    passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 10),
    createdAt: admin?.createdAt || Date.now(),
  };
  await saveDB();
  console.log('Usuário admin disponível. Defina ADMIN_PASSWORD no ambiente para escolher a senha.');
}

function cookieOptions(maxAge) {
  return {
    maxAge,
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
    path: '/',
  };
}

function guestCookieOptions() {
  return {
    maxAge: 1000 * 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
    path: '/',
  };
}

/* ---------------- app / http / socket.io ---------------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 5 },
});

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

/* ---------------- helpers de autenticação ---------------- */
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

function getAuthUser(req) {
  const token = req.cookies?.token;
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function ensureGuestId(req, res) {
  let gid = req.cookies?.guestId;
  if (!gid || !/^visitante-[a-f0-9]{8}$/.test(gid)) {
    gid = 'visitante-' + crypto.randomBytes(4).toString('hex');
    res.cookie('guestId', gid, guestCookieOptions());
  }
  return gid;
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function getThread(id) {
  return db.threads.find((thread) => thread.id === id);
}

function touchThread(id, changes = {}) {
  const thread = getThread(id);
  if (!thread) return null;
  Object.assign(thread, changes, { updatedAt: Date.now() });
  return thread;
}

function validateSignup(body) {
  const name = cleanText(body?.name, 80);
  const username = cleanText(body?.username, 24).toLowerCase();
  const email = cleanText(body?.email, 160).toLowerCase();
  const password = typeof body?.password === 'string' ? body.password : '';

  if (name.length < 2) return { error: 'Informe seu nome completo.' };
  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    return { error: 'O usuário deve ter de 3 a 24 caracteres: letras, números ou _.', username };
  }
  if (password.length < 6 || password.length > 128) {
    return { error: 'A senha deve ter entre 6 e 128 caracteres.', username };
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: 'Informe um e-mail válido.', username };
  }
  return { name, username, email, password };
}

function canAccessThread(req, threadId) {
  const auth = getAuthUser(req);
  if (auth?.role === 'admin') return true;
  if (auth?.username === threadId) return true;
  return Boolean(req.cookies?.guestId && req.cookies.guestId === threadId);
}

function parseCookieHeader(header) {
  const cookies = {};
  for (const item of String(header || '').split(';')) {
    const index = item.indexOf('=');
    if (index < 0) continue;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function getSocketIdentity(socket) {
  const cookies = parseCookieHeader(socket.handshake.headers.cookie);
  let auth = null;
  if (cookies.token) {
    try { auth = jwt.verify(cookies.token, JWT_SECRET); } catch { /* token inválido */ }
  }
  return { auth, guestId: cookies.guestId || null };
}

function canSocketAccess(socket, threadId) {
  const { auth, guestId } = socket.data.identity;
  return auth?.role === 'admin' || auth?.username === threadId || guestId === threadId;
}

/* ---------------- rotas de saúde e autenticação ---------------- */
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.post('/api/auth/signup', async (req, res, next) => {
  try {
    const input = validateSignup(req.body || {});
    if (input.error) return res.status(400).json({ error: input.error });
    if (input.username === 'admin') return res.status(400).json({ error: 'Esse usuário não está disponível.' });
    if (db.users[input.username]) return res.status(409).json({ error: 'Esse usuário já existe. Tente outro.' });

    db.users[input.username] = {
      username: input.username,
      name: input.name,
      email: input.email,
      passwordHash: bcrypt.hashSync(input.password, 10),
      role: 'client',
      createdAt: Date.now(),
    };

    if (!db.threads.some((thread) => thread.id === input.username)) {
      db.threads.push({ id: input.username, name: input.name, kind: 'client', status: 'open', createdAt: Date.now(), updatedAt: Date.now() });
    }

    const guestId = req.cookies?.guestId;
    const history = guestId && Array.isArray(db.messages[guestId]) ? db.messages[guestId].slice() : [];
    history.push({
      from: 'admin',
      text: `Olá, ${input.name}! Bem-vindo(a) à 021 TV. Recebemos seu contato e, dentro de alguns minutos, um atendente humano irá conversar com você.`,
      ts: Date.now(),
    });
    db.messages[input.username] = history;

    if (guestId && guestId !== input.username) {
      delete db.messages[guestId];
      db.threads = db.threads.filter((thread) => thread.id !== guestId);
    }

    touchThread(input.username, { status: 'open' });
    await saveDB();
    res.cookie('token', signToken({ username: input.username, role: 'client' }), cookieOptions(1000 * 60 * 60 * 24 * 30));
    res.json({ username: input.username, name: input.name, role: 'client' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', (req, res) => {
  const username = cleanText(req.body?.username, 24).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = db.users[username];
  if (!user || !user.passwordHash || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }
  res.cookie('token', signToken({ username: user.username, role: user.role }), cookieOptions(1000 * 60 * 60 * 24 * 30));
  res.json({ username: user.username, name: user.name, role: user.role });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token', cookieOptions(0));
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const auth = getAuthUser(req);
  const user = auth && db.users[auth.username];
  if (!user) return res.json({ user: null });
  res.json({ user: { username: user.username, name: user.name, role: user.role } });
});

app.get('/api/guest', (req, res) => {
  res.json({ guestId: ensureGuestId(req, res) });
});

/* ---------------- rotas de chat ---------------- */
app.get('/api/chat/:id', (req, res) => {
  const id = cleanText(req.params.id, 80);
  if (!canAccessThread(req, id)) return res.status(403).json({ error: 'Sem acesso a essa conversa.' });
  res.json({ messages: Array.isArray(db.messages[id]) ? db.messages[id] : [] });
});

app.get('/api/chat/:id/attachments/:filename', (req, res) => {
  const id = cleanText(req.params.id, 80);
  const filename = cleanText(req.params.filename, 120);
  if (!canAccessThread(req, id)) return res.status(403).json({ error: 'Sem acesso a essa conversa.' });
  if (!/^[a-z0-9_-]+$/i.test(id)) return res.status(404).end();
  if (!/^[a-f0-9-]+\.[a-z0-9]{1,10}$/i.test(filename)) return res.status(404).end();
  const threadRoot = path.resolve(UPLOADS_DIR, id);
  const filePath = path.resolve(threadRoot, filename);
  if (!filePath.startsWith(threadRoot + path.sep) || !fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

async function saveUploadedFiles(id, files) {
  if (!files?.length) return [];
  const threadDir = path.join(UPLOADS_DIR, id);
  await fs.promises.mkdir(threadDir, { recursive: true });
  const attachments = [];
  for (const file of files) {
    const extension = path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10) || '.bin';
    const filename = crypto.randomUUID() + extension;
    await fs.promises.writeFile(path.join(threadDir, filename), file.buffer);
    attachments.push({
      name: cleanText(file.originalname || 'arquivo', 160) || 'arquivo',
      mimeType: file.mimetype || 'application/octet-stream',
      size: file.size,
      url: `/api/chat/${encodeURIComponent(id)}/attachments/${filename}`,
    });
  }
  return attachments;
}

app.post('/api/chat/:id', upload.array('files', 5), async (req, res, next) => {
  try {
    const id = cleanText(req.params.id, 80);
    const text = cleanText(req.body?.text, 2000);
    if (!text && !req.files?.length) return res.status(400).json({ error: 'Escreva uma mensagem ou selecione um arquivo.' });
    if (!canAccessThread(req, id)) return res.status(403).json({ error: 'Sem acesso a essa conversa.' });

    const auth = getAuthUser(req);
    const from = auth?.role === 'admin' ? 'admin' : 'client';
    if (!db.threads.some((thread) => thread.id === id) && from === 'client') {
      const isGuest = !auth;
      db.threads.push({
        id,
        name: isGuest ? 'Visitante ' + id.slice(-4) : db.users[id]?.name || id,
        kind: isGuest ? 'guest' : 'client',
        status: 'open',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    const attachments = await saveUploadedFiles(id, req.files);
    const message = { from, text, attachments, ts: Date.now() };
    db.messages[id] = Array.isArray(db.messages[id]) ? db.messages[id] : [];
    db.messages[id].push(message);
    const shouldAutoReply = from === 'client' && !db.messages[id].some((item) => item.from === 'admin');
    const autoReply = shouldAutoReply ? { from: 'admin', text: AUTO_REPLY_TEXT, ts: Date.now() + 1 } : null;
    if (autoReply) db.messages[id].push(autoReply);
    touchThread(id, { status: 'open' });
    await saveDB();

    io.to('thread:' + id).emit('newMessage', { threadId: id, message });
    if (autoReply) io.to('thread:' + id).emit('newMessage', { threadId: id, message: autoReply });
    io.to('admin').emit('threadUpdated', { id });
    res.json({ ok: true, message, autoReply });
  } catch (error) {
    next(error);
  }
});

app.get('/api/threads', (req, res) => {
  const auth = getAuthUser(req);
  if (!auth || auth.role !== 'admin') return res.status(403).json({ error: 'Somente admin.' });
  const threads = db.threads.map((thread) => {
    const messages = Array.isArray(db.messages[thread.id]) ? db.messages[thread.id] : [];
    const last = messages.length ? messages[messages.length - 1] : null;
    const liveName = thread.kind === 'client' && db.users[thread.id] ? db.users[thread.id].name : thread.name;
    return { id: thread.id, name: liveName, kind: thread.kind, status: thread.status || 'open', updatedAt: thread.updatedAt || last?.ts || 0, last };
  }).sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({ threads });
});

app.patch('/api/threads/:id/status', async (req, res, next) => {
  try {
    const auth = getAuthUser(req);
    if (!auth || auth.role !== 'admin') return res.status(403).json({ error: 'Somente admin.' });
    const id = cleanText(req.params.id, 80);
    const status = cleanText(req.body?.status, 20);
    if (!['open', 'closed', 'archived'].includes(status)) return res.status(400).json({ error: 'Status inválido.' });
    const thread = touchThread(id, { status });
    if (!thread) return res.status(404).json({ error: 'Conversa não encontrada.' });
    if (status === 'closed') thread.closedAt = Date.now();
    if (status === 'archived') thread.archivedAt = Date.now();
    await saveDB();
    io.to('admin').emit('threadUpdated', { id });
    io.to('thread:' + id).emit('threadStatusChanged', { threadId: id, status });
    res.json({ ok: true, thread: { id: thread.id, status: thread.status } });
  } catch (error) {
    next(error);
  }
});

/* ---------------- socket.io (chat em tempo real) ---------------- */
io.use((socket, next) => {
  socket.data.identity = getSocketIdentity(socket);
  next();
});

io.on('connection', (socket) => {
  socket.on('join-thread', (threadId) => {
    const id = cleanText(threadId, 80);
    if (id && canSocketAccess(socket, id)) socket.join('thread:' + id);
  });
  socket.on('join-admin', () => {
    if (socket.data.identity.auth?.role === 'admin') socket.join('admin');
  });
});

/* ---------------- respostas de erro e fallback SPA ---------------- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE' ? 'Cada arquivo pode ter no máximo 10 MB.' : error.code === 'LIMIT_FILE_COUNT' ? 'Envie no máximo 5 arquivos por mensagem.' : 'Não foi possível receber os arquivos.';
    return res.status(400).json({ error: message });
  }
  console.error('Erro interno:', error);
  if (res.headersSent) return next(error);
  if (req.path.startsWith('/api')) return res.status(500).json({ error: 'Erro interno do servidor.' });
  res.status(500).send('Erro interno do servidor.');
});
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

async function start(port = PORT) {
  if (!bootstrapPromise) bootstrapPromise = ensureAdmin();
  await bootstrapPromise;
  return new Promise((resolve) => {
    if (server.listening) return resolve(server.address());
    server.listen(port, () => {
      console.log('021 TV rodando na porta ' + server.address().port);
      resolve(server.address());
    });
  });
}

async function stop() {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

if (require.main === module) {
  start().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { app, server, start, stop };
