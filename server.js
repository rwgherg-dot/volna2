 'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ADMIN_CODES = (process.env.ADMIN_CODES || 'ADMIN,ADMIN2').split(',').map(s => s.trim());

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ================= ХРАНИЛИЩЕ =================
const users = {};          // code -> user
const socketByCode = {};   // code -> socket.id
const messages = {};       // "A|B" (сортированные) или "G:groupId" -> [messages]
const groups = {};         // groupId -> {id,name,members[],photo}
const stories = [];        // [{id,from,fromName,media,ts}]
const reviews = {};        // targetCode -> [{id,from,fromName,text,ts}]
const purchases = [];      // заявки на покупку звёзд

const pairKey = (a, b) => [a, b].sort().join('|');
const groupKey = id => 'G:' + id;

function publicUser(u) {
  return {
    code: u.code, name: u.name, photo: u.photo || null,
    stars: u.stars || 0, premium: !!u.premium, premiumUntil: u.premiumUntil || null,
    isAdmin: !!u.isAdmin, online: !!socketByCode[u.code], banned: !!u.banned
  };
}

function getMessages(key) {
  if (!messages[key]) messages[key] = [];
  return messages[key];
}

function pushMessage(key, msg) {
  getMessages(key).push(msg);
  if (messages[key].length > 500) messages[key].splice(0, messages[key].length - 500);
  return msg;
}

// ================= СОКЕТЫ =================
io.on('connection', (socket) => {
  socket.data.code = null;

  function requireAdmin(cb) {
    const u = users[socket.data.code];
    if (!u || !u.isAdmin) { cb && cb({ ok: false, error: 'Нет прав' }); return false; }
    return true;
  }

  // ---------- РЕГИСТРАЦИЯ ----------
  socket.on('register', ({ code, name, pass, photo }, cb) => {
    try {
      if (!code || !name || !pass) return cb({ ok: false, error: 'Не хватает данных' });
      code = String(code).toUpperCase().slice(0, 10);
      let u = users[code];
      if (u) {
        if (u.pass !== pass) return cb({ ok: false, error: 'Неверный пароль' });
      } else {
        u = {
          code, name: String(name).slice(0, 24), pass: String(pass).slice(0, 64),
          photo: photo || null, stars: 0, premium: false, premiumUntil: null,
          isAdmin: ADMIN_CODES.includes(code), banned: false,
          friends: [], createdAt: Date.now()
        };
        users[code] = u;
      }
      if (u.banned) return cb({ ok: false, error: 'Вы забанены' });
      if (photo) u.photo = photo;
      u.name = String(name).slice(0, 24);

      socket.data.code = code;
      if (socketByCode[code]) {
        const oldId = socketByCode[code];
        const old = io.sockets.sockets.get(oldId);
        if (old && old.id !== socket.id) old.disconnect(true);
      }
      socketByCode[code] = socket.id;

      const friends = u.friends.map(c => users[c]).filter(Boolean).map(publicUser);
      const userGroups = Object.values(groups)
        .filter(g => g.members.some(m => m.code === code))
        .map(g => ({ ...g, members: g.members.map(m => ({ ...m, online: !!socketByCode[m.code] })) }));

      // оповестить друзей
      u.friends.forEach(fc => {
        const fs = socketByCode[fc];
        if (fs) io.to(fs).emit('friendOnline', { code, online: true });
      });

      cb({ ok: true, user: publicUser(u), friends, groups: userGroups, stories: stories.slice(-30) });
    } catch (e) {
      console.error('register', e);
      cb({ ok: false, error: 'Ошибка сервера' });
    }
  });

  // ---------- ДРУЗЬЯ ----------
  socket.on('addFriend', ({ friendCode }, cb) => {
    try {
      const me = users[socket.data.code];
      if (!me) return cb({ ok: false, error: 'Не авторизован' });
      friendCode = String(friendCode || '').toUpperCase().trim();
      if (friendCode === me.code) return cb({ ok: false, error: 'Это ваш код' });
      const other = users[friendCode];
      if (!other) return cb({ ok: false, error: 'Пользователь не найден' });
      if (other.banned) return cb({ ok: false, error: 'Пользователь забанен' });
      if (!me.friends.includes(friendCode)) me.friends.push(friendCode);
      if (!other.friends.includes(me.code)) other.friends.push(me.code);
      const sId = socketByCode[friendCode];
      if (sId) io.to(sId).emit('friendAdded', publicUser(me));
      cb({ ok: true, friend: publicUser(other) });
    } catch (e) { cb({ ok: false, error: 'Ошибка' }); }
  });

  socket.on('forceAddFriend', ({ targetCode }, cb) => {
    try {
      if (!requireAdmin(cb)) return;
      const me = users[socket.data.code];
      targetCode = String(targetCode || '').toUpperCase().trim();
      const other = users[targetCode];
      if (!other) return cb({ ok: false, error: 'Не найден' });
      if (!me.friends.includes(targetCode)) me.friends.push(targetCode);
      if (!other.friends.includes(me.code)) other.friends.push(me.code);
      cb({ ok: true, friend: publicUser(other) });
    } catch (e) { cb({ ok: false, error: 'Ошибка' }); }
  });

  socket.on('searchUsers', ({ query }, cb) => {
    try {
      const me = users[socket.data.code];
      if (!me) return cb({ ok: false, error: 'Не авторизован' });
      const q = String(query || '').toLowerCase();
      const list = Object.values(users)
        .filter(u => !u.banned && u.code !== me.code)
        .filter(u => u.name.toLowerCase().includes(q) || u.code.toLowerCase().includes(q))
        .slice(0, 30)
        .map(publicUser);
      cb({ ok: true, results: list });
    } catch (e) { cb({ ok: false, error: 'Ошибка' }); }
  });

  // ---------- ИСТОРИЯ / СООБЩЕНИЯ ----------
  socket.on('loadHistory', ({ withCode, groupId }, cb) => {
    try {
      const me = users[socket.data.code];
      if (!me) return cb({ ok: false, history: [] });
      const key = groupId ? groupKey(groupId) : pairKey(me.code, String(withCode || '').toUpperCase());
      cb({ ok: true, history: getMessages(key).slice(-200) });
    } catch (e) { cb({ ok: false, history: [] }); }
  });

  socket.on('sendMessage', (payload) => {
    try {
      const me = users[socket.data.code];
      if (!me) return;
      const msg = {
        id: Math.random().toString(36).slice(2) + Date.now().toString(36),
        from: me.code, fromName: me.name,
        kind: payload.kind || 'text',
        text: payload.text || '',
        data: payload.data || null,
        replyTo: payload.replyTo || null,
        eph: payload.eph || 0,
        ts: Date.now(),
        read_at: null, reactions: {}
      };

      if (payload.groupId) {
        const g = groups[payload.groupId];
        if (!g) return;
        msg.groupId = payload.groupId;
        const key = groupKey(payload.groupId);
        pushMessage(key, msg);
        // каждому участнику
        g.members.forEach(m => {
          const s = socketByCode[m.code];
          if (s) io.to(s).emit('newMessage', { from: me.code, message: msg });
        });
        const sMe = socketByCode[me.code];
        if (sMe) io.to(sMe).emit('messageSent', { groupId: payload.groupId, message: msg });
      } else {
        const to = String(payload.to || '').toUpperCase();
        const other = users[to];
        if (!other) return;
        const key = pairKey(me.code, to);
        pushMessage(key, msg);
        const sTo = socketByCode[to];
        if (sTo) io.to(sTo).emit('newMessage', { from: me.code, message: msg });
        const sMe = socketByCode[me.code];
        if (sMe) io.to(sMe).emit('messageSent', { to, message: msg });
      }
    } catch (e) { console.error('sendMessage', e); }
  });

  socket.on('markRead', ({ withCode }) => {
    try {
      const me = users[socket.data.code];
      if (!me) return;
      const to = String(withCode || '').toUpperCase();
      const key = pairKey(me.code, to);
      const arr = getMessages(key);
      const at = Date.now();
      arr.forEach(m => { if (m.from === to && !m.read_at) m.read_at = at; });
      const sOther = socketByCode[to];
      if (sOther) io.to(sOther).emit('messagesRead', { by: me.code, at });
    } catch (e) {}
  });

  socket.on('deleteMessage', ({ id }) => {
    try {
      const me = users[socket.data.code];
      if (!me) return;
      for (const key of Object.keys(messages)) {
        const arr = messages[key];
        const idx = arr.findIndex(m => m.id === id);
        if (idx >= 0) {
          const m = arr[idx];
          if (m.from !== me.code && !me.isAdmin) return;
          arr.splice(idx, 1);
          const other = key.startsWith('G:') ? null : key.split('|').find(c => c !== me.code);
          if (other) {
            const s = socketByCode[other];
            if (s) io.to(s).emit('messageDeleted', { from: me.code, id });
          } else if (key.startsWith('G:')) {
            const gid = key.slice(2);
            const g = groups[gid];
            if (g) g.members.forEach(mm => {
              const s = socketByCode[mm.code];
              if (s) io.to(s).emit('messageDeleted', { groupId: gid, id });
            });
          }
          io.to(socket.id).emit('messageDeleted', { from: me.code, id });
          return;
        }
      }
    } catch (e) {}
  });

  socket.on('editMessage', ({ id, text }) => {
    try {
      const me = users[socket.data.code];
      if (!me) return;
      for (const key of Object.keys(messages)) {
        const m = messages[key].find(x => x.id === id);
        if (m) {
          if (m.from !== me.code && !me.isAdmin) return;
          m.text = String(text || '').slice(0, 4000);
          m.edited = true;
          // разослать всем участникам
          if (key.startsWith('G:')) {
            const gid = key.slice(2); const g = groups[gid];
            if (g) g.members.forEach(mm => {
              const s = socketByCode[mm.code];
              if (s) io.to(s).emit('messageEdited', { id, text: m.text });
            });
          } else {
            key.split('|').forEach(c => {
              const s = socketByCode[c];
              if (s) io.to(s).emit('messageEdited', { id, text: m.text });
            });
          }
          return;
        }
      }
    } catch (e) {}
  });

  socket.on('reactToMessage', ({ id, emoji }) => {
    try {
      const me = users[socket.data.code];
      if (!me) return;
      for (const key of Object.keys(messages)) {
        const m = messages[key].find(x => x.id === id);
        if (m) {
          if (!m.reactions) m.reactions = {};
          const arr = m.reactions[emoji] || (m.reactions[emoji] = []);
          const i = arr.indexOf(me.code);
          if (i >= 0) arr.splice(i, 1); else arr.push(me.code);
          const emit = (code) => {
            const s = socketByCode[code];
            if (s) io.to(s).emit('messageReacted', { id, reactions: m.reactions });
          };
          if (key.startsWith('G:')) {
            const g = groups[key.slice(2)];
            if (g) g.members.forEach(mm => emit(mm.code));
          } else key.split('|').forEach(emit);
          return;
        }
      }
    } catch (e) {}
  });

  socket.on('typing', ({ to, groupId, typing }) => {
    try {
      const me = users[socket.data.code];
      if (!me) return;
      if (groupId) {
        const g = groups[groupId];
        if (!g) return;
        g.members.forEach(m => {
          if (m.code === me.code) return;
          const s = socketByCode[m.code];
          if (s) io.to(s).emit('friendTyping', { groupId, from: me.code, typing: !!typing });
        });
      } else {
        const s = socketByCode[String(to || '').toUpperCase()];
        if (s) io.to(s).emit('friendTyping', { from: me.code, typing: !!typing });
      }
    } catch (e) {}
  });

  // ---------- ГРУППЫ ----------
  socket.on('createGroup', ({ name, members }, cb) => {
    try {
      const me = users[socket.data.code];
      if (!me) return cb({ ok: false, error: 'Не авторизован' });
      const id = 'g' + Math.random().toString(36).slice(2, 10);
      const g = {
        id, name: String(name || 'Группа').slice(0, 60),
        photo: null,
        members: [{ code: me.code, name: me.name, photo: me.photo || null }, ...(members || [])]
      };
      groups[id] = g;
      g.members.forEach(m => {
        const s = socketByCode[m.code];
        if (s) io.to(s).emit('groupAdded', g);
      });
      cb({ ok: true, group: g });
    } catch (e) { cb({ ok: false, error: 'Ошибка' }); }
  });

  // ---------- ЗВЁЗДЫ / ПРЕМИУМ ----------
  socket.on('transferStars', ({ to, amount }) => {
    try {
      if (!requireAdmin()) return;
      const target = users[String(to || '').toUpperCase()];
      if (!target) return;
      const n = Math.max(0, parseInt(amount || 0));
      target.stars = (target.stars || 0) + n;
      const s = socketByCode[target.code];
      if (s) io.to(s).emit('starsUpdated', { stars: target.stars, received: n });
    } catch (e) {}
  });

  socket.on('activatePremium', ({ to, days }) => {
    try {
      if (!requireAdmin()) return;
      const target = users[String(to || '').toUpperCase()];
      if (!target) return;
      const until = Date.now() + (parseInt(days || 30) * 86400000);
      target.premium = true;
      target.premiumUntil = until;
      const s = socketByCode[target.code];
      if (s) io.to(s).emit('premiumActivated', { until });
    } catch (e) {}
  });

  socket.on('buyStars', ({ stars, isAdmin }, cb) => {
    if (!requireAdmin(cb)) return;
    const me = users[socket.data.code];
    me.stars = (me.stars || 0) + Math.max(0, parseInt(stars || 0));
    cb && cb({ ok: true, stars: me.stars });
    io.to(socket.id).emit('starsUpdated', { stars: me.stars, received: parseInt(stars || 0) });
  });

  socket.on('requestStarPurchase', ({ stars, price }, cb) => {
    try {
      const me = users[socket.data.code];
      if (!me) return cb && cb({ ok: false, error: 'Не авторизован' });
      const req = { id: Date.now().toString(36), code: me.code, name: me.name, stars, price, ts: Date.now() };
      purchases.push(req);
      // уведомить всех админов
      Object.values(users).filter(u => u.isAdmin).forEach(a => {
        const s = socketByCode[a.code];
        if (s) io.to(s).emit('newPurchaseRequest', req);
      });
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: 'Ошибка' }); }
  });

  // ---------- ПОДАРКИ / ОТЗЫВЫ / ИСТОРИИ ----------
  socket.on('sendGift', ({ to, gift }) => {
    try {
      const me = users[socket.data.code];
      if (!me) return;
      const target = users[String(to || '').toUpperCase()];
      if (!target) return;
      me.stars = Math.max(0, (me.stars || 0) - (gift.stars || 0));
      io.to(socket.id).emit('starsUpdated', { stars: me.stars });
      const s = socketByCode[target.code];
      if (s) io.to(s).emit('giftReceived', { gift });
    } catch (e) {}
  });

  socket.on('sendReview', ({ to, text }) => {
    try {
      const me = users[socket.data.code];
      if (!me) return;
      const target = users[String(to || '').toUpperCase()];
      if (!target) return;
      if (!reviews[target.code]) reviews[target.code] = [];
      reviews[target.code].push({
        id: Date.now().toString(36), from: me.code, fromName: me.name,
        text: String(text || '').slice(0, 300), ts: Date.now()
      });
      const s = socketByCode[target.code];
      if (s) io.to(s).emit('reviewReceived', {});
    } catch (e) {}
  });

  socket.on('loadReviews', ({ targetCode }, cb) => {
    try {
      cb({ ok: true, reviews: (reviews[String(targetCode || '').toUpperCase()] || []).slice(-20).reverse() });
    } catch (e) { cb({ ok: false, reviews: [] }); }
  });

  socket.on('addStory', ({ media }) => {
    try {
      const me = users[socket.data.code];
      if (!me) return;
      const story = { id: Date.now().toString(36), from: me.code, fromName: me.name, media, ts: Date.now() };
      stories.push(story);
      if (stories.length > 100) stories.splice(0, stories.length - 100);
      me.friends.forEach(fc => {
        const s = socketByCode[fc];
        if (s) io.to(s).emit('storyAdded', { story });
      });
    } catch (e) {}
  });

  // ---------- АДМИН ----------
  socket.on('getAllUsers', (cb) => {
    if (!requireAdmin(cb)) return;
    cb({ ok: true, users: Object.values(users).map(publicUser) });
  });

  socket.on('adminBanUser', ({ code }, cb) => {
    if (!requireAdmin(cb)) return;
    const u = users[String(code || '').toUpperCase()];
    if (!u) return cb({ ok: false, error: 'Не найден' });
    if (u.isAdmin) return cb({ ok: false, error: 'Нельзя забанить админа' });
    u.banned = true;
    const s = socketByCode[u.code];
    if (s) { io.to(s).emit('banned'); io.sockets.sockets.get(s)?.disconnect(true); }
    cb({ ok: true });
  });

  socket.on('adminUnbanUser', ({ code }, cb) => {
    if (!requireAdmin(cb)) return;
    const u = users[String(code || '').toUpperCase()];
    if (!u) return cb({ ok: false, error: 'Не найден' });
    u.banned = false;
    cb({ ok: true });
  });

  socket.on('adminWipeChat', ({ withCode }, cb) => {
    if (!requireAdmin(cb)) return;
    const me = users[socket.data.code];
    const key = pairKey(me.code, String(withCode || '').toUpperCase());
    messages[key] = [];
    // и у собеседника
    const other = String(withCode || '').toUpperCase();
    const s = socketByCode[other];
    if (s) io.to(s).emit('chatWiped');
    io.to(socket.id).emit('chatWiped');
    cb({ ok: true });
  });

  socket.on('adminBroadcast', ({ text }, cb) => {
    if (!requireAdmin(cb)) return;
    const me = users[socket.data.code];
    Object.values(users).forEach(u => {
      const s = socketByCode[u.code];
      if (s) io.to(s).emit('broadcast', { from: me.name, text: String(text || '') });
    });
    cb({ ok: true });
  });

  // ---------- ОТКЛЮЧЕНИЕ ----------
  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code) return;
    if (socketByCode[code] === socket.id) {
      delete socketByCode[code];
      const u = users[code];
      if (u) u.friends.forEach(fc => {
        const s = socketByCode[fc];
        if (s) io.to(s).emit('friendOnline', { code, online: false });
      });
    }
  });
});

// Чистим просроченный premium каждую минуту
setInterval(() => {
  const now = Date.now();
  Object.values(users).forEach(u => {
    if (u.premium && u.premiumUntil && u.premiumUntil < now) {
      u.premium = false; u.premiumUntil = null;
    }
  });
}, 60000);

server.listen(PORT, () => {
  console.log(`🌊 Волна сервер запущен на http://localhost:${PORT}`);
  console.log(`👑 Админ-коды: ${ADMIN_CODES.join(', ')}`);
});
