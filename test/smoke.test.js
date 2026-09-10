const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { io } = require('socket.io-client');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-021tv';
process.env.ADMIN_PASSWORD = 'admin-test-password';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), '021tv-'));

const { start, stop } = require('../server');
let baseUrl;
let clientCookies = '';
let adminCookies = '';
let clientUsername;

function mergeCookies(current, response) {
  const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  const jar = new Map();
  for (const item of current.split(';')) {
    const index = item.indexOf('=');
    if (index > 0) jar.set(item.slice(0, index), item.slice(index + 1));
  }
  for (const item of setCookies) {
    const pair = item.split(';', 1)[0];
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}

async function request(urlPath, options = {}, cookieJar = '') {
  const headers = { ...(options.headers || {}) };
  if (cookieJar) headers.Cookie = cookieJar;
  const response = await fetch(baseUrl + urlPath, { ...options, headers });
  const data = await response.json();
  return { response, data, cookies: mergeCookies(cookieJar, response) };
}

function waitForSocketEvent(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout aguardando evento ${event}`)), 3000);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

test.before(async () => {
  const address = await start(0);
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  await stop();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('fluxo completo de visitante, cadastro, login e chat do admin', async () => {
  let result = await request('/healthz');
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.data, { ok: true });

  result = await request('/api/guest');
  assert.equal(result.response.status, 200);
  clientCookies = result.cookies;
  const guestId = result.data.guestId;
  assert.match(guestId, /^visitante-[a-f0-9]{8}$/);

  result = await request(`/api/chat/${encodeURIComponent(guestId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Olá, quero conhecer os planos.' }),
  }, clientCookies);
  assert.equal(result.response.status, 200);

  result = await request('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Cliente Smoke',
      username: 'cliente_smoke',
      email: 'cliente@example.com',
      password: 'senha-segura',
    }),
  }, clientCookies);
  assert.equal(result.response.status, 200);
  clientCookies = result.cookies;
  clientUsername = result.data.username;
  assert.equal(clientUsername, 'cliente_smoke');

  result = await request(`/api/chat/${clientUsername}`, {}, clientCookies);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.messages.some((message) => message.text.includes('conhecer os planos')), true);
  assert.equal(result.data.messages.at(-1).from, 'admin');

  result = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin-test-password' }),
  });
  assert.equal(result.response.status, 200);
  adminCookies = result.cookies;
  assert.equal(result.data.role, 'admin');

  result = await request('/api/threads', {}, adminCookies);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.threads.some((thread) => thread.id === clientUsername), true);
  assert.equal(result.data.threads.find((thread) => thread.id === clientUsername).status, 'open');

  result = await request(`/api/threads/${clientUsername}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'closed' }),
  }, adminCookies);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.thread.status, 'closed');

  result = await request('/api/threads', {}, adminCookies);
  assert.equal(result.data.threads.find((thread) => thread.id === clientUsername).status, 'closed');

  result = await request(`/api/threads/${clientUsername}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'archived' }),
  }, adminCookies);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.thread.status, 'archived');

  result = await request(`/api/chat/${clientUsername}`, {}, adminCookies);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.messages.some((message) => message.text.includes('conhecer os planos')), true);

  result = await request(`/api/threads/${clientUsername}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'open' }),
  }, adminCookies);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.thread.status, 'open');

  result = await request(`/api/chat/${clientUsername}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Olá, vou te ajudar com os planos.' }),
  }, adminCookies);
  assert.equal(result.response.status, 200);

  const adminSocket = io(baseUrl, { extraHeaders: { Cookie: adminCookies }, transports: ['websocket'] });
  const clientSocket = io(baseUrl, { extraHeaders: { Cookie: clientCookies }, transports: ['websocket'] });
  try {
    await Promise.all([waitForSocketEvent(adminSocket, 'connect'), waitForSocketEvent(clientSocket, 'connect')]);
    adminSocket.emit('join-admin');
    adminSocket.emit('join-thread', clientUsername);
    clientSocket.emit('join-thread', clientUsername);
    const newMessage = waitForSocketEvent(clientSocket, 'newMessage');

    result = await request(`/api/chat/${clientUsername}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Mensagem em tempo real.' }),
    }, adminCookies);
    assert.equal(result.response.status, 200);
    const socketPayload = await newMessage;
    assert.equal(socketPayload.threadId, clientUsername);
    assert.equal(socketPayload.message.text, 'Mensagem em tempo real.');
  } finally {
    adminSocket.close();
    clientSocket.close();
  }

  result = await request(`/api/chat/${clientUsername}`, {}, clientCookies);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.messages.at(-1).text, 'Mensagem em tempo real.');

  result = await request(`/api/threads/${clientUsername}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'closed' }),
  }, clientCookies);
  assert.equal(result.response.status, 403);
});

test('cadastro rejeita dados inválidos e usuário duplicado', async () => {
  let result = await request('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'A', username: 'x', password: '123' }),
  });
  assert.equal(result.response.status, 400);

  result = await request('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Outro Cliente', username: 'cliente_smoke', password: 'senha-segura' }),
  });
  assert.equal(result.response.status, 409);
});
