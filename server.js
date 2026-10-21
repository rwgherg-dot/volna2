'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

let db = { users: {}, messages: [], groups: {}, stories: [], requests: [] };
if (fs.existsSync(DATA_FILE)) { try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {} }
function save() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) {} }
setInterval(save, 5000);

const rnd = (n = 8) => Math.random().toString(36).slice(2, 2 + n);
const uid = () => Date.now().toString(36) + rnd(6);
const normCode = s => String(s || '').trim().toUpperCase();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 20e6 }); // 20MB для видео

app.use(express.static(path.join(__dirname, 'public')));
const sockets = {};
const NFT_PRICES = { wave: 50, star: 150, diamond: 300, rocket: 500, crown: 1000, alien: 2000 };

io.on('connection', socket => {
  socket.data.code = null;

  socket.on('register', ({ code, name, pass, photo }, cb) => {
    name = String(name || '').trim();
    pass = String(pass || '');
    if (!name || !pass) return cb?.({ ok: false, error: 'Заполните поля' });

    let u = Object.values(db.users).find(x => x.name.toLowerCase() === name.toLowerCase());

    if (name.toUpperCase() === 'ADMIN') {
       if (pass !== 'admin123') return cb?.({ ok: false, error: 'Неверный пароль админа' });
       u = db.users['ADMIN'] || { code: 'ADMIN', name: 'ADMIN', pass: 'admin123', stars: 99999, friends: [], bio: 'Создатель DERZUS', nft: [], profileNft: null, premium: true, created: Date.now(), blocked: [] };
       db.users['ADMIN'] = u;
    } else if (u) {
       if (u.pass !== pass) return cb?.({ ok: false, error: 'Это имя уже занято другим паролем' });
       if (u.banned) return cb?.({ ok: false, error: 'Аккаунт заблокирован админом' });
       if (photo) u.photo = photo;
    } else {
       const taken = Object.values(db.users).find(x => x.name.toLowerCase() === name.toLowerCase());
       if (taken) return cb?.({ ok: false, error: 'Имя занято' });
       const newCode = normCode(code) || rnd(6).toUpperCase();
       u = { code: newCode, name, pass, photo, stars: 0, bio: 'Привет, я в DERZUS!', friends: [], nft: [], profileNft: null, premium: false, created: Date.now(), blocked: [] };
       db.users[newCode] = u;
    }

    socket.data.code = u.code;
    (sockets[u.code] ||= new Set()).add(socket.id);

    const friends = u.friends.map(c => db.users[c]).filter(Boolean).map(f => ({ code: f.code, name: f.name, photo: f.photo, bio: f.bio, premium: f.premium, online: !!sockets[f.code]?.size }));
    const groups = Object.values(db.groups).filter(g => g.members.includes(u.code));
    const lasts = {};
    db.messages.forEach(m => {
      if (m.groupId && groups.some(g => g.id === m.groupId)) lasts[m.groupId] = m;
      else if (m.to && ((m.from === u.code && m.to) || (m.from && m.to === u.code))) {
         const peer = m.from === u.code ? m.to : m.from;
         lasts[peer] = m;
      }
    });

    cb?.({ ok: true, user: { code: u.code, name: u.name, stars: u.stars, photo: u.photo, bio: u.bio, nft: u.nft, profileNft: u.profileNft, premium: u.premium }, friends, groups, lasts, stories: [] });
    u.friends.forEach(c => sockets[c]?.forEach(sid => io.to(sid).emit('friendOnline', { code: u.code, online: true })));
    save();
  });

  socket.on('sendBroadcast', ({ text }, cb) => {
    if (socket.data.code !== 'ADMIN') return cb?.({ ok: false, error: 'Только админ' });
    const broadcastMsg = { id: 'm_' + uid(), from: 'ADMIN', text: `[РАССЫЛКА] ${text}`, ts: Date.now(), reactions: {}, isBroadcast: true };
    
    Object.values(db.users).forEach(u => {
      if (u.code === 'ADMIN') return;
      const msg = { ...broadcastMsg, to: u.code };
      db.messages.push(msg);
      sockets[u.code]?.forEach(sid => io.to(sid).emit('newMessage', { from: 'ADMIN', message: msg }));
    });
    cb?.({ ok: true });
    save();
  });

  socket.on('deleteAccount', (cb) => {
    const me = db.users[socket.data.code];
    if (!me || me.code === 'ADMIN') return cb?.({ ok: false, error: 'Нельзя удалить этот аккаунт' });
    me.friends.forEach(c => {
      const f = db.users[c];
      if (f) {
        f.friends = f.friends.filter(x => x !== me.code);
        sockets[c]?.forEach(sid => io.to(sid).emit('friendRemoved', { code: me.code }));
      }
    });
    Object.values(db.groups).forEach(g => {
       if (g.owner === me.code) {
          g.members.forEach(c => sockets[c]?.forEach(sid => io.to(sid).emit('groupRemoved', { id: g.id })));
          delete db.groups[g.id];
       } else {
          g.members = g.members.filter(c => c !== me.code);
       }
    });
    db.messages = db.messages.filter(m => m.from !== me.code && m.to !== me.code);
    delete db.users[me.code];
    (sockets[me.code] || []).forEach(sid => io.to(sid).emit('accountDeleted'));
    delete sockets[me.code];
    cb?.({ ok: true });
    save();
  });

  socket.on('removeFriend', ({ code }, cb) => {
    const me = db.users[socket.data.code];
    const target = db.users[code];
    if (!me || !target) return cb?.({ ok: false });
    me.friends = me.friends.filter(c => c !== code);
    target.friends = target.friends.filter(c => c !== me.code);
    sockets[target.code]?.forEach(sid => io.to(sid).emit('friendRemoved', { code: me.code }));
    cb?.({ ok: true });
    save();
  });

  socket.on('blockUser', ({ code }, cb) => {
    const me = db.users[socket.data.code];
    if (!me) return cb?.({ ok: false });
    me.blocked ||= [];
    if (!me.blocked.includes(code)) me.blocked.push(code);
    cb?.({ ok: true });
    save();
  });

  socket.on('unblockUser', ({ code }, cb) => {
    const me = db.users[socket.data.code];
    if (!me) return cb?.({ ok: false });
    me.blocked = (me.blocked || []).filter(c => c !== code);
    cb?.({ ok: true });
    save();
  });

  socket.on('clearHistory', ({ withCode, groupId }, cb) => {
    const me = db.users[socket.data.code];
    if (!me) return cb?.({ ok: false });
    if (groupId) {
      db.messages = db.messages.filter(m => m.groupId !== groupId);
    } else if (withCode) {
      db.messages = db.messages.filter(m => !(m.to && ((m.from === me.code && m.to === withCode) || (m.from === withCode && m.to === me.code))));
    }
    cb?.({ ok: true });
    save();
  });

  socket.on('updateProfile', ({ name, bio, photo }, cb) => {
    const u = db.users[socket.data.code];
    if (!u) return cb?.({ ok: false });
    if (name && name.toLowerCase() !== u.name.toLowerCase()) {
      const taken = Object.values(db.users).find(x => x.name.toLowerCase() === name.toLowerCase());
      if (taken) return cb?.({ ok: false, error: 'Это имя уже занято' });
      u.name = name;
    }
    if (bio !== undefined) u.bio = bio;
    if (photo !== undefined) u.photo = photo;
    u.friends.forEach(c => sockets[c]?.forEach(sid => io.to(sid).emit('friendUpdated', { code: u.code, name: u.name, bio: u.bio, photo: u.photo, premium: u.premium })));
    cb?.({ ok: true });
    save();
  });

  socket.on('searchUsers', ({ query }, cb) => {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return cb?.({ ok: true, users: [] });
    const list = Object.values(db.users).filter(u => !u.banned && (u.name.toLowerCase().includes(q) || u.code.toLowerCase() === q)).slice(0, 20).map(u => ({ code: u.code, name: u.name, photo: u.photo, bio: u.bio, premium: u.premium, online: !!sockets[u.code]?.size }));
    cb?.({ ok: true, users: list });
  });

  socket.on('addFriendByCode', ({ code }, cb) => {
    const me = db.users[socket.data.code];
    const target = db.users[normCode(code)];
    if (!me) return cb?.({ ok: false, error: 'Вы не авторизованы' });
    if (!target) return cb?.({ ok: false, error: 'Пользователь не найден' });
    if (target.code === me.code) return cb?.({ ok: false, error: 'Это вы' });
    if (me.blocked?.includes(target.code)) return cb?.({ ok: false, error: 'Вы заблокировали этого пользователя' });

    me.friends ||= []; target.friends ||= [];
    const already = me.friends.includes(target.code);
    if (!already) {
      me.friends.push(target.code); target.friends.push(me.code);
      const pubMe = { code: me.code, name: me.name, photo: me.photo, bio: me.bio, premium: me.premium, online: true };
      const pubTarget = { code: target.code, name: target.name, photo: target.photo, bio: target.bio, premium: target.premium, online: !!sockets[target.code]?.size };
      sockets[target.code]?.forEach(sid => io.to(sid).emit('friendAdded', pubMe));
      sockets[me.code]?.forEach(sid => io.to(sid).emit('friendAdded', pubTarget));
    }
    cb?.({ ok: true, already, friend: { code: target.code, name: target.name, photo: target.photo, bio: target.bio, premium: target.premium, online: !!sockets[target.code]?.size } });
    save();
  });

  socket.on('createGroup', ({ name, members }, cb) => {
    const me = db.users[socket.data.code];
    if (!me) return cb?.({ ok: false });
    name = String(name || '').trim().slice(0, 40);
    if (!name) return cb?.({ ok: false, error: 'Введите название' });
    members = (members || []).map(normCode).filter(c => me.friends.includes(c));
    if (!members.length) return cb?.({ ok: false, error: 'Выберите друзей' });
    const id = 'g_' + uid();
    const g = { id, name, members: [me.code, ...members], owner: me.code, created: Date.now() };
    db.groups[id] = g;
    g.members.forEach(c => {
      const pubG = { id: g.id, name: g.name, members: g.members.slice() };
      sockets[c]?.forEach(sid => io.to(sid).emit('groupAdded', pubG));
    });
    cb?.({ ok: true, group: { id, name, members: g.members } });
    save();
  });

  socket.on('loadHistory', ({ withCode, groupId }, cb) => {
    const me = db.users[socket.data.code];
    if (!me) return cb?.({ ok: false, history: [] });
    let history = [];
    if (groupId) history = db.messages.filter(m => m.groupId === groupId);
    else if (withCode) {
      const peer = normCode(withCode);
      history = db.messages.filter(m => m.to && ((m.from === me.code && m.to === peer) || (m.from === peer && m.to === me.code)));
    }
    cb?.({ ok: true, history });
  });

  socket.on('sendMessage', (p) => {
    const me = db.users[socket.data.code];
    if (!me) return;
    if (p.to && me.blocked?.includes(normCode(p.to))) return;
    const peer = p.to ? db.users[normCode(p.to)] : null;
    if (peer && peer.blocked?.includes(me.code)) return;

    const msg = { id: 'm_' + uid(), from: me.code, text: p.text, kind: p.kind, ts: Date.now(), reactions: {} };
    if (p.groupId && db.groups[p.groupId]) {
      msg.groupId = p.groupId;
      db.messages.push(msg);
      db.groups[p.groupId].members.forEach(c => sockets[c]?.forEach(sid => io.to(sid).emit('newMessage', { from: me.code, message: msg })));
    } else if (p.to) {
      msg.to = normCode(p.to);
      db.messages.push(msg);
      sockets[msg.to]?.forEach(sid => io.to(sid).emit('newMessage', { from: me.code, message: msg }));
      sockets[me.code]?.forEach(sid => io.to(sid).emit('messageSent', { to: msg.to, message: msg }));
    }
    save();
  });

  socket.on('deleteMessage', ({ id }) => {
    const me = db.users[socket.data.code];
    if (!me) return;
    const idx = db.messages.findIndex(m => m.id === id);
    if (idx !== -1) {
      const msg = db.messages[idx];
      if (msg.from === me.code || me.code === 'ADMIN') {
        db.messages.splice(idx, 1);
        const key = msg.groupId || (msg.from === me.code ? msg.to : msg.from);
        if (msg.groupId) db.groups[msg.groupId].members.forEach(c => sockets[c]?.forEach(sid => io.to(sid).emit('messageDeleted', { id, key })));
        else {
          sockets[msg.from]?.forEach(sid => io.to(sid).emit('messageDeleted', { id, key }));
          if (msg.to) sockets[msg.to]?.forEach(sid => io.to(sid).emit('messageDeleted', { id, key }));
        }
        save();
      }
    }
  });

  socket.on('reactToMessage', ({ id, emoji }) => {
    const me = db.users[socket.data.code];
    const m = db.messages.find(x => x.id === id);
    if (!m || !me) return;
    m.reactions ||= {}; m.reactions[emoji] ||= [];
    const i = m.reactions[emoji].indexOf(me.code);
    if (i >= 0) m.reactions[emoji].splice(i, 1); else m.reactions[emoji].push(me.code);
    if (!m.reactions[emoji].length) delete m.reactions[emoji];
    const targets = m.groupId ? db.groups[m.groupId].members : [m.from, m.to].filter(Boolean);
    targets.forEach(c => sockets[c]?.forEach(sid => io.to(sid).emit('messageReacted', { id: m.id, reactions: m.reactions })));
    save();
  });

  socket.on('buyPremium', (cb) => {
    const u = db.users[socket.data.code];
    if (!u) return cb?.({ ok: false });
    if (u.stars < 1000) return cb?.({ ok: false, error: 'Нужно 1000 звёзд' });
    u.stars -= 1000; u.premium = true;
    cb?.({ ok: true, stars: u.stars, premium: true });
    u.friends.forEach(c => sockets[c]?.forEach(sid => io.to(sid).emit('friendUpdated', { code: u.code, name: u.name, bio: u.bio, photo: u.photo, premium: true })));
    save();
  });

  socket.on('requestStars', ({ amount, price }, cb) => {
    const me = db.users[socket.data.code];
    if (!me) return cb?.({ ok: false });
    const req = { id: uid(), userCode: me.code, userName: me.name, amount, price, ts: Date.now(), status: 'pending' };
    db.requests.push(req);
    sockets['ADMIN']?.forEach(sid => io.to(sid).emit('newStarsRequest', req));
    cb?.({ ok: true });
    save();
  });

  socket.on('getStarsRequests', () => {
    if (socket.data.code !== 'ADMIN') return;
    socket.emit('starsRequests', db.requests.filter(r => r.status === 'pending'));
  });

  socket.on('resolveStarsRequest', ({ id, amount }) => {
    if (socket.data.code !== 'ADMIN') return;
    const req = db.requests.find(r => r.id === id);
    if (!req) return;
    req.status = 'done';
    const u = db.users[req.userCode];
    if (u) {
      u.stars += Number(amount);
      const msg = { id: 'm_' + uid(), from: 'ADMIN', to: u.code, text: `[АДМИН] Вам начислено ${amount} звёзд!`, ts: Date.now(), reactions: {} };
      db.messages.push(msg);
      sockets[u.code]?.forEach(sid => io.to(sid).emit('newMessage', { from: 'ADMIN', message: msg }));
    }
    sockets['ADMIN']?.forEach(sid => io.to(sid).emit('starsRequests', db.requests.filter(r => r.status === 'pending')));
    save();
  });

  socket.on('getAdminUsers', () => {
    if (socket.data.code !== 'ADMIN') return;
    const users = Object.values(db.users).map(u => ({ code: u.code, name: u.name, stars: u.stars, online: !!sockets[u.code]?.size, banned: !!u.banned }));
    socket.emit('adminUsers', users);
  });

  socket.on('adminBanUser', ({ code }, cb) => {
    if (socket.data.code !== 'ADMIN') return cb?.({ ok: false });
    const u = db.users[code];
    if (u && code !== 'ADMIN') { u.banned = !u.banned; cb?.({ ok: true, banned: u.banned }); }
    save();
  });

  socket.on('adminGiveStars', ({ target, amount }, cb) => {
    if (socket.data.code !== 'ADMIN') return cb?.({ ok: false });
    const u = db.users[target];
    if (u) {
      u.stars += Number(amount);
      cb?.({ ok: true });
      const msg = { id: 'm_' + uid(), from: 'ADMIN', to: target, text: `[АДМИН] Вам начислено ${amount} звёзд!`, ts: Date.now(), reactions: {} };
      db.messages.push(msg);
      sockets[target]?.forEach(sid => io.to(sid).emit('newMessage', { from: 'ADMIN', message: msg }));
      save();
    }
  });

  socket.on('buyNft', ({ nftId }, cb) => {
    const u = db.users[socket.data.code];
    if (!u) return cb?.({ ok: false });
    const price = NFT_PRICES[nftId];
    if (!price) return cb?.({ ok: false, error: 'Неизвестный NFT' });
    if (u.stars < price) return cb?.({ ok: false, error: 'Недостаточно звёзд' });
    u.stars -= price;
    u.nft ||= [];
    const nftItem = { id: nftId, uid: uid(), from: u.code };
    u.nft.push(nftItem);
    cb?.({ ok: true, stars: u.stars, nft: nftItem });
    save();
  });

  socket.on('setNft', ({ nftId }) => {
    const u = db.users[socket.data.code];
    if (u) { u.profileNft = nftId; save(); }
  });

  // --- ЗВОНКИ ---
  socket.on('callUser', ({ to, offer }) => { sockets[to]?.forEach(sid => io.to(sid).emit('incomingCall', { from: socket.data.code, offer })); });
  socket.on('answerCall', ({ to, answer }) => { sockets[to]?.forEach(sid => io.to(sid).emit('callAnswered', { answer })); });
  socket.on('iceCandidate', ({ to, candidate }) => { sockets[to]?.forEach(sid => io.to(sid).emit('iceCandidate', { candidate })); });
  socket.on('endCall', ({ to }) => { sockets[to]?.forEach(sid => io.to(sid).emit('callEnded')); });

  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (code && sockets[code]) {
      sockets[code].delete(socket.id);
      if (!sockets[code].size) db.users[code]?.friends.forEach(c => sockets[c]?.forEach(sid => io.to(sid).emit('friendOnline', { code, online: false })));
    }
  });
});

server.listen(PORT, () => console.log('DERZUS server on ' + PORT));
