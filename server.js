const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 20e6 });
app.use(express.static(path.join(__dirname, 'public')));

const users = {};
const messages = {};
const groups = {};
const keyOf = (a, b) => [a, b].sort().join('|');
const findSocket = (code) => {
  const u = users[code];
  return u && u.socketId ? io.sockets.sockets.get(u.socketId) : null;
};
const pub = (u) => ({ code: u.code, name: u.name, photo: u.photo, stars: u.stars, isAdmin: !!u.isAdmin });
const pubF = (u) => ({ code: u.code, name: u.name, photo: u.photo, online: !!u.online });

io.on('connection', (socket) => {

  // ---------- РЕГИСТРАЦИЯ ----------
  socket.on('register', ({ code, name, pass, photo }, cb) => {
    let u = users[code];
    if (u) {
      if (u.pass !== pass) return cb({ ok: false, error: 'Неверный пароль' });
      if (photo) u.photo = photo;
      u.online = true;
      u.socketId = socket.id;
    } else {
      u = users[code] = {
        code, name, pass, photo: photo || null,
        stars: 100, friends: [], online: true, socketId: socket.id,
        isAdmin: code === 'ADMIN' || code === 'ADMIN2'
      };
    }
    socket.data.code = code;
    const friends = u.friends.map(c => users[c]).filter(Boolean).map(pubF);
    const myGroups = Object.values(groups).filter(g => g.members.includes(code));
    cb({ ok: true, user: pub(u), friends, groups: myGroups });
    u.friends.forEach(c => findSocket(c)?.emit('friendOnline', { code, online: true }));
  });

  // ---------- ПОИСК ПОЛЬЗОВАТЕЛЕЙ ----------
  socket.on('searchUsers', ({ query }, cb) => {
    const me = socket.data.code;
    if (!me) return cb({ ok: false });
    const q = (query || '').toLowerCase().trim();
    if (!q) return cb({ ok: true, users: [] });
    const meUser = users[me];
    const results = Object.values(users)
      .filter(u => u.code !== me && !meUser.friends.includes(u.code))
      .filter(u => u.name.toLowerCase().includes(q) || u.code.toLowerCase().includes(q))
      .slice(0, 20)
      .map(u => ({ ...pubF(u), isFriend: false }));
    cb({ ok: true, users: results });
  });

  // ---------- ДОБАВИТЬ ПО КОДУ ----------
  socket.on('addFriendByCode', ({ code }, cb) => {
    const me = socket.data.code;
    if (!me) return cb({ ok: false });
    const meUser = users[me];
    const target = users[(code || '').toUpperCase().trim()];
    if (!target) return cb({ ok: false, error: 'Пользователь не найден' });
    if (target.code === me) return cb({ ok: false, error: 'Это вы' });
    if (meUser.friends.includes(target.code)) return cb({ ok: false, error: 'Уже в друзьях' });
    meUser.friends.push(target.code);
    target.friends.push(meUser.code);
    const selfData = pubF(meUser); selfData.online = true;
    const targetData = pubF(target); targetData.online = !!target.online;
    socket.emit('friendAdded', targetData);
    findSocket(target.code)?.emit('friendAdded', selfData);
    cb({ ok: true, friend: targetData });
  });

  // ---------- ИСТОРИЯ / СООБЩЕНИЯ ----------
  socket.on('loadHistory', ({ withCode, groupId }, cb) => {
    const me = socket.data.code;
    if (!me) return cb({ history: [] });
    const k = groupId || keyOf(me, withCode);
    cb({ history: messages[k] || [] });
  });

  socket.on('sendMessage', (payload) => {
    const from = socket.data.code;
    if (!from) return;
    const msg = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      from, ts: Date.now(), ...payload
    };
    if (payload.groupId) {
      const g = groups[payload.groupId]; if (!g) return;
      (messages[payload.groupId] = messages[payload.groupId] || []).push(msg);
      g.members.forEach(c => { if (c !== from) findSocket(c)?.emit('newMessage', { from, message: msg }); });
    } else {
      const k = keyOf(from, payload.to);
      (messages[k] = messages[k] || []).push(msg);
      findSocket(payload.to)?.emit('newMessage', { from, message: msg });
    }
    socket.emit('messageSent', { to: payload.to, groupId: payload.groupId, message: msg });
  });

  socket.on('markRead', ({ withCode }) => {
    const me = socket.data.code;
    if (!me || !withCode) return;
    const k = keyOf(me, withCode);
    (messages[k] || []).forEach(m => { if (m.from === withCode && !m.read_at) m.read_at = Date.now(); });
    findSocket(withCode)?.emit('messagesRead', { by: me, at: Date.now() });
  });

  socket.on('reactToMessage', ({ id, emoji }) => {
    const me = socket.data.code;
    for (const k in messages) {
      const m = messages[k].find(x => x.id === id);
      if (m) {
        m.reactions = m.reactions || {};
        m.reactions[emoji] = m.reactions[emoji] || [];
        const idx = m.reactions[emoji].indexOf(me);
        if (idx >= 0) m.reactions[emoji].splice(idx, 1);
        else m.reactions[emoji].push(me);
        if (!m.reactions[emoji].length) delete m.reactions[emoji];
        io.emit('messageReacted', { id, reactions: m.reactions });
        return;
      }
    }
  });

  socket.on('typing', ({ to, groupId, typing }) => {
    const me = socket.data.code;
    if (groupId) {
      groups[groupId]?.members.forEach(c => { if (c !== me) findSocket(c)?.emit('friendTyping', { from: me, groupId, typing }); });
    } else if (to) {
      findSocket(to)?.emit('friendTyping', { from: me, typing });
    }
  });

  socket.on('createGroup', ({ name, members }, cb) => {
    const me = socket.data.code;
    if (!me || !name) return cb({ ok: false });
    const id = 'g_' + Date.now().toString(36);
    const all = Array.from(new Set([...(members || []), me]));
    groups[id] = { id, name, members: all };
    all.forEach(c => findSocket(c)?.emit('groupAdded', groups[id]));
    cb({ ok: true, group: groups[id] });
  });

  socket.on('disconnect', () => {
    const me = users[socket.data.code];
    if (me && me.socketId === socket.id) {
      me.online = false;
      me.socketId = null;
      me.friends.forEach(c => findSocket(c)?.emit('friendOnline', { code: me.code, online: false }));
    }
  });
});

server.listen(3000, () => console.log('Volna: http://localhost:3000'));
