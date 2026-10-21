const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 20e6 });

app.use(express.static(path.join(__dirname, 'public')));

// ---------- ХРАНИЛИЩЕ ----------
const users = {};        // code -> user
const messages = {};     // chatKey -> [msg]
const groups = {};       // id -> group
const purchaseRequests = []; // заявки на оплату
const nfts = {};         // code -> [nft]

const keyOf = (a, b) => [a, b].sort().join('|');
const findSocket = (code) => {
  const u = users[code];
  return u && u.socketId ? io.sockets.sockets.get(u.socketId) : null;
};
const publicUser = (u) => ({
  code: u.code, name: u.name, photo: u.photo, stars: u.stars, isAdmin: !!u.isAdmin
});
const publicFriend = (u) => ({
  code: u.code, name: u.name, photo: u.photo, online: !!u.online
});

// ---------- SOCKET.IO ----------
io.on('connection', (socket) => {

  // РЕГИСТРАЦИЯ / ВХОД
  socket.on('register', ({ code, name, pass, photo }, cb) => {
    try {
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
        // авто-дружба с ADMIN
        if (code !== 'ADMIN' && users['ADMIN']) {
          if (!u.friends.includes('ADMIN')) u.friends.push('ADMIN');
          if (!users['ADMIN'].friends.includes(code)) users['ADMIN'].friends.push(code);
        }
      }
      socket.data.code = code;

      const friends = u.friends
        .map(c => users[c]).filter(Boolean).map(publicFriend);
      const myGroups = Object.values(groups).filter(g => g.members.includes(code));

      cb({
        ok: true,
        user: publicUser(u),
        friends,
        groups: myGroups
      });

      // уведомить друзей, что я онлайн
      u.friends.forEach(c => findSocket(c)?.emit('friendOnline', { code, online: true }));
    } catch (e) {
      console.error(e);
      cb({ ok: false, error: 'Server error' });
    }
  });

  // ИСТОРИЯ
  socket.on('loadHistory', ({ withCode, groupId }, cb) => {
    const me = socket.data.code;
    if (!me) return cb({ history: [] });
    const k = groupId || keyOf(me, withCode);
    cb({ history: messages[k] || [] });
  });

  // ОТПРАВКА
  socket.on('sendMessage', (payload) => {
    const from = socket.data.code;
    if (!from) return;
    const msg = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      from, ts: Date.now(), ...payload
    };
    if (payload.groupId) {
      const g = groups[payload.groupId];
      if (!g) return;
      messages[payload.groupId] = messages[payload.groupId] || [];
      messages[payload.groupId].push(msg);
      g.members.forEach(c => {
        if (c === from) return;
        findSocket(c)?.emit('newMessage', { from, message: msg });
      });
    } else {
      const k = keyOf(from, payload.to);
      messages[k] = messages[k] || [];
      messages[k].push(msg);
      findSocket(payload.to)?.emit('newMessage', { from, message: msg });
    }
    socket.emit('messageSent', {
      to: payload.to, groupId: payload.groupId, message: msg
    });
  });

  // ПРОЧИТАНО
  socket.on('markRead', ({ withCode }) => {
    const me = socket.data.code;
    if (!me || !withCode) return;
    const k = keyOf(me, withCode);
    (messages[k] || []).forEach(m => {
      if (m.from === withCode && !m.read_at) m.read_at = Date.now();
    });
    findSocket(withCode)?.emit('messagesRead', { by: me, at: Date.now() });
  });

  // РЕАКЦИИ
  socket.on('reactToMessage', ({ id, emoji }) => {
    const me = socket.data.code;
    if (!me) return;
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

  // ПЕЧАТАЕТ
  socket.on('typing', ({ to, groupId, typing }) => {
    const me = socket.data.code;
    if (!me) return;
    if (groupId) {
      const g = groups[groupId];
      if (!g) return;
      g.members.forEach(c => {
        if (c !== me) findSocket(c)?.emit('friendTyping', { from: me, groupId, typing });
      });
    } else if (to) {
      findSocket(to)?.emit('friendTyping', { from: me, typing });
    }
  });

  // СОЗДАТЬ ГРУППУ
  socket.on('createGroup', ({ name, members }, cb) => {
    const me = socket.data.code;
    if (!me || !name) return cb({ ok: false });
    const id = 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const all = Array.from(new Set([...(members || []), me]));
    groups[id] = { id, name, members: all };
    all.forEach(c => findSocket(c)?.emit('groupAdded', groups[id]));
    cb({ ok: true, group: groups[id] });
  });

  // ЗВЁЗДЫ
  socket.on('buyStars', ({ stars, isAdmin }, cb) => {
    const me = users[socket.data.code];
    if (!me) return cb({ ok: false });
    if (!me.isAdmin) return cb({ ok: false });
    me.stars += stars;
    socket.emit('starsUpdated', { stars: me.stars });
    cb({ ok: true, stars: me.stars });
  });

  // ЗАЯВКА НА ПОКУПКУ
  socket.on('requestStarPurchase', ({ stars, price }, cb) => {
    const me = users[socket.data.code];
    if (!me) return cb({ ok: false });
    const req = {
      id: 'r_' + Date.now().toString(36),
      code: me.code, name: me.name, stars, price, processed: false, ts: Date.now()
    };
    purchaseRequests.push(req);
    Object.values(users).filter(u => u.isAdmin).forEach(a => {
      findSocket(a.code)?.emit('newPurchaseRequest', req);
    });
    cb({ ok: true });
  });

  socket.on('getPurchaseRequests', (cb) => {
    const me = users[socket.data.code];
    if (!me || !me.isAdmin) return cb({ ok: false });
    cb({ ok: true, requests: purchaseRequests });
  });

  socket.on('resolvePurchaseRequest', ({ id, action }, cb) => {
    const me = users[socket.data.code];
    if (!me || !me.isAdmin) return cb({ ok: false });
    const r = purchaseRequests.find(x => x.id === id);
    if (!r || r.processed) return cb({ ok: false });
    r.processed = true;
    if (action === 'approve') {
      const target = users[r.code];
      if (target) {
        target.stars += r.stars;
        findSocket(r.code)?.emit('starsUpdated', { stars: target.stars, received: r.stars });
      }
    }
    cb({ ok: true });
  });

  // NFT
  socket.on('getMyNfts', (cb) => {
    const me = socket.data.code;
    cb({ ok: true, nfts: nfts[me] || [] });
  });

  socket.on('mintNft', ({ name, rarity, cost }, cb) => {
    const me = users[socket.data.code];
    if (!me) return cb({ ok: false });
    if (!me.isAdmin && me.stars < cost) return cb({ ok: false });
    if (!me.isAdmin) me.stars -= cost;
    nfts[me.code] = nfts[me.code] || [];
    const tokenId = Date.now() + Math.floor(Math.random() * 1000);
    nfts[me.code].push({ name, rarity, tokenId });
    socket.emit('starsUpdated', { stars: me.stars });
    cb({ ok: true, stars: me.stars });
  });

  // ОТКЛЮЧЕНИЕ
  socket.on('disconnect', () => {
    const me = users[socket.data.code];
    if (me && me.socketId === socket.id) {
      me.online = false;
      me.socketId = null;
      me.friends.forEach(c => findSocket(c)?.emit('friendOnline', { code: me.code, online: false }));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Volna: http://localhost:' + PORT));
