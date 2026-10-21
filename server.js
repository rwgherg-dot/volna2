 'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 20 * 1024 * 1024 });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const users = {};
const friends = {};
const groups = {};
const messages = {};
const reviews = {};
const gifts = {};
const nfts = {};
const stories = [];
const purchaseRequests = [];
const banned = new Set();
const socketToCode = new Map();

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pairKey = (a, b) => [a, b].sort().join('::');
const now = () => Date.now();

function getUserByCode(code) { return users[code] || null; }
function getCodeBySocket(socket) { return socketToCode.get(socket.id) || null; }
function getUserBySocket(socket) { return getUserByCode(getCodeBySocket(socket)); }
function isAdmin(socket) {
  const u = getUserBySocket(socket);
  return !!(u && u.isAdmin);
}
function pushMessage(key, msg) {
  if (!messages[key]) messages[key] = [];
  messages[key].push(msg);
  if (messages[key].length > 500) messages[key] = messages[key].slice(-500);
}
function emitToUser(code, event, payload) {
  for (const [sid, c] of socketToCode.entries()) {
    if (c === code) {
      const s = io.sockets.sockets.get(sid);
      if (s) s.emit(event, payload);
    }
  }
}

io.on('connection', (socket) => {
  console.log('🔌 socket connected', socket.id);

  socket.on('register', ({ code, name, pass, photo }, cb) => {
    try {
      if (!code || !name || !pass) return cb({ ok: false, error: 'Заполните все поля' });
      if (banned.has(code)) return cb({ ok: false, error: 'Вы забанены' });

      let user = users[code];
      if (user) {
        if (user.pass !== pass) return cb({ ok: false, error: 'Неверный пароль' });
        user.name = name;
        user.photo = photo || user.photo;
        user.online = true;
      } else {
        user = {
          code, name, pass, photo: photo || null,
          stars: 0, premium: false, premiumUntil: 0,
          isAdmin: code === 'ADMIN' || code === 'ADMIN2',
          online: true, ts: now()
        };
        users[code] = user;
        friends[code] = new Set();
        gifts[code] = [];
        nfts[code] = [];
        reviews[code] = [];
      }

      socketToCode.set(socket.id, code);
      socket.code = code;

      const friendList = [];
      for (const f of friends[code] || []) {
        const u = users[f];
        if (u) friendList.push({
          code: u.code, name: u.name, photo: u.photo,
          premium: u.premium, online: u.online
        });
      }

      const myGroups = Object.values(groups).filter(g => g.members.some(m => m.code === code))
        .map(g => ({ id: g.id, name: g.name, photo: g.photo, members: g.members }));

      for (const f of friends[code] || []) emitToUser(f, 'friendOnline', { code, online: true });

      cb({
        ok: true,
        user: {
          code: user.code, name: user.name, photo: user.photo,
          stars: user.stars, premium: user.premium, premiumUntil: user.premiumUntil,
          isAdmin: user.isAdmin
        },
        friends: friendList,
        groups: myGroups,
        stories
      });
    } catch (e) {
      console.error('register error', e);
      cb({ ok: false, error: 'Ошибка сервера' });
    }
  });

  socket.on('disconnect', () => {
    const code = socketToCode.get(socket.id);
    if (code && users[code]) {
      users[code].online = false;
      for (const f of friends[code] || []) emitToUser(f, 'friendOnline', { code, online: false });
    }
    socketToCode.delete(socket.id);
  });

  socket.on('loadHistory', ({ withCode, groupId }, cb) => {
    const me = getUserBySocket(socket);
    if (!me) return cb({ history: [] });

    let key;
    if (groupId) key = 'g:' + groupId;
    else key = pairKey(me.code, withCode);

    cb({ history: messages[key] || [] });
  });

  socket.on('sendMessage', (payload) => {
    const me = getUserBySocket(socket);
    if (!me) return;

    const msg = {
      id: uid(),
      from: me.code,
      fromName: me.name,
      kind: payload.kind || 'text',
      text: payload.text || '',
      data: payload.data || null,
      replyTo: payload.replyTo || null,
      eph: payload.eph || 0,
      ts: now(),
      reactions: {}
    };

    if (payload.groupId) {
      const g = groups[payload.groupId];
      if (!g) return;
      msg.groupId = payload.groupId;
      const key = 'g:' + payload.groupId;
      pushMessage(key, msg);
      g.members.forEach(m => {
        emitToUser(m.code, 'newMessage', { from: me.code, message: msg });
      });
    } else if (payload.to) {
      const key = pairKey(me.code, payload.to);
      pushMessage(key, msg);
      emitToUser(payload.to, 'newMessage', { from: me.code, message: msg });
      socket.emit('messageSent', { to: payload.to, message: msg });
    }
  });

  socket.on('markRead', ({ withCode }) => {
    const me = getUserBySocket(socket);
    if (!me) return;
    const key = pairKey(me.code, withCode);
    const at = now();
    (messages[key] || []).forEach(m => {
      if (m.from === withCode && !m.read_at) m.read_at = at;
    });
    emitToUser(withCode, 'messagesRead', { by: me.code, at });
  });

  socket.on('typing', ({ to, groupId, typing }) => {
    const me = getUserBySocket(socket);
    if (!me) return;
    if (groupId) {
      const g = groups[groupId];
      if (!g) return;
      g.members.forEach(m => {
        if (m.code !== me.code) emitToUser(m.code, 'friendTyping', { from: me.code, groupId, typing });
      });
    } else if (to) {
      emitToUser(to, 'friendTyping', { from: me.code, typing });
    }
  });

  socket.on('editMessage', ({ id, text }) => {
    const me = getUserBySocket(socket);
    if (!me) return;
    for (const key of Object.keys(messages)) {
      const m = messages[key].find(x => x.id === id);
      if (m && m.from === me.code) {
        m.text = text;
        m.edited = true;
        if (m.groupId) {
          const g = groups[m.groupId];
          if (g) g.members.forEach(mem => emitToUser(mem.code, 'messageEdited', { id, text }));
        } else {
          const other = key.split('::').find(c => c !== me.code);
          emitToUser(other, 'messageEdited', { id, text });
          socket.emit('messageEdited', { id, text });
        }
        return;
      }
    }
  });

  socket.on('deleteMessage', ({ id }) => {
    const me = getUserBySocket(socket);
    if (!me) return;
    for (const key of Object.keys(messages)) {
      const idx = messages[key].findIndex(x => x.id === id);
      if (idx >= 0) {
        const m = messages[key][idx];
        if (m.from !== me.code) return;
        messages[key].splice(idx, 1);
        if (m.groupId) {
          const g = groups[m.groupId];
          if (g) g.members.forEach(mem => emitToUser(mem.code, 'messageDeleted', { from: me.code, groupId: m.groupId, id }));
        } else {
          const other = key.split('::').find(c => c !== me.code);
          emitToUser(other, 'messageDeleted', { from: me.code, id });
          socket.emit('messageDeleted', { from: me.code, id });
        }
        return;
      }
    }
  });

  socket.on('reactToMessage', ({ id, emoji }) => {
    const me = getUserBySocket(socket);
    if (!me) return;
    for (const key of Object.keys(messages)) {
      const m = messages[key].find(x => x.id === id);
      if (m) {
        if (!m.reactions[emoji]) m.reactions[emoji] = [];
        const idx = m.reactions[emoji].indexOf(me.code);
        if (idx >= 0) m.reactions[emoji].splice(idx, 1);
        else m.reactions[emoji].push(me.code);
        if (!m.reactions[emoji].length) delete m.reactions[emoji];

        if (m.groupId) {
          const g = groups[m.groupId];
          if (g) g.members.forEach(mem => emitToUser(mem.code, 'messageReacted', { id, reactions: m.reactions }));
        } else {
          const other = key.split('::').find(c => c !== me.code);
          emitToUser(other, 'messageReacted', { id, reactions: m.reactions });
          socket.emit('messageReacted', { id, reactions: m.reactions });
        }
        return;
      }
    }
  });

  socket.on('addFriend', ({ friendCode }, cb) => {
    const me = getUserBySocket(socket);
    if (!me) return cb({ ok: false, error: 'Не авторизован' });
    if (friendCode === me.code) return cb({ ok: false, error: 'Это вы' });
    const target = users[friendCode];
    if (!target) return cb({ ok: false, error: 'Пользователь не найден' });

    friends[me.code].add(friendCode);
    friends[friendCode].add(me.code);

    const friendForMe = {
      code: target.code, name: target.name, photo: target.photo,
      premium: target.premium, online: target.online
    };
    const friendForTarget = {
      code: me.code, name: me.name, photo: me.photo,
      premium: me.premium, online: me.online
    };

    emitToUser(friendCode, 'friendAdded', friendForTarget);

    cb({ ok: true, friend: friendForMe });
  });

  socket.on('forceAddFriend', ({ targetCode }, cb) => {
    if (!isAdmin(socket)) return cb({ ok: false, error: 'Нет доступа' });
    const me = getUserBySocket(socket);
    const target = users[targetCode];
    if (!target) return cb({ ok: false, error: 'Не найден' });

    friends[me.code].add(targetCode);
    friends[targetCode].add(me.code);

    emitToUser(targetCode, 'friendAdded', {
      code: me.code, name: me.name, photo: me.photo, premium: me.premium, online: me.online
    });

    cb({
      ok: true,
      friend: {
        code: target.code, name: target.name, photo: target.photo,
        premium: target.premium, online: target.online
      }
    });
  });

  socket.on('searchUsers', ({ query }, cb) => {
    const me = getUserBySocket(socket);
    if (!me) return cb({ results: [] });
    const q = (query || '').toLowerCase();
    const results = Object.values(users)
      .filter(u => u.code !== me.code && u.name.toLowerCase().includes(q))
      .slice(0, 30)
      .map(u => ({
        code: u.code, name: u.name, photo: u.photo,
        premium: u.premium, online: u.online
      }));
    cb({ results });
  });

  socket.on('createGroup', ({ name, members }, cb) => {
    const me = getUserBySocket(socket);
    if (!me) return cb({ ok: false });
    const gid = uid();
    const fullMembers = [
      { code: me.code, name: me.name, photo: me.photo },
      ...members.filter(m => m.code !== me.code)
    ];
    const g = { id: gid, name, photo: null, members: fullMembers, creator: me.code, ts: now() };
    groups[gid] = g;

    fullMembers.forEach(m => {
      if (m.code !== me.code) {
        emitToUser(m.code, 'groupAdded', {
          id: g.id, name: g.name, photo: g.photo, members: g.members
        });
      }
    });

    cb({ ok: true, group: { id: g.id, name: g.name, photo: g.photo, members: g.members } });
  });

  socket.on('buyStars', ({ stars, isAdmin: adminFlag }, cb) => {
    const me = getUserBySocket(socket);
    if (!me) return cb({ ok: false, error: 'Не авторизован' });
    if (adminFlag && !me.isAdmin) return cb({ ok: false, error: 'Только админ' });
    me.stars += stars;
    cb({ ok: true, stars: me.stars });
    emitToUser(me.code, 'starsUpdated', { stars: me.stars });
  });

  socket.on('transferStars', ({ to, amount }) => {
    const me = getUserBySocket(socket);
    if (!me) return;
    const target = users[to];
    if (!target) return;
    if (!me.isAdmin && me.stars < amount) return;

    if (!me.isAdmin) me.stars -= amount;
    target.stars += amount;

    emitToUser(target.code, 'starsUpdated', { stars: target.stars, received: amount });
    if (!me.isAdmin) emitToUser(me.code, 'starsUpdated', { stars: me.stars });
  });

  socket.on('activatePremium', ({ to, days }) => {
    const me = getUserBySocket(socket);
    if (!me || !me.isAdmin) return;
    const target = users[to];
    if (!target) return;
    target.premium = true;
    target.premiumUntil = now() + days * 24 * 60 * 60 * 1000;
    emitToUser(target.code, 'premiumActivated', { until: target.premiumUntil });
  });

  socket.on('sendGift', ({ to, gift }) => {
    const me = getUserBySocket(socket);
    if (!me) return;
    if (!gifts[to]) gifts[to] = [];
    gifts[to].push(gift);
    emitToUser(to, 'giftReceived', { gift, from: me.code });
  });

  socket.on('sendReview', ({ to, text }) => {
    const me = getUserBySocket(socket);
    if (!me) return;
    if (!reviews[to]) reviews[to] = [];
    reviews[to].push({
      from: me.code, fromName: me.name, text, ts: now()
    });
    emitToUser(to, 'reviewReceived', { from: me.code });
  });

  socket.on('loadReviews', ({ targetCode }, cb) => {
    cb({ reviews: reviews[targetCode] || [] });
  });

  socket.on('addStory', ({ media }) => {
    const me = getUserBySocket(socket);
    if (!me) return;
    const story = {
      id: uid(), code: me.code, name: me.name, media, ts: now()
    };
    stories.push(story);
    if (stories.length > 100) stories.shift();
    io.emit('storyAdded', { story });
  });

  // ЗАЯВКИ НА ЗВЕЗДЫ
  socket.on('requestStarPurchase', ({ stars, price }, cb) => {
    const me = getUserBySocket(socket);
    if (!me) return cb && cb({ ok: false, error: 'Не авторизован' });

    const req = {
      id: uid(),
      code: me.code,
      name: me.name,
      stars,
      price,
      ts: now(),
      processed: false
    };
    purchaseRequests.push(req);

    for (const [sid, code] of socketToCode.entries()) {
      if (users[code] && users[code].isAdmin) {
        const s = io.sockets.sockets.get(sid);
        if (s) s.emit('newPurchaseRequest', req);
      }
    }

    cb && cb({ ok: true, requestId: req.id });
  });

  socket.on('getPurchaseRequests', (cb) => {
    if (!isAdmin(socket)) return cb({ ok: false, error: 'Нет доступа' });
    cb({ ok: true, requests: purchaseRequests.filter(r => !r.processed) });
  });

  socket.on('resolvePurchaseRequest', ({ id, action }, cb) => {
    if (!isAdmin(socket)) return cb({ ok: false, error: 'Нет доступа' });
    const req = purchaseRequests.find(r => r.id === id);
    if (!req) return cb({ ok: false, error: 'Заявка не найдена' });
    if (req.processed) return cb({ ok: false, error: 'Уже обработана' });

    req.processed = true;

    if (action === 'approve') {
      const target = users[req.code];
      if (target) {
        target.stars += req.stars;
        emitToUser(target.code, 'starsUpdated', { stars: target.stars, received: req.stars });
      }
    }

    cb({ ok: true });
  });

  // NFT
  socket.on('getMyNfts', (cb) => {
    const me = getUserBySocket(socket);
    if (!me) return cb({ ok: false, error: 'Не авторизован' });
    cb({ ok: true, nfts: nfts[me.code] || [] });
  });

  socket.on('mintNft', ({ name, emoji, rarity, cost }, cb) => {
    const me = getUserBySocket(socket);
    if (!me) return cb({ ok: false, error: 'Не авторизован' });
    if (me.stars < cost && !me.isAdmin) return cb({ ok: false, error: 'Недостаточно звёзд' });

    if (!me.isAdmin) me.stars -= cost;

    if (!nfts[me.code]) nfts[me.code] = [];
    const nft = {
      name, emoji, rarity,
      tokenId: nfts[me.code].length + 1,
      ts: now()
    };
    nfts[me.code].push(nft);

    emitToUser(me.code, 'starsUpdated', { stars: me.stars });

    cb({ ok: true, stars: me.stars, nft });
  });

  // АДМИН
  socket.on('getAllUsers', (cb) => {
    if (!isAdmin(socket)) return cb({ ok: false, error: 'Нет доступа' });
    const list = Object.values(users).map(u => ({
      code: u.code, name: u.name, photo: u.photo,
      stars: u.stars, premium: u.premium,
      online: u.online, isAdmin: u.isAdmin
    }));
    cb({ ok: true, users: list });
  });

  socket.on('adminBanUser', ({ code }, cb) => {
    if (!isAdmin(socket)) return cb({ ok: false, error: 'Нет доступа' });
    if (!users[code]) return cb({ ok: false, error: 'Не найден' });
    banned.add(code);
    emitToUser(code, 'banned', {});
    cb({ ok: true });
  });

  socket.on('adminUnbanUser', ({ code }, cb) => {
    if (!isAdmin(socket)) return cb({ ok: false, error: 'Нет доступа' });
    banned.delete(code);
    cb({ ok: true });
  });

  socket.on('adminBroadcast', ({ text }, cb) => {
    if (!isAdmin(socket)) return cb({ ok: false, error: 'Нет доступа' });
    const me = getUserBySocket(socket);
    io.emit('broadcast', { from: me.name, text });
    cb({ ok: true });
  });

  socket.on('adminWipeChat', ({ withCode }, cb) => {
    if (!isAdmin(socket)) return cb({ ok: false, error: 'Нет доступа' });
    const me = getUserBySocket(socket);
    const key = pairKey(me.code, withCode);
    delete messages[key];
    emitToUser(withCode, 'chatWiped', {});
    socket.emit('chatWiped', {});
    cb({ ok: true });
  });

  socket.on('ping', (cb) => cb && cb({ pong: now() }));
});

server.listen(PORT, () => {
  console.log('🌊 Волна запущена: http://localhost:' + PORT);
});
