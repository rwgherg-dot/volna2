'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 30 * 1024 * 1024 }); // 30MB на медиа

app.use(express.static(__dirname));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ================= ХРАНИЛИЩЕ ================= */
const DB_FILE = path.join(__dirname, 'db.json');

let db = {
  users: {},          // code -> { code, name, pass, photo, stars, premium, premiumUntil, isAdmin, banned, createdAt }
  friends: {},        // code -> [codes...]
  groups: {},         // gid -> { id, name, photo, owner, members:[codes] }
  messages: [],       // [{ id, from, to?, groupId?, kind, text, data, ts, read_at, edited, reactions }]
  gifts: [],          // [{ id, from, to, emoji, name, stars, ts }]
  reviews: [],        // [{ id, from, fromName, to, text, ts }]
  stories: [],        // [{ id, from, fromName, media, ts }]
  purchaseRequests: [] // [{ id, code, name, stars, price, ts, status }]
};

if (fs.existsSync(DB_FILE)) {
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) { console.error('DB load error', e); }
}
function save() {
  fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), (e) => { if (e) console.error('DB save error', e); });
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = ''; for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)]; }
  while (db.users[c]);
  return c;
}
function pubUser(u) {
  return {
    code: u.code, name: u.name, photo: u.photo || null,
    stars: u.stars || 0,
    premium: !!(u.premiumUntil && u.premiumUntil > Date.now()),
    premiumUntil: u.premiumUntil || 0,
    isAdmin: !!u.isAdmin,
    online: online.has(u.code)
  };
}

/* ================= ONLINE ================= */
const online = new Set();           // set of codes
const sockets = new Map();          // code -> Set(socketId)
function emitTo(code, event, data) {
  const set = sockets.get(code);
  if (set) set.forEach(id => io.to(id).emit(event, data));
}
function broadcastAdmins(event, data) {
  for (const code in db.users) {
    if (db.users[code].isAdmin) emitTo(code, event, data);
  }
}

/* ================= SOCKET ================= */
io.on('connection', (socket) => {
  let myCode = null;

  socket.on('register', ({ code, name, pass, photo }, cb) => {
    try {
      // поиск по имени если код не задан
      let user = code && db.users[code];

      if (!user) {
        // если имя занято — ищем и сверяем пароль
        const byName = Object.values(db.users).find(u => u.name.toLowerCase() === name.toLowerCase());
        if (byName) {
          if (byName.pass !== pass) return cb({ ok: false, error: 'Неверный пароль' });
          if (byName.banned) return cb({ ok: false, error: 'Вы забанены' });
          user = byName;
        }
      } else {
        if (user.pass !== pass) return cb({ ok: false, error: 'Неверный пароль' });
        if (user.banned) return cb({ ok: false, error: 'Вы забанены' });
      }

      if (!user) {
        // создаём нового
        let newCode;
        if (name === 'ADMIN' || name === 'ADMIN2') newCode = name;
        else newCode = genCode();
        if (db.users[newCode]) newCode = genCode();

        user = {
          code: newCode,
          name,
          pass,
          photo: photo || null,
          stars: 0,
          premiumUntil: 0,
          isAdmin: (name === 'ADMIN' || name === 'ADMIN2'),
          banned: false,
          createdAt: Date.now()
        };
        db.users[newCode] = user;
        db.friends[newCode] = [];
        save();
      } else {
        // обновляем фото при желании
        if (photo) user.photo = photo;
        if (!db.friends[user.code]) db.friends[user.code] = [];
        save();
      }

      // Авторизация
      myCode = user.code;
      socket.code = user.code;
      if (!sockets.has(myCode)) sockets.set(myCode, new Set());
      sockets.get(myCode).add(socket.id);
      online.add(myCode);

      const friends = (db.friends[myCode] || []).map(c => db.users[c] ? pubUser(db.users[c]) : null).filter(Boolean);
      const groups = Object.values(db.groups).filter(g => g.members.includes(myCode));
      const stories = db.stories.filter(s => Date.now() - s.ts < 86400000);

      cb({
        ok: true,
        user: pubUser(user),
        friends,
        groups,
        stories
      });

      // уведомить друзей об онлайне
      friends.forEach(f => emitTo(f.code, 'friendOnline', { code: myCode, online: true }));
      socket.broadcast.emit('friendOnline', { code: myCode, online: true });
    } catch (e) {
      console.error(e);
      cb({ ok: false, error: 'Ошибка сервера' });
    }
  });

  /* ---------- ДРУЗЬЯ ---------- */
  socket.on('addFriend', ({ friendCode }, cb) => {
    if (!myCode) return cb({ ok: false, error: 'Нет авторизации' });
    const target = db.users[friendCode];
    if (!target) return cb({ ok: false, error: 'Пользователь не найден' });
    if (target.code === myCode) return cb({ ok: false, error: 'Это вы' });

    db.friends[myCode] = db.friends[myCode] || [];
    db.friends[target.code] = db.friends[target.code] || [];

    if (!db.friends[myCode].includes(target.code)) db.friends[myCode].push(target.code);
    if (!db.friends[target.code].includes(myCode)) db.friends[target.code].push(myCode);
    save();

    emitTo(target.code, 'friendAdded', pubUser(db.users[myCode]));
    cb({ ok: true, friend: pubUser(target) });
  });

  socket.on('forceAddFriend', ({ targetCode }, cb) => {
    const me = db.users[myCode];
    if (!me || !me.isAdmin) return cb({ ok: false, error: 'Нет прав' });
    const target = db.users[targetCode];
    if (!target) return cb({ ok: false, error: 'Не найден' });
    db.friends[myCode] = db.friends[myCode] || [];
    db.friends[target.code] = db.friends[target.code] || [];
    if (!db.friends[myCode].includes(target.code)) db.friends[myCode].push(target.code);
    if (!db.friends[target.code].includes(myCode)) db.friends[target.code].push(myCode);
    save();
    cb({ ok: true, friend: pubUser(target) });
  });

  socket.on('searchUsers', ({ query }, cb) => {
    const q = (query || '').toLowerCase();
    const results = Object.values(db.users)
      .filter(u => u.code !== myCode && u.name.toLowerCase().includes(q))
      .slice(0, 30)
      .map(pubUser);
    cb({ results });
  });

  socket.on('getAllUsers', (cb) => {
    const me = db.users[myCode];
    if (!me || !me.isAdmin) return cb({ ok: false });
    cb({ ok: true, users: Object.values(db.users).map(pubUser) });
  });

  /* ---------- ГРУППЫ ---------- */
  socket.on('createGroup', ({ name, members }, cb) => {
    if (!myCode) return cb({ ok: false });
    const id = 'g_' + uid();
    const memberCodes = [...new Set([myCode, ...members.map(m => m.code)])];
    const group = { id, name, photo: null, owner: myCode, members: memberCodes, createdAt: Date.now() };
    db.groups[id] = group;
    save();
    memberCodes.forEach(c => emitTo(c, 'groupAdded', group));
    cb({ ok: true, group });
  });

  /* ---------- ИСТОРИЯ ---------- */
  socket.on('loadHistory', ({ withCode, groupId }, cb) => {
    let history = [];
    if (groupId) {
      history = db.messages.filter(m => m.groupId === groupId);
    } else if (withCode) {
      history = db.messages.filter(m =>
        (m.from === myCode && m.to === withCode) || (m.from === withCode && m.to === myCode)
      );
    }
    // помечаем прочитанными
    if (withCode) {
      const now = Date.now();
      history.forEach(m => { if (m.from === withCode && m.to === myCode && !m.read_at) m.read_at = now; });
      save();
      emitTo(withCode, 'messagesRead', { by: myCode, at: now });
    }
    cb({ history });
  });

  /* ---------- СООБЩЕНИЯ ---------- */
  socket.on('sendMessage', (payload) => {
    if (!myCode) return;
    const msg = {
      id: uid(),
      from: myCode,
      to: payload.to || null,
      groupId: payload.groupId || null,
      kind: payload.kind || 'text',
      text: payload.text || '',
      data: payload.data || null,
      ts: Date.now(),
      read_at: null,
      edited: false,
      reactions: {},
      replyTo: payload.replyTo || null,
      eph: payload.eph || 0
    };
    db.messages.push(msg);
    save();

    if (msg.groupId) {
      const g = db.groups[msg.groupId];
      if (g) g.members.forEach(c => { if (c !== myCode) emitTo(c, 'newMessage', { from: myCode, message: msg }); });
      emitTo(myCode, 'messageSent', { groupId: msg.groupId, message: msg });
    } else {
      emitTo(msg.to, 'newMessage', { from: myCode, message: msg });
      emitTo(myCode, 'messageSent', { to: msg.to, message: msg });
    }
  });

  socket.on('deleteMessage', ({ id }) => {
    const idx = db.messages.findIndex(m => m.id === id && m.from === myCode);
    if (idx === -1) return;
    const m = db.messages[idx];
    db.messages.splice(idx, 1);
    save();
    if (m.groupId) {
      const g = db.groups[m.groupId];
      if (g) g.members.forEach(c => emitTo(c, 'messageDeleted', { from: m.from, groupId: m.groupId, id }));
    } else {
      emitTo(m.to, 'messageDeleted', { from: m.from, id });
      emitTo(myCode, 'messageDeleted', { from: m.to, id });
    }
  });

  socket.on('editMessage', ({ id, text }) => {
    const m = db.messages.find(x => x.id === id && x.from === myCode);
    if (!m) return;
    m.text = text; m.edited = true;
    save();
    if (m.groupId) {
      const g = db.groups[m.groupId];
      if (g) g.members.forEach(c => emitTo(c, 'messageEdited', { id, text }));
    } else {
      emitTo(m.to, 'messageEdited', { id, text });
      emitTo(myCode, 'messageEdited', { id, text });
    }
  });

  socket.on('reactToMessage', ({ id, emoji }) => {
    const m = db.messages.find(x => x.id === id);
    if (!m) return;
    if (!m.reactions) m.reactions = {};
    if (!m.reactions[emoji]) m.reactions[emoji] = [];
    const arr = m.reactions[emoji];
    const i = arr.indexOf(myCode);
    if (i === -1) arr.push(myCode); else arr.splice(i, 1);
    if (!arr.length) delete m.reactions[emoji];
    save();
    if (m.groupId) {
      const g = db.groups[m.groupId];
      if (g) g.members.forEach(c => emitTo(c, 'messageReacted', { id, reactions: m.reactions }));
    } else {
      emitTo(m.to, 'messageReacted', { id, reactions: m.reactions });
      emitTo(myCode, 'messageReacted', { id, reactions: m.reactions });
    }
  });

  socket.on('markRead', ({ withCode }) => {
    const now = Date.now();
    let changed = false;
    db.messages.forEach(m => {
      if (m.from === withCode && m.to === myCode && !m.read_at) { m.read_at = now; changed = true; }
    });
    if (changed) { save(); emitTo(withCode, 'messagesRead', { by: myCode, at: now }); }
  });

  socket.on('typing', ({ to, groupId, typing }) => {
    if (groupId) {
      const g = db.groups[groupId];
      if (g) g.members.forEach(c => { if (c !== myCode) emitTo(c, 'friendTyping', { from: myCode, groupId, typing }); });
    } else if (to) {
      emitTo(to, 'friendTyping', { from: myCode, typing });
    }
  });

  /* ---------- ЗВЁЗДЫ / ПОДАРКИ ---------- */
  socket.on('sendGift', ({ to, gift }) => {
    const from = db.users[myCode];
    const target = db.users[to];
    if (!from || !target) return;
    if (!from.isAdmin && (from.stars || 0) < gift.stars) return;

    if (!from.isAdmin) from.stars -= gift.stars;
    target.stars = (target.stars || 0) + gift.stars;

    db.gifts.push({ id: gift.id, from: myCode, to, emoji: gift.emoji, name: gift.name, stars: gift.stars, ts: Date.now() });
    save();

    emitTo(myCode, 'starsUpdated', { stars: from.stars || 0 });
    emitTo(to, 'starsUpdated', { stars: target.stars, received: gift.stars });
    emitTo(to, 'giftReceived', { gift });
  });

  socket.on('transferStars', ({ to, amount }) => {
    const me = db.users[myCode];
    const target = db.users[to];
    if (!me || !target || !me.isAdmin) return;
    target.stars = (target.stars || 0) + (amount || 0);
    save();
    emitTo(to, 'starsUpdated', { stars: target.stars, received: amount });
  });

  socket.on('buyStars', ({ stars, isAdmin }, cb) => {
    const u = db.users[myCode];
    if (!u) return cb({ ok: false, error: 'Нет пользователя' });
    if (isAdmin && !u.isAdmin) return cb({ ok: false, error: 'Только админ' });
    if (!isAdmin) return cb({ ok: false, error: 'Используйте заявку' });
    u.stars = (u.stars || 0) + stars;
    save();
    emitTo(myCode, 'starsUpdated', { stars: u.stars, received: stars });
    cb({ ok: true, stars: u.stars });
  });

  socket.on('requestStarPurchase', ({ stars, price }, cb) => {
    const u = db.users[myCode];
    if (!u) return cb({ ok: false, error: 'Нет пользователя' });
    const req = { id: uid(), code: u.code, name: u.name, stars, price, ts: Date.now(), status: 'pending' };
    db.purchaseRequests.push(req);
    save();
    broadcastAdmins('newPurchaseRequest', req);
    cb({ ok: true });
  });

  socket.on('listPurchaseRequests', (cb) => {
    const me = db.users[myCode];
    if (!me || !me.isAdmin) return cb({ ok: false });
    cb({ ok: true, requests: db.purchaseRequests.filter(r => r.status === 'pending') });
  });

  socket.on('approvePurchase', ({ id }, cb) => {
    const me = db.users[myCode];
    if (!me || !me.isAdmin) return cb({ ok: false });
    const r = db.purchaseRequests.find(x => x.id === id);
    if (!r) return cb({ ok: false });
    r.status = 'approved';
    const target = db.users[r.code];
    if (target) {
      target.stars = (target.stars || 0) + r.stars;
      emitTo(target.code, 'starsUpdated', { stars: target.stars, received: r.stars });
    }
    save();
    cb({ ok: true });
  });

  socket.on('activatePremium', ({ to, days }) => {
    const me = db.users[myCode];
    if (!me || !me.isAdmin) return;
    const t = db.users[to];
    if (!t) return;
    t.premiumUntil = Math.max(t.premiumUntil || 0, Date.now()) + (days || 30) * 86400000;
    save();
    emitTo(to, 'premiumActivated', { until: t.premiumUntil });
  });

  /* ---------- ОТЗЫВЫ ---------- */
  socket.on('sendReview', ({ to, text }) => {
    const me = db.users[myCode];
    if (!me) return;
    const rev = { id: uid(), from: myCode, fromName: me.name, to, text, ts: Date.now() };
    db.reviews.push(rev);
    save();
    emitTo(to, 'reviewReceived', { review: rev });
  });

  socket.on('loadReviews', ({ targetCode }, cb) => {
    cb({ reviews: db.reviews.filter(r => r.to === targetCode).sort((a, b) => b.ts - a.ts) });
  });

  /* ---------- ИСТОРИИ ---------- */
  socket.on('addStory', ({ media }) => {
    const me = db.users[myCode];
    if (!me) return;
    const s = { id: uid(), from: myCode, fromName: me.name, media, ts: Date.now() };
    db.stories.push(s);
    save();
    // рассылка друзьям
    (db.friends[myCode] || []).forEach(c => emitTo(c, 'storyAdded', { story: s }));
  });

  /* ---------- АДМИН ---------- */
  socket.on('adminBanUser', ({ code }, cb) => {
    const me = db.users[myCode];
    if (!me || !me.isAdmin) return cb({ ok: false, error: 'Нет прав' });
    const t = db.users[code];
    if (!t) return cb({ ok: false, error: 'Не найден' });
    t.banned = true;
    save();
    emitTo(code, 'banned');
    cb({ ok: true });
  });

  socket.on('adminUnbanUser', ({ code }, cb) => {
    const me = db.users[myCode];
    if (!me || !me.isAdmin) return cb({ ok: false, error: 'Нет прав' });
    const t = db.users[code];
    if (!t) return cb({ ok: false, error: 'Не найден' });
    t.banned = false;
    save();
    cb({ ok: true });
  });

  socket.on('adminWipeChat', ({ withCode }, cb) => {
    const me = db.users[myCode];
    if (!me || !me.isAdmin) return cb({ ok: false, error: 'Нет прав' });
    db.messages = db.messages.filter(m =>
      !((m.from === myCode && m.to === withCode) || (m.from === withCode && m.to === myCode))
    );
    save();
    emitTo(myCode, 'chatWiped', { withCode });
    emitTo(withCode, 'chatWiped', { withCode: myCode });
    cb({ ok: true });
  });

  socket.on('adminBroadcast', ({ text }, cb) => {
    const me = db.users[myCode];
    if (!me || !me.isAdmin) return cb({ ok: false });
    Object.values(db.users).forEach(u => {
      emitTo(u.code, 'broadcast', { from: me.name, text, ts: Date.now() });
    });
    cb({ ok: true });
  });

  /* ---------- DISCONNECT ---------- */
  socket.on('disconnect', () => {
    if (myCode) {
      const set = sockets.get(myCode);
      if (set) {
        set.delete(socket.id);
        if (!set.size) {
          sockets.delete(myCode);
          online.delete(myCode);
          socket.broadcast.emit('friendOnline', { code: myCode, online: false });
          (db.friends[myCode] || []).forEach(c => emitTo(c, 'friendOnline', { code: myCode, online: false }));
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
// Явно указываем хост '0.0.0.0', чтобы Render мог достучаться до сервера
server.listen(PORT, '0.0.0.0', () => {
  console.log('🌊 Волна — сервер запущен на порту ' + PORT);
});
