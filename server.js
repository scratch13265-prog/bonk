'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_MESSAGE = 16 * 1024;
const rooms = new Map();
const peers = new Set();
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function send(peer, value) {
  if (!peer.closed && !peer.socket.destroyed) writeFrame(peer.socket, 0x1, Buffer.from(JSON.stringify(value)));
}

function writeFrame(socket, opcode, payload = Buffer.alloc(0)) {
  if (socket.destroyed) return;
  const n = payload.length;
  let head;
  if (n < 126) { head = Buffer.from([0x80 | opcode, n]); }
  else if (n <= 65535) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  socket.write(Buffer.concat([head, payload]));
}

function closePeer(peer) {
  if (peer.closed) return;
  peer.closed = true;
  peers.delete(peer);
  const code = peer.roomCode;
  peer.roomCode = null;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  room.clients.delete(peer);
  for (const other of room.clients) send(other, { t: 'peer', count: room.clients.size });
  if (!room.clients.size) rooms.delete(code);
}

function makeRoomCode() {
  let code;
  do { code = String(1000 + crypto.randomInt(9000)); } while (rooms.has(code));
  return code;
}

function handleMessage(peer, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString('utf8')); } catch { send(peer, { t: 'error', message: 'Повреждённое сообщение.' }); return; }
  if (!msg || typeof msg !== 'object') return;

  if (msg.t === 'create') {
    if (peer.roomCode) return;
    const code = makeRoomCode();
    rooms.set(code, { clients: new Set([peer]) });
    peer.roomCode = code;
    send(peer, { t: 'created', room: code, count: 1 });
    return;
  }

  if (msg.t === 'join') {
    const code = String(msg.room || '').trim();
    const room = rooms.get(code);
    if (!/^\d{4}$/.test(code) || !room) { send(peer, { t: 'error', message: 'Комната не найдена. Проверь код и адрес сервера.' }); return; }
    if (room.clients.size >= 2) { send(peer, { t: 'error', message: 'В комнате уже два игрока.' }); return; }
    if (peer.roomCode) closePeer(peer);
    room.clients.add(peer);
    peer.roomCode = code;
    send(peer, { t: 'joined', room: code, count: 2 });
    for (const other of room.clients) if (other !== peer) send(other, { t: 'peer', count: 2 });
    return;
  }

  const room = peer.roomCode && rooms.get(peer.roomCode);
  if (!room) { send(peer, { t: 'error', message: 'Сначала создай комнату или войди по коду.' }); return; }
  if (!['st', 'hit', 'ch2', 'pvp-state', 'pvp-hit', 'pvp-rematch'].includes(msg.t)) return;
  const payload = { ...msg, id: peer.id };
  const encoded = Buffer.from(JSON.stringify(payload));
  if (encoded.length > 12 * 1024) return;
  for (const other of room.clients) if (other !== peer) writeFrame(other.socket, 0x1, encoded);
}

function readFrames(peer, chunk) {
  peer.buffer = Buffer.concat([peer.buffer, chunk]);
  while (peer.buffer.length >= 2) {
    const b0 = peer.buffer[0], b1 = peer.buffer[1];
    if ((b0 & 0x70) !== 0 || !(b0 & 0x80)) { peer.socket.destroy(); return; }
    const opcode = b0 & 0x0f, masked = !!(b1 & 0x80);
    let length = b1 & 0x7f, offset = 2;
    if (length === 126) { if (peer.buffer.length < 4) return; length = peer.buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (peer.buffer.length < 10) return; const big = peer.buffer.readBigUInt64BE(2); if (big > BigInt(MAX_MESSAGE)) { peer.socket.destroy(); return; } length = Number(big); offset = 10; }
    if (!masked || length > MAX_MESSAGE) { peer.socket.destroy(); return; }
    if (peer.buffer.length < offset + 4 + length) return;
    const mask = peer.buffer.subarray(offset, offset + 4); offset += 4;
    const payload = Buffer.from(peer.buffer.subarray(offset, offset + length));
    peer.buffer = peer.buffer.subarray(offset + length);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    if (opcode === 0x8) { writeFrame(peer.socket, 0x8, payload.subarray(0, 125)); peer.socket.end(); return; }
    if (opcode === 0x9) { writeFrame(peer.socket, 0xA, payload); continue; }
    if (opcode === 0xA) { peer.alive = true; continue; }
    if (opcode !== 0x1) { peer.socket.destroy(); return; }
    handleMessage(peer, payload);
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    const body = JSON.stringify({ ok: true, service: 'Bonk Club multiplayer', rooms: rooms.size, players: peers.size });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(body); return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found');
});

server.on('upgrade', (req, socket, head) => {
  const key = req.headers['sec-websocket-key'];
  if (req.url !== '/ws' || req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const peer = { id: crypto.randomUUID(), socket, roomCode: null, buffer: Buffer.alloc(0), alive: true, closed: false };
  peers.add(peer);
  socket.on('data', data => readFrames(peer, data));
  socket.on('close', () => closePeer(peer));
  socket.on('error', () => closePeer(peer));
  if (head && head.length) readFrames(peer, head);
});

const heartbeat = setInterval(() => {
  for (const peer of peers) {
    if (!peer.alive) { peer.socket.destroy(); closePeer(peer); continue; }
    peer.alive = false;
    writeFrame(peer.socket, 0x9, Buffer.alloc(0));
  }
}, 25_000);

server.listen(PORT, HOST, () => console.log(`Bonk Club multiplayer server listening on ${HOST}:${PORT}`));
function shutdown() { clearInterval(heartbeat); for (const peer of peers) { writeFrame(peer.socket, 0x8, Buffer.alloc(0)); peer.socket.end(); } server.close(() => process.exit(0)); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
