const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', maxHttpBufferSize: 1e8 } });

app.use(express.static(path.join(__dirname, 'public')));

// ================== БАЗА ДАННЫХ ==================
const db = new Database('volna.db');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pass TEXT NOT NULL,
  photo TEXT,
  stars INTEGER DEFAULT 0,
  premium INTEGER DEFAULT 0,
  premium_until INTEGER DEFAULT 0,
  worn_gifts TEXT DEFAULT '[]',
  my_gifts TEXT DEFAULT '[]',
  is_admin INTEGER DEFAULT 0,
  banned INTEGER DEFAULT 0,
  created INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS friends (
  user_code TEXT NOT NULL,
  friend_code TEXT NOT NULL,
  created INTEGER DEFAULT (strftime('%s','now')),
  PRIMARY KEY (user_code, friend_code)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_code TEXT NOT NULL,
  to_code TEXT NOT NULL,
  group_id TEXT,
  kind TEXT DEFAULT 'text',
  text TEXT,
  data TEXT,
  ts INTEGER DEFAULT (strftime('%s','now') * 1000),
  read_at INTEGER DEFAULT 0,
  reply_to TEXT,
  edited INTEGER DEFAULT 0,
  reactions TEXT DEFAULT '{}',
  eph INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msg_to ON messages(to_code, ts);
CREATE INDEX IF NOT EXISTS idx_msg_group ON messages(group_id, ts);

CREATE TABLE IF NOT EXISTS groups_tbl (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  photo TEXT,
  host_code TEXT NOT NULL,
  members TEXT DEFAULT '[]',
  created INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  from_code TEXT NOT NULL,
  to_code TEXT NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  author_code TEXT NOT NULL,
  author_name TEXT NOT NULL,
  media TEXT NOT NULL,
  ts INTEGER DEFAULT (strftime('%s','now') * 1000)
);
`);

const ADMIN_CODES = ['ADMIN', 'ADMIN2'];
const ADMIN_PASSWORDS = { ADMIN: 'admin123', ADMIN2: 'admin456' };

// ================== УТИЛИТЫ ==================
const hashPass = s => crypto.createHash('sha256').update(s).digest('hex');
const genCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = ''; for (let i = 0; i < 6; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ================== ONLINE ==================
const onlineUsers = new Map(); // code -> socket.id

function publicUser(code) {
  const u = db.prepare('SELECT * FROM users WHERE code = ?').get(code);
  if (!u) return null;
  return {
    code: u.code, name: u.name, photo: u.photo,
    stars: u.stars,
    premium: !!(u.premium && u.premium_until > Date.now()),
    premiumUntil: u.premium_until,
    wornGifts: JSON.parse(u.worn_gifts || '[]'),
    myGifts: JSON.parse(u.my_gifts || '[]'),
    isAdmin: !!u.is_admin,
    online: onlineUsers.has(u.code)
  };
}

function notifyFriends(code, event, payload) {
  const friends = db.prepare('SELECT friend_code FROM friends WHERE user_code = ?').all(code);
  friends.forEach(f => {
    const sid = onlineUsers.get(f.friend_code);
    if (sid) io.to(sid).emit(event, payload);
  });
}

function notifyGroupMembers(groupId, event, payload, exceptCode) {
  const g = db.prepare('SELECT members FROM groups_tbl WHERE id = ?').get(groupId);
  if (!g) return;
  const members = JSON.parse(g.members || '[]');
  members.forEach(m => {
    if (m.code === exceptCode) return;
    const sid = onlineUsers.get(m.code);
    if (sid) io.to(sid).emit(event, payload);
  });
}

function msgForClient(m) {
  return {
    id: m.id, from: m.from_code,
    to: m.to_code, groupId: m.group_id,
    kind: m.kind, text: m.text,
    data: m.data ? JSON.parse(m.data) : null,
    ts: m.ts, read_at: m.read_at,
    reply_to: m.reply_to, edited: !!m.edited,
    reactions: JSON.parse(m.reactions || '{}'),
    eph: m.eph
  };
}

io.on('connection', socket => {

  // ============ РЕГИСТРАЦИЯ ============
  socket.on('register', ({ code, name, pass, photo }, cb) => {
    try {
      const isAdmin = ADMIN_CODES.includes(code);
      let user = db.prepare('SELECT * FROM users WHERE code = ?').get(code);

      if (user && user.banned) {
        return cb({ ok: false, error: '🚫 Вы забанены' });
      }

      if (user) {
        if (user.pass !== hashPass(pass) && !(isAdmin && ADMIN_PASSWORDS[code] === pass)) {
          return cb({ ok: false, error: 'Неверный пароль' });
        }
        db.prepare('UPDATE users SET name = ?, photo = ? WHERE code = ?').run(name, photo, code);
      } else {
        if (isAdmin) {
          if (ADMIN_PASSWORDS[code] !== pass) return cb({ ok: false, error: 'Неверный пароль админа' });
        }
        db.prepare(`INSERT INTO users (code, name, pass, photo, stars, premium, premium_until, is_admin)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          code, name, hashPass(pass), photo,
          isAdmin ? 1000000 : 0,
          isAdmin ? 1 : 0,
          isAdmin ? Date.now() + 1000 * 60 * 60 * 24 * 365 * 10 : 0,
          isAdmin ? 1 : 0
        );
      }

      socket.data.code = code;
      onlineUsers.set(code, socket.id);

      const me = publicUser(code);
      const friends = db.prepare('SELECT friend_code FROM friends WHERE user_code = ?').all(code)
        .map(f => publicUser(f.friend_code)).filter(Boolean);
      const stories = db.prepare('SELECT * FROM stories WHERE ts > ?').all(Date.now() - 24 * 60 * 60 * 1000);
      const groups = db.prepare('SELECT * FROM groups_tbl').all()
        .filter(g => JSON.parse(g.members || '[]').some(m => m.code === code))
        .map(g => ({ id: g.id, name: g.name, photo: g.photo, hostCode: g.host_code, members: JSON.parse(g.members || '[]') }));

      cb({ ok: true, user: me, friends, stories, groups });

      notifyFriends(code, 'friendOnline', { code, online: true });
    } catch (e) {
      console.error(e);
      cb({ ok: false, error: e.message });
    }
  });

  // ============ ОБНОВИТЬ ПРОФИЛЬ ============
  socket.on('updateProfile', ({ name, photo }) => {
    const code = socket.data.code; if (!code) return;
    db.prepare('UPDATE users SET name = ?, photo = ? WHERE code = ?').run(name, photo, code);
    notifyFriends(code, 'friendProfile', { code, name, photo });
  });

  // ============ ПОИСК ============
  socket.on('searchUsers', ({ query }, cb) => {
    const q = (query || '').toLowerCase().trim();
    if (!q) return cb({ results: [] });
    const rows = db.prepare('SELECT * FROM users WHERE LOWER(name) LIKE ? AND banned = 0 LIMIT 30').all('%' + q + '%');
    cb({ results: rows.map(publicUser) });
  });

  socket.on('getAllUsers', cb => {
    const code = socket.data.code;
    if (!ADMIN_CODES.includes(code)) return cb({ ok: false });
    const rows = db.prepare('SELECT * FROM users ORDER BY created DESC').all();
    cb({ ok: true, users: rows.map(publicUser) });
  });

  // ============ ДРУЗЬЯ ============
  socket.on('addFriend', ({ friendCode }, cb) => {
    const code = socket.data.code;
    if (code === friendCode) return cb({ ok: false, error: 'Это ваш код' });
    const target = db.prepare('SELECT * FROM users WHERE code = ?').get(friendCode);
    if (!target) return cb({ ok: false, error: 'Не найден' });
    db.prepare('INSERT OR IGNORE INTO friends (user_code, friend_code) VALUES (?, ?)').run(code, friendCode);
    db.prepare('INSERT OR IGNORE INTO friends (user_code, friend_code) VALUES (?, ?)').run(friendCode, code);
    cb({ ok: true, friend: publicUser(friendCode) });
    const sid = onlineUsers.get(friendCode);
    if (sid) io.to(sid).emit('friendAdded', publicUser(code));
  });

  socket.on('forceAddFriend', ({ targetCode }, cb) => {
    const code = socket.data.code;
    if (!ADMIN_CODES.includes(code)) return cb({ ok: false, error: 'Только для админа' });
    db.prepare('INSERT OR IGNORE INTO friends (user_code, friend_code) VALUES (?, ?)').run(code, targetCode);
    db.prepare('INSERT OR IGNORE INTO friends (user_code, friend_code) VALUES (?, ?)').run(targetCode, code);
    cb({ ok: true, friend: publicUser(targetCode) });
    const sid = onlineUsers.get(targetCode);
    if (sid) io.to(sid).emit('friendAdded', publicUser(code));
  });

  // ============ ГРУППЫ ============
  socket.on('createGroup', ({ name, photo, members }, cb) => {
    const code = socket.data.code;
    const id = code + '-' + genCode().slice(0, 4);
    const me = publicUser(code);
    const membersList = [{ code, name: me.name, photo: me.photo }, ...members];
    db.prepare('INSERT INTO groups_tbl (id, name, photo, host_code, members) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, photo || null, code, JSON.stringify(membersList));
    const g = { id, name, photo, hostCode: code, members: membersList };
    membersList.forEach(m => {
      const sid = onlineUsers.get(m.code);
      if (sid) io.to(sid).emit('groupAdded', g);
    });
    cb({ ok: true, group: g });
  });

  socket.on('joinGroup', ({ groupId }, cb) => {
    const code = socket.data.code;
    const g = db.prepare('SELECT * FROM groups_tbl WHERE id = ?').get(groupId);
    if (!g) return cb({ ok: false, error: 'Группа не найдена' });
    const members = JSON.parse(g.members || '[]');
    if (!members.find(m => m.code === code)) {
      const me = publicUser(code);
      members.push({ code, name: me.name, photo: me.photo });
      db.prepare('UPDATE groups_tbl SET members = ? WHERE id = ?').run(JSON.stringify(members), groupId);
    }
    cb({ ok: true, group: { id: g.id, name: g.name, photo: g.photo, hostCode: g.host_code, members } });
  });

  // ============ ИСТОРИЯ ============
  socket.on('loadHistory', ({ withCode, groupId }, cb) => {
    const code = socket.data.code;
    let rows;
    if (groupId) {
      rows = db.prepare('SELECT * FROM messages WHERE group_id = ? ORDER BY ts ASC LIMIT 500').all(groupId);
    } else {
      rows = db.prepare(`SELECT * FROM messages WHERE group_id IS NULL AND
        ((from_code = ? AND to_code = ?) OR (from_code = ? AND to_code = ?))
        ORDER BY ts ASC LIMIT 500`).all(code, withCode, withCode, code);
    }
    cb({ history: rows.map(msgForClient) });
  });

  // ============ ОТПРАВКА СООБЩЕНИЯ ============
  socket.on('sendMessage', ({ to, groupId, kind, text, data, replyTo, eph }) => {
    const from = socket.data.code; if (!from) return;
    const id = uid();
    const ts = Date.now();
    db.prepare(`INSERT INTO messages (id, from_code, to_code, group_id, kind, text, data, ts, reply_to, eph)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, from, to || '', groupId || null, kind || 'text', text || '',
        data ? JSON.stringify(data) : null, ts, replyTo || null, eph || 0);
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    const msg = msgForClient(row);

    if (groupId) {
      notifyGroupMembers(groupId, 'newMessage', { groupId, message: msg });
      const sid = onlineUsers.get(from);
      if (sid) io.to(sid).emit('messageSent', { groupId, message: msg });
    } else {
      const sid = onlineUsers.get(to);
      if (sid) io.to(sid).emit('newMessage', { from, message: msg });
      socket.emit('messageSent', { to, message: msg });
    }

    if (eph > 0) {
      setTimeout(() => {
        db.prepare('DELETE FROM messages WHERE id = ?').run(id);
        if (groupId) notifyGroupMembers(groupId, 'messageDeleted', { groupId, id });
        else {
          const sid = onlineUsers.get(to);
          if (sid) io.to(sid).emit('messageDeleted', { from, id });
          socket.emit('messageDeleted', { to, id });
        }
      }, eph * 1000);
    }
  });

  // ============ РЕДАКТИРОВАНИЕ ============
  socket.on('editMessage', ({ id, text }) => {
    const from = socket.data.code;
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    if (!row || row.from_code !== from) return;
    db.prepare('UPDATE messages SET text = ?, edited = 1 WHERE id = ?').run(text, id);
    const payload = { id, text, edited: true };
    if (row.group_id) notifyGroupMembers(row.group_id, 'messageEdited', payload);
    else {
      const sid = onlineUsers.get(row.to_code);
      if (sid) io.to(sid).emit('messageEdited', payload);
      socket.emit('messageEdited', payload);
    }
  });

  socket.on('deleteMessage', ({ id }) => {
    const from = socket.data.code;
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    if (!row) return;
    const isAdmin = ADMIN_CODES.includes(from);
    if (row.from_code !== from && !isAdmin) return;
    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    const payload = { id };
    if (row.group_id) notifyGroupMembers(row.group_id, 'messageDeleted', payload);
    else {
      const sid = onlineUsers.get(row.to_code);
      if (sid) io.to(sid).emit('messageDeleted', payload);
      socket.emit('messageDeleted', payload);
    }
  });

  // ============ РЕАКЦИИ ============
  socket.on('reactToMessage', ({ id, emoji }) => {
    const from = socket.data.code;
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    if (!row) return;
    const r = JSON.parse(row.reactions || '{}');
    if (!r[emoji]) r[emoji] = [];
    if (r[emoji].includes(from)) r[emoji] = r[emoji].filter(x => x !== from);
    else r[emoji].push(from);
    if (!r[emoji].length) delete r[emoji];
    db.prepare('UPDATE messages SET reactions = ? WHERE id = ?').run(JSON.stringify(r), id);
    const payload = { id, reactions: r };
    if (row.group_id) notifyGroupMembers(row.group_id, 'messageReacted', payload);
    else {
      const sid = onlineUsers.get(row.to_code);
      if (sid) io.to(sid).emit('messageReacted', payload);
      socket.emit('messageReacted', payload);
    }
  });

  // ============ ПРОЧИТАНО ============
  socket.on('markRead', ({ withCode, groupId }) => {
    const code = socket.data.code;
    const ts = Date.now();
    if (groupId) return;
    db.prepare('UPDATE messages SET read_at = ? WHERE from_code = ? AND to_code = ? AND read_at = 0').run(ts, withCode, code);
    const sid = onlineUsers.get(withCode);
    if (sid) io.to(sid).emit('messagesRead', { by: code, at: ts });
  });

  // ============ ПЕЧАТАЕТ ============
  socket.on('typing', ({ to, groupId, typing }) => {
    const from = socket.data.code;
    if (groupId) notifyGroupMembers(groupId, 'friendTyping', { from, groupId, typing });
    else {
      const sid = onlineUsers.get(to);
      if (sid) io.to(sid).emit('friendTyping', { from, typing });
    }
  });

  // ============ ЗВЁЗДЫ (АДМИН) ============
  socket.on('transferStars', ({ to, amount }) => {
    const from = socket.data.code;
    if (!ADMIN_CODES.includes(from)) return;
    if (!amount || amount <= 0) return;
    db.prepare('UPDATE users SET stars = stars + ? WHERE code = ?').run(amount, to);
    const target = publicUser(to);
    const sid = onlineUsers.get(to);
    if (sid) io.to(sid).emit('starsUpdated', { stars: target.stars, received: amount });
    socket.emit('adminOk', { msg: '⭐ Начислено ' + amount });
  });

  // ============ PREMIUM ============
  socket.on('activatePremium', ({ to, days }) => {
    const from = socket.data.code;
    if (!ADMIN_CODES.includes(from)) return;
    const until = Date.now() + days * 24 * 60 * 60 * 1000;
    db.prepare('UPDATE users SET premium = 1, premium_until = ? WHERE code = ?').run(until, to);
    const sid = onlineUsers.get(to);
    if (sid) io.to(sid).emit('premiumActivated', { until });
    socket.emit('adminOk', { msg: '👑 Premium активирован' });
  });

  // ============ ПОДАРКИ ============
  socket.on('sendGift', ({ to, gift }) => {
    const from = socket.data.code;
    const u = db.prepare('SELECT my_gifts FROM users WHERE code = ?').get(to);
    const gifts = JSON.parse(u.my_gifts || '[]');
    gifts.push(gift);
    db.prepare('UPDATE users SET my_gifts = ? WHERE code = ?').run(JSON.stringify(gifts), to);
    const sid = onlineUsers.get(to);
    if (sid) io.to(sid).emit('giftReceived', { gift, from });
  });

  socket.on('wearGift', ({ giftId }) => {
    const code = socket.data.code;
    const u = db.prepare('SELECT worn_gifts FROM users WHERE code = ?').get(code);
    let w = JSON.parse(u.worn_gifts || '[]');
    if (w.includes(giftId)) w = w.filter(x => x !== giftId);
    else w.push(giftId);
    db.prepare('UPDATE users SET worn_gifts = ? WHERE code = ?').run(JSON.stringify(w), code);
    notifyFriends(code, 'friendProfile', { code, name: publicUser(code).name, photo: publicUser(code).photo });
  });

  socket.on('sellGift', ({ giftId }) => {
    const code = socket.data.code;
    const u = db.prepare('SELECT my_gifts, stars FROM users WHERE code = ?').get(code);
    const gifts = JSON.parse(u.my_gifts || '[]');
    const g = gifts.find(x => x.id === giftId);
    if (!g) return;
    const price = Math.floor(g.stars / 2);
    const newGifts = gifts.filter(x => x.id !== giftId);
    db.prepare('UPDATE users SET my_gifts = ?, stars = stars + ? WHERE code = ?')
      .run(JSON.stringify(newGifts), price, code);
    const sid = onlineUsers.get(code);
    if (sid) io.to(sid).emit('starsUpdated', { stars: u.stars + price, received: price });
  });

  // ============ ОТЗЫВЫ ============
  socket.on('sendReview', ({ to, text }) => {
    const from = socket.data.code;
    const me = publicUser(from);
    const review = { id: uid(), from, fromName: me.name, to, text, ts: Date.now() };
    db.prepare('INSERT INTO reviews (id, from_code, to_code, text, ts) VALUES (?, ?, ?, ?, ?)')
      .run(review.id, from, to, text, review.ts);
    const sid = onlineUsers.get(to);
    if (sid) io.to(sid).emit('reviewReceived', { review });
  });

  socket.on('loadReviews', ({ targetCode }, cb) => {
    const rows = db.prepare(`
      SELECT r.*, u.name AS from_name FROM reviews r
      JOIN users u ON u.code = r.from_code
      WHERE r.to_code = ?
      ORDER BY r.ts DESC LIMIT 50`).all(targetCode);
    cb({ reviews: rows.map(r => ({ id: r.id, from: r.from_code, fromName: r.from_name, to: r.to_code, text: r.text, ts: r.ts })) });
  });

  // ============ ИСТОРИИ ============
  socket.on('addStory', ({ media }) => {
    const code = socket.data.code;
    const me = publicUser(code);
    const id = uid();
    db.prepare('INSERT INTO stories (id, author_code, author_name, media, ts) VALUES (?, ?, ?, ?, ?)')
      .run(id, code, me.name, media, Date.now());
    db.prepare('DELETE FROM stories WHERE ts < ?').run(Date.now() - 24 * 60 * 60 * 1000);
    const story = { id, author: code, authorName: me.name, media, ts: Date.now() };
    notifyFriends(code, 'storyAdded', { story });
  });

  // ============ ЗАЯВКА НА ОПЛАТУ ============
  socket.on('paymentRequest', ({ stars, amount, userCode }) => {
    const fromCode = userCode || socket.data.code;
    const me = publicUser(fromCode);
    if (!me) return;
    ADMIN_CODES.forEach(adminCode => {
      const sid = onlineUsers.get(adminCode);
      if (sid) {
        io.to(sid).emit('paymentRequestReceived', {
          userCode: fromCode,
          userName: me.name,
          stars, amount
        });
      }
    });
    socket.emit('adminOk', { msg: '✅ Заявка отправлена админу' });
  });

  // ============ АДМИН: БАН ============
  socket.on('adminBan', ({ targetCode }, cb) => {
    const code = socket.data.code;
    if (!ADMIN_CODES.includes(code)) return cb({ ok: false });
    db.prepare('UPDATE users SET banned = 1, stars = 0 WHERE code = ?').run(targetCode);
    const sid = onlineUsers.get(targetCode);
    if (sid) io.to(sid).emit('banned', {});
    cb({ ok: true });
  });

  // ============ АДМИН: РАЗБАН ============
  socket.on('adminUnban', ({ targetCode }, cb) => {
    const code = socket.data.code;
    if (!ADMIN_CODES.includes(code)) return cb({ ok: false });
    db.prepare('UPDATE users SET banned = 0 WHERE code = ?').run(targetCode);
    cb({ ok: true });
  });

  // ============ АДМИН: УДАЛИТЬ ============
  socket.on('adminDeleteUser', ({ targetCode }, cb) => {
    const code = socket.data.code;
    if (!ADMIN_CODES.includes(code)) return cb({ ok: false });
    if (ADMIN_CODES.includes(targetCode)) return cb({ ok: false, error: 'Нельзя удалить админа' });
    db.prepare('DELETE FROM users WHERE code = ?').run(targetCode);
    db.prepare('DELETE FROM friends WHERE user_code = ? OR friend_code = ?').run(targetCode, targetCode);
    db.prepare('DELETE FROM messages WHERE from_code = ? OR to_code = ?').run(targetCode, targetCode);
    const sid = onlineUsers.get(targetCode);
    if (sid) io.to(sid).emit('accountDeleted', {});
    cb({ ok: true });
  });

  // ============ АДМИН: НАПИСАТЬ ОТ ИМЕНИ ============
  socket.on('adminSendAs', ({ fromCode, toCode, text }) => {
    const code = socket.data.code;
    if (!ADMIN_CODES.includes(code)) return;
    const id = uid();
    const ts = Date.now();
    db.prepare(`INSERT INTO messages (id, from_code, to_code, kind, text, ts) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, fromCode, toCode, 'text', text, ts);
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    const msg = msgForClient(row);
    const sid = onlineUsers.get(toCode);
    if (sid) io.to(sid).emit('newMessage', { from: fromCode, message: msg });
    socket.emit('adminOk', { msg: '✍ Отправлено от ' + fromCode });
  });

  // ============ АДМИН: РАССЫЛКА ============
  socket.on('adminBroadcast', ({ text }) => {
    const code = socket.data.code;
    if (!ADMIN_CODES.includes(code)) return;
    const allUsers = db.prepare('SELECT code FROM users').all();
    allUsers.forEach(u => {
      if (u.code === code) return;
      const sid = onlineUsers.get(u.code);
      if (sid) io.to(sid).emit('broadcastMessage', { text, from: code });
    });
    socket.emit('adminOk', { msg: '📢 Рассылка отправлена' });
  });

  // ============ ОТКЛЮЧЕНИЕ ============
  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code) return;
    if (onlineUsers.get(code) === socket.id) {
      onlineUsers.delete(code);
      notifyFriends(code, 'friendOnline', { code, online: false });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Волна: http://localhost:${PORT}`));
