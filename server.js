// server.js
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const DB_FILE = path.join(__dirname, 'db.json');
let db = { users: {}, messages: {}, groups: {} };
if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { console.error('DB load fail', e); }
}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const genId = () => Math.random().toString(36).slice(2, 10);

// online: code -> socket.id
const online = new Map();

function publicUser(u) {
  return { code: u.code, name: u.name, photo: u.photo || null, stars: u.stars || 0, online: online.has(u.code) };
}
function friendsOf(u) {
  return (u.friends || []).map(c => db.users[c]).filter(Boolean).map(publicUser);
}
function groupsOf(u) {
  return (u.groups || []).map(gid => db.groups[gid]).filter(Boolean).map(g => ({
    id: g.id, name: g.name, members: g.members, photo: g.photo || null
  }));
}

io.on('connection', (socket) => {
  let myCode = null;

  socket.on('register', ({ code, name, pass, photo }, cb) => {
    if (!code || !name || !pass) return cb?.({ ok: false, error: 'Missing fields' });
    code = String(code).toUpperCase();
    let u = db.users[code];
    if (u) {
      if (u.pass !== pass) return cb?.({ ok: false, error: 'Неверный пароль' });
      if (photo) u.photo = photo;
    } else {
      u = { code, name, pass, photo: photo || null, stars: 0, friends: [], groups: [], createdAt: Date.now() };
      db.users[code] = u;
      save();
    }
    myCode = code;
    online.set(code, socket.id);
    socket.join('user:' + code);

    // уведомить друзей об онлайне
    u.friends.forEach(c => {
      const sid = online.get(c);
      if (sid) io.to(sid).emit('friendOnline', { code, online: true });
    });

    cb?.({
      ok: true,
      user: publicUser(u),
      friends: friendsOf(u),
      groups: groupsOf(u),
    });
  });

  socket.on('sendMessage', (payload) => {
    if (!myCode) return;
    const msg = {
      id: genId(),
      from: myCode,
      kind: payload.kind || 'text',
      text: payload.text || '',
      ts: Date.now(),
      reactions: {},
    };
    if (payload.groupId) {
      const g = db.groups[payload.groupId];
      if (!g || !g.members.includes(myCode)) return;
      msg.groupId = payload.groupId;
      (db.messages['g:' + payload.groupId] ||= []).push(msg);
      save();
      g.members.forEach(c => {
        const sid = online.get(c);
        if (sid) io.to(sid).emit('newMessage', { from: myCode, message: msg });
      });
      socket.emit('messageSent', { groupId: payload.groupId, message: msg });
    } else {
      const to = String(payload.to || '').toUpperCase();
      if (!db.users[to]) return;
      msg.to = to;
      (db.messages[myCode + ':' + to] ||= []).push(msg);
      (db.messages[to + ':' + myCode] ||= []).push(msg);
      save();
      const sid = online.get(to);
      if (sid) io.to(sid).emit('newMessage', { from: myCode, message: msg });
      socket.emit('messageSent', { to, message: msg });
    }
  });

  socket.on('loadHistory', ({ withCode, groupId }, cb) => {
    if (groupId) {
      cb?.({ history: db.messages['g:' + groupId] || [] });
    } else {
      const key = [myCode, withCode].sort().join(':');
      cb?.({ history: db.messages[key] || [] });
    }
  });

  socket.on('markRead', () => {});

  socket.on('reactToMessage', ({ id, emoji }) => {
    if (!myCode) return;
    let found = null, key = null;
    for (const k of Object.keys(db.messages)) {
      const m = db.messages[k].find(x => x.id === id);
      if (m) { found = m; key = k; break; }
    }
    if (!found) return;
    found.reactions[emoji] ||= [];
    const i = found.reactions[emoji].indexOf(myCode);
    if (i >= 0) found.reactions[emoji].splice(i, 1);
    else found.reactions[emoji].push(myCode);
    if (!found.reactions[emoji].length) delete found.reactions[emoji];
    save();

    // Разослать всем участникам
    const participants = new Set([found.from]);
    if (found.groupId) {
      db.groups[found.groupId].members.forEach(c => participants.add(c));
    } else {
      participants.add(found.to);
    }
    participants.forEach(c => {
      const sid = online.get(c);
      if (sid) io.to(sid).emit('messageReacted', { id, reactions: found.reactions });
    });
  });

  socket.on('searchUsers', ({ query }, cb) => {
    const q = String(query || '').toLowerCase();
    const users = Object.values(db.users)
      .filter(u => u.code !== myCode && (u.name.toLowerCase().includes(q) || u.code.toLowerCase().includes(q)))
      .slice(0, 20)
      .map(publicUser);
    cb?.({ ok: true, users });
  });

  socket.on('addFriendByCode', ({ code }, cb) => {
    if (!myCode) return cb?.({ ok: false, error: 'Not registered' });
    code = String(code || '').toUpperCase();
    if (code === myCode) return cb?.({ ok: false, error: 'Это вы' });
    const target = db.users[code];
    if (!target) return cb?.({ ok: false, error: 'Пользователь не найден' });
    const me = db.users[myCode];
    if (!me.friends.includes(code)) me.friends.push(code);
    if (!target.friends.includes(myCode)) target.friends.push(myCode);
    save();

    // Уведомить обе стороны
    io.to(socket.id).emit('friendAdded', publicUser(target));
    const sid = online.get(code);
    if (sid) io.to(sid).emit('friendAdded', publicUser(me));

    cb?.({ ok: true, friend: publicUser(target) });
  });

  socket.on('disconnect', () => {
    if (!myCode) return;
    if (online.get(myCode) === socket.id) online.delete(myCode);
    const u = db.users[myCode];
    if (u) u.friends.forEach(c => {
      const sid = online.get(c);
      if (sid) io.to(sid).emit('friendOnline', { code: myCode, online: false });
    });
  });
});

server.listen(3000, () => console.log('Volna server on :3000'));
