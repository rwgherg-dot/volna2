'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

/* ---------- хранилище ---------- */
let db = {
  users: {},        // code -> {code, name, pass, photo, stars, friends:[], nft:[], profileNft, created}
  groups: {},       // id -> {id, name, members:[code], owner, created}
  messages: [],     // {id, from, to?, groupId?, text, ts, reactions:{}}
  seq: 1
};

if (fs.existsSync(DATA_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { console.warn('data.json битый, старт с нуля'); }
}
function save() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) { console.error('save:', e.message); }
}
setInterval(save, 5000);
process.on('SIGINT', () => { save(); process.exit(0); });
process.on('SIGTERM', () => { save(); process.exit(0); });

/* ---------- NFT каталог (цены должны совпадать с клиентом) ---------- */
const NFT_CATALOG = {
  'wave-1':   { name: 'Волна',   price: 5 },
  'star-1':   { name: 'Звезда',  price: 25 },
  'diamond-1':{ name: 'Алмаз',   price: 60 },
  'cat-1':    { name: 'Кот',     price: 5 },
  'rocket-1': { name: 'Ракета',  price: 25 },
  'crown-1':  { name: 'Корона',  price: 150 },
  'heart-1':  { name: 'Сердце',  price: 25 },
  'moon-1':   { name: 'Луна',    price: 60 }
};

/* ---------- утилиты ---------- */
const rnd = (n = 8) => Math.random().toString(36).slice(2, 2 + n);
const uid = () => Date.now().toString(36) + rnd(6);
const normCode = s => String(s || '').trim().toUpperCase();
const pubUser = (u, online) => ({
  code: u.code, name: u.name, photo: u.photo || null,
  stars: u.stars || 0, online: !!online,
  profileNftId: profileNftIdOf(u)
});
function profileNftIdOf(u) {
  if (!u.profileNft) return null;
  const o = (u.nft || []).find(x => x.uid === u.profileNft);
  return o ? o.id : null;
}
function lastMessageFor(code, peerCode) {
  // последнее сообщение между code и peerCode
  for (let i = db.messages.length - 1; i >= 0; i--) {
    const m = db.messages[i];
    if (!m.to) continue;
    if ((m.from === code && m.to === peerCode) || (m.from === peerCode && m.to === code)) return m;
  }
  return null;
}
function lastGroupMessage(gid) {
  for (let i = db.messages.length - 1; i >= 0; i--) {
    const m = db.messages[i];
    if (m.groupId === gid) return m;
  }
  return null;
}
function findUserByCode(code) { return db.users[normCode(code)] || null; }

/* ---------- express + socket.io ---------- */
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.json({ ok: true, users: Object.keys(db.users).length }));

// sockets: code -> Set<socket>
const sockets = {};

function onlineCodes() { return Object.keys(sockets).filter(c => sockets[c] && sockets[c].size); }
function isOnline(code) { return !!(sockets[code] && sockets[code].size); }

io.on('connection', socket => {
  socket.data.code = null;

  /* -------- регистрация / вход -------- */
  socket.on('register', ({ code, name, pass, photo }, cb) => {
    try {
      name = String(name || '').trim().slice(0, 24);
      pass = String(pass || '');
      if (!name || !pass) return cb?.({ ok: false, error: 'Заполните имя и пароль' });

      let u = null;
      // ADMIN — фиксированный код; остальным ищем по имени+паролю
      if (name.toUpperCase() === 'ADMIN') {
        u = db.users['ADMIN'] || null;
        if (u && u.pass !== pass) return cb?.({ ok: false, error: 'Неверный пароль' });
        if (!u) {
          u = { code: 'ADMIN', name: 'ADMIN', pass, photo: photo || null, stars: 1000, friends: [], nft: [], profileNft: null, created: Date.now() };
          db.users['ADMIN'] = u;
        }
      } else {
        // ищем существующего по имени+паролю
        u = Object.values(db.users).find(x => x.name.toLowerCase() === name.toLowerCase() && x.pass === pass) || null;
        // имя занято другим паролем?
        const sameName = Object.values(db.users).find(x => x.name.toLowerCase() === name.toLowerCase());
        if (!u && sameName) return cb?.({ ok: false, error: 'Имя занято, другой пароль' });
        if (!u) {
          let c = normCode(code) || rnd(6).toUpperCase();
          while (db.users[c]) c = rnd(6).toUpperCase();
          u = { code: c, name, pass, photo: photo || null, stars: 0, friends: [], nft: [], profileNft: null, created: Date.now() };
          db.users[c] = u;
        } else {
          // обновим фото, если прислали
          if (photo && !u.photo) u.photo = photo;
        }
      }

      socket.data.code = u.code;
      (sockets[u.code] ||= new Set()).add(socket.id);

      // соберём друзей и группы
      const friends = (u.friends || []).map(c => db.users[c]).filter(Boolean).map(f => pubUser(f, isOnline(f.code)));
      const groups = Object.values(db.groups)
        .filter(g => g.members.includes(u.code))
        .map(g => ({ id: g.id, name: g.name, members: g.members.slice() }));

      // последние сообщения для превью
      const lasts = {};
      for (const f of friends) {
        const m = lastMessageFor(u.code, f.code);
        if (m) lasts[f.code] = m;
      }
      for (const g of groups) {
        const m = lastGroupMessage(g.id);
        if (m) lasts[g.id] = m;
      }

      cb?.({
        ok: true,
        user: pubUser(u, true),
        friends, groups, lasts,
        nft: (u.nft || []).slice(),
        profileNft: u.profileNft || null
      });

      // оповестим друзей об онлайне
      u.friends.forEach(c => sockets[c] && io.to([...sockets[c]]).emit('friendOnline', { code: u.code, online: true }));
      save();
    } catch (e) { console.error(e); cb?.({ ok: false, error: 'server error' }); }
  });

  /* -------- поиск пользователей -------- */
  socket.on('searchUsers', ({ query }, cb) => {
    const me = db.users[socket.data.code];
    const q = String(query || '').trim().toLowerCase();
    if (!q) return cb?.({ ok: true, users: [] });
    const list = Object.values(db.users)
      .filter(u => u.code !== socket.data.code)
      .filter(u => u.name.toLowerCase().includes(q) || u.code.toLowerCase() === q)
      .slice(0, 20)
      .map(u => pubUser(u, isOnline(u.code)));
    cb?.({ ok: true, users: list });
  });

  /* -------- добавить друга -------- */
  socket.on('addFriendByCode', ({ code }, cb) => {
    const me = db.users[socket.data.code];
    if (!me) return cb?.({ ok: false, error: 'Вы не авторизованы' });
    const target = findUserByCode(code);
    if (!target) return cb?.({ ok: false, error: 'Пользователь не найден' });
    if (target.code === me.code) return cb?.({ ok: false, error: 'Это вы' });

    me.friends ||= [];
    target.friends ||= [];
    const already = me.friends.includes(target.code) || target.friends.includes(me.code);

    if (!already) {
      me.friends.push(target.code);
      target.friends.push(me.code);
    }

    // сообщим обоим
    const pubMe = pubUser(me, isOnline(me.code));
    const pubTarget = pubUser(target, isOnline(target.code));
    if (!already) {
      (sockets[target.code] || new Set()).forEach(sid => io.to(sid).emit('friendAdded', pubMe));
      (sockets[me.code] || new Set()).forEach(sid => io.to(sid).emit('friendAdded', pubTarget));
    }
    cb?.({ ok: true, already, friend: pubTarget });
    save();
  });

  /* -------- группы -------- */
  socket.on('createGroup', ({ name, members }, cb) => {
    const me = db.users[socket.data.code];
    if (!me) return cb?.({ ok: false, error: 'Не авторизованы' });
    name = String(name || '').trim().slice(0, 40);
    if (!name) return cb?.({ ok: false, error: 'Нужно название' });
    members = (members || []).map(normCode).filter(c => me.friends.includes(c));
    if (!members.length) return cb?.({ ok: false, error: 'Выберите друзей' });

    const id = 'g_' + uid();
    const g = { id, name, members: [me.code, ...members], owner: me.code, created: Date.now() };
    db.groups[id] = g;

    g.members.forEach(c => {
      (sockets[c] || new Set()).forEach(sid => io.to(sid).emit('groupAdded', { id: g.id, name: g.name, members: g.members.slice() }));
    });
    cb?.({ ok: true, group: { id, name, members: g.members.slice() } });
    save();
  });

  /* -------- история -------- */
  socket.on('loadHistory', ({ withCode, groupId }, cb) => {
    const me = db.users[socket.data.code];
    if (!me) return cb?.({ ok: false, history: [] });
    let history = [];
    if (groupId) {
      history = db.messages.filter(m => m.groupId === groupId);
    } else if (withCode) {
      const peer = normCode(withCode);
      history = db.messages.filter(m => !m.groupId && m.to &&
        ((m.from === me.code && m.to === peer) || (m.from === peer && m.to === me.code)));
    }
    cb?.({ ok: true, history });
  });

  socket.on('markRead', () => { /* можно расширить, сейчас no-op */ });

  /* -------- отправка сообщения -------- */
  socket.on('sendMessage', (p) => {
    const me = db.users[socket.data.code];
    if (!me) return;
    const text = String(p?.text || '').slice(0, 4000);
    if (!text) return;
    const msg = {
      id: 'm_' + uid(), from: me.code, text, ts: Date.now(), reactions: {}
    };
    if (p.groupId && db.groups[p.groupId] && db.groups[p.groupId].members.includes(me.code)) {
      msg.groupId = p.groupId;
      db.messages.push(msg);
      db.groups[p.groupId].members.forEach(c => {
        (sockets[c] || new Set()).forEach(sid => io.to(sid).emit('newMessage', { from: me.code, message: msg }));
      });
    } else if (p.to) {
      const to = normCode(p.to);
      if (!db.users[to]) return;
      msg.to = to;
      db.messages.push(msg);
      (sockets[to] || new Set()).forEach(sid => io.to(sid).emit('newMessage', { from: me.code, message: msg }));
      (sockets[me.code] || new Set()).forEach(sid => io.to(sid).emit('messageSent', { to, message: msg }));
    }
    // ограничим историю до 50k сообщений
    if (db.messages.length > 50000) db.messages.splice(0, db.messages.length - 50000);
    save();
  });

  /* -------- реакции -------- */
  const ALLOWED_EMOJI = new Set(['like', 'heart', 'fire', 'laugh', 'sad', 'party']);
  socket.on('reactToMessage', ({ id, emoji }) => {
    const me = db.users[socket.data.code];
    if (!me) return;
    if (!ALLOWED_EMOJI.has(emoji)) return;
    const m = db.messages.find(x => x.id === id);
    if (!m) return;
    m.reactions ||= {};
    m.reactions[emoji] ||= [];
    const i = m.reactions[emoji].indexOf(me.code);
    if (i >= 0) m.reactions[emoji].splice(i, 1); else m.reactions[emoji].push(me.code);
    if (!m.reactions[emoji].length) delete m.reactions[emoji];

    // кому сообщить
    const targets = new Set();
    if (m.groupId) {
      (db.groups[m.groupId]?.members || []).forEach(c => targets.add(c));
    } else {
      targets.add(m.from);
      if (m.to) targets.add(m.to);
    }
    targets.forEach(c => {
      (sockets[c] || new Set()).forEach(sid => io.to(sid).emit('messageReacted', { id: m.id, reactions: m.reactions }));
    });
    save();
  });

  /* -------- звёзды -------- */
  socket.on('buyStars', ({ amount }, cb) => {
    const u = db.users[socket.data.code];
    if (!u) return cb?.({ ok: false, error: 'Не авторизованы' });
    const n = Math.max(0, Math.min(1000, Number(amount) || 0));
    if (!n) return cb?.({ ok: false, error: 'Неверная сумма' });
    u.stars = (u.stars || 0) + n;
    cb?.({ ok: true, stars: u.stars });
    save();
  });

  /* -------- NFT -------- */
  socket.on('buyNft', ({ nftId }, cb) => {
    const u = db.users[socket.data.code];
    if (!u) return cb?.({ ok: false, error: 'Не авторизованы' });
    const n = NFT_CATALOG[nftId];
    if (!n) return cb?.({ ok: false, error: 'Нет такого NFT' });
    if ((u.stars || 0) < n.price) return cb?.({ ok: false, error: 'Недостаточно звёзд' });
    u.stars -= n.price;
    u.nft ||= [];
    const nft = { id: nftId, uid: uid(), from: u.code, ts: Date.now() };
    u.nft.push(nft);
    cb?.({ ok: true, stars: u.stars, nft });
    save();
  });

  socket.on('setProfileNft', ({ uid: nftUid }, cb) => {
    const u = db.users[socket.data.code];
    if (!u) return cb?.({ ok: false });
    const own = (u.nft || []).find(o => o.uid === nftUid);
    u.profileNft = own ? nftUid : null;
    cb?.({ ok: true });
    // оповестим друзей, чтобы обновили бейдж в профиле
    (u.friends || []).forEach(c => {
      (sockets[c] || new Set()).forEach(sid => io.to(sid).emit('friendUpdated', pubUser(u, isOnline(u.code))));
    });
    save();
  });

  socket.on('sendNft', ({ uid: nftUid, to }, cb) => {
    const me = db.users[socket.data.code];
    const target = findUserByCode(to);
    if (!me) return cb?.({ ok: false, error: 'Не авторизованы' });
    if (!target) return cb?.({ ok: false, error: 'Получатель не найден' });
    if (!me.friends.includes(target.code)) return cb?.({ ok: false, error: 'Он не в друзьях' });
    const idx = (me.nft || []).findIndex(o => o.uid === nftUid);
    if (idx < 0) return cb?.({ ok: false, error: 'NFT не найден' });
    const [nft] = me.nft.splice(idx, 1);
    if (me.profileNft === nftUid) me.profileNft = null;
    nft.from = me.code;
    target.nft ||= [];
    target.nft.push(nft);
    (sockets[target.code] || new Set()).forEach(sid => io.to(sid).emit('nftReceived', { nft }));
    cb?.({ ok: true });
    save();
  });

  /* -------- отключение -------- */
  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code || !sockets[code]) return;
    sockets[code].delete(socket.id);
    if (!sockets[code].size) {
      const u = db.users[code];
      if (u) u.friends.forEach(c => {
        (sockets[c] || new Set()).forEach(sid => io.to(sid).emit('friendOnline', { code, online: false }));
      });
    }
  });
});

server.listen(PORT, () => {
  console.log('Volna server on http://localhost:' + PORT);
});
