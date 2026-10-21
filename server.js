const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ================== БАЗА ДАННЫХ ==================
const db = new Database('volna.db');

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
  is_admin INTEGER DEFAULT 0,
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
  kind TEXT DEFAULT 'text',
  text TEXT,
  data TEXT,
  ts INTEGER DEFAULT (strftime('%s','now') * 1000),
  read_at INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(from_code, to_code, ts);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_code, read_at);

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

// Админские коды
const ADMIN_CODES = ['ADMIN', 'ADMIN2'];

// ================== УТИЛИТЫ ==================
function hashPass(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = '';
  for (let i = 0; i < 6; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

// ================== SOCKET.IO ==================
const onlineUsers = new Map(); // code -> socket.id

io.on('connection', (socket) => {
  console.log('🔌 connected', socket.id);

  // ----- РЕГИСТРАЦИЯ -----
  socket.on('register', ({ code, name, pass, photo }, cb) => {
    try {
      const isAdmin = ADMIN_CODES.includes(code);
      let user = db.prepare('SELECT * FROM users WHERE code = ?').get(code);

      if (user) {
        // Вход
        if (user.pass !== hashPass(pass) && !(isAdmin && ['admin123', 'admin456'].includes(pass))) {
          return cb({ ok: false, error: 'Неверный пароль' });
        }
        socket.data.code = code;
        onlineUsers.set(code, socket.id);
        db.prepare('UPDATE users SET name = ?, photo = ? WHERE code = ?').run(name, photo, code);
      } else {
        // Регистрация
        if (isAdmin) {
          if (!((code === 'ADMIN' && pass === 'admin123') || (code === 'ADMIN2' && pass === 'admin456'))) {
            return cb({ ok: false, error: 'Неверный пароль админа' });
          }
        }
        db.prepare('INSERT INTO users (code, name, pass, photo, stars, premium, premium_until, is_admin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(code, name, hashPass(pass), photo, isAdmin ? 1000000 : 0, isAdmin ? 1 : 0, isAdmin ? Date.now() + 1000 * 60 * 60 * 24 * 365 * 10 : 0, isAdmin ? 1 : 0);
        socket.data.code = code;
        onlineUsers.set(code, socket.id);
      }

      const freshUser = db.prepare('SELECT * FROM users WHERE code = ?').get(code);
      const friends = db.prepare('SELECT friend_code AS code FROM friends WHERE user_code = ?').all(code).map(f => {
        const u = db.prepare('SELECT code, name, photo, premium, premium_until, worn_gifts FROM users WHERE code = ?').get(f.code);
        return u ? {
          code: u.code,
          name: u.name,
          photo: u.photo,
          premium: !!(u.premium && u.premium_until > Date.now()),
          premiumUntil: u.premium_until,
          wornGifts: JSON.parse(u.worn_gifts || '[]'),
          online: onlineUsers.has(u.code)
        } : null;
      }).filter(Boolean);

      const stories = db.prepare('SELECT * FROM stories WHERE ts > ?').all(Date.now() - 24 * 60 * 60 * 1000);

      cb({
        ok: true,
        user: {
          code: freshUser.code,
          name: freshUser.name,
          photo: freshUser.photo,
          stars: freshUser.stars,
          premium: !!(freshUser.premium && freshUser.premium_until > Date.now()),
          premiumUntil: freshUser.premium_until,
          wornGifts: JSON.parse(freshUser.worn_gifts || '[]'),
          isAdmin: !!freshUser.is_admin
        },
        friends,
        stories
      });

      // Оповещаем всех друзей что я онлайн
      notifyFriends(code, 'friendOnline', { code, online: true });
    } catch (e) {
      console.error('register error', e);
      cb({ ok: false, error: e.message });
    }
  });

  // ----- ОБНОВЛЕНИЕ ПРОФИЛЯ -----
  socket.on('updateProfile', ({ name, photo }) => {
    const code = socket.data.code;
    if (!code) return;
    db.prepare('UPDATE users SET name = ?, photo = ? WHERE code = ?').run(name, photo, code);
    notifyFriends(code, 'friendProfile', { code, name, photo });
  });

  // ----- ПОИСК ПОЛЬЗОВАТЕЛЕЙ -----
  socket.on('searchUsers', ({ query }, cb) => {
    const q = (query || '').toLowerCase().trim();
    if (!q) return cb({ results: [] });
    const rows = db.prepare('SELECT code, name, photo, premium, premium_until FROM users WHERE LOWER(name) LIKE ? LIMIT 30').all('%' + q + '%');
    const results = rows.map(r => ({
      code: r.code,
      name: r.name,
      photo: r.photo,
      premium: !!(r.premium && r.premium_until > Date.now()),
      online: onlineUsers.has(r.code)
    }));
    cb({ results });
  });

  // ----- ПОЛУЧИТЬ ВСЕХ ПОЛЬЗОВАТЕЛЕЙ (только для админа) -----
  socket.on('getAllUsers', (cb) => {
    const code = socket.data.code;
    if (!ADMIN_CODES.includes(code)) return cb({ ok: false });
    const rows = db.prepare('SELECT code, name, photo, premium, premium_until, stars, created FROM users ORDER BY created DESC').all();
    cb({
      ok: true,
      users: rows.map(r => ({
        code: r.code,
        name: r.name,
        photo: r.photo,
        stars: r.stars,
        premium: !!(r.premium && r.premium_until > Date.now()),
        online: onlineUsers.has(r.code),
        created: r.created
      }))
    });
  });

  // ----- АВТОДОБАВЛЕНИЕ В ДРУЗЬЯ -----
  socket.on('forceAddFriend', ({ targetCode }, cb) => {
    const code = socket.data.code;
    if (!ADMIN_CODES.includes(code)) return cb({ ok: false, error: 'Только для админа' });
    try {
      db.prepare('INSERT OR IGNORE INTO friends (user_code, friend_code) VALUES (?, ?)').run(code, targetCode);
      db.prepare('INSERT OR IGNORE INTO friends (user_code, friend_code) VALUES (?, ?)').run(targetCode, code);
      const target = db.prepare('SELECT code, name, photo, premium, premium_until FROM users WHERE code = ?').get(targetCode);
      cb({
        ok: true,
        friend: {
          code: target.code,
          name: target.name,
          photo: target.photo,
          premium: !!(target.premium && target.premium_until > Date.now()),
          online: onlineUsers.has(target.code)
        }
      });
      // Оповестить цель, что её добавили
      const targetSocket = onlineUsers.get(targetCode);
      if (targetSocket) {
        io.to(targetSocket).emit('friendAdded', {
          code,
          name: db.prepare('SELECT name FROM users WHERE code = ?').get(code).name,
          photo: db.prepare('SELECT photo FROM users WHERE code = ?').get(code).photo
        });
      }
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  // ----- ДОБАВИТЬ ДРУГА (по коду) -----
  socket.on('addFriend', ({ friendCode }, cb) => {
    const code = socket.data.code;
    if (code === friendCode) return cb({ ok: false, error: 'Это ваш код' });
    const target = db.prepare('SELECT code, name, photo, premium, premium_until FROM users WHERE code = ?').get(friendCode);
    if (!target) return cb({ ok: false, error: 'Пользователь не найден' });
    try {
      db.prepare('INSERT OR IGNORE INTO friends (user_code, friend_code) VALUES (?, ?)').run(code, friendCode);
      db.prepare('INSERT OR IGNORE INTO friends (user_code, friend_code) VALUES (?, ?)').run(friendCode, code);
      cb({
        ok: true,
        friend: {
          code: target.code,
          name: target.name,
          photo: target.photo,
          premium: !!(target.premium && target.premium_until > Date.now()),
          online: onlineUsers.has(target.code)
        }
      });
      const targetSocket = onlineUsers.get(friendCode);
      if (targetSocket) {
        const me = db.prepare('SELECT name, photo FROM users WHERE code = ?').get(code);
        io.to(targetSocket).emit('friendAdded', { code, name: me.name, photo: me.photo });
      }
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  // ----- ЗАГРУЗИТЬ ИСТОРИЮ -----
  socket.on('loadHistory', ({ withCode }, cb) => {
    const code = socket.data.code;
    const rows = db.prepare(`
      SELECT * FROM messages
      WHERE (from_code = ? AND to_code = ?) OR (from_code = ? AND to_code = ?)
      ORDER BY ts ASC
    `).all(code, withCode, withCode, code);
    cb({
      history: rows.map(r => ({
        id: r.id,
        from: r.from_code,
        kind: r.kind,
        text: r.text,
        data: r.data ? JSON.parse(r.data) : null,
        ts: r.ts,
        read_at: r.read_at
      }))
    });
  });

  // ----- ОТПРАВКА СООБЩЕНИЯ -----
  socket.on('sendMessage', ({ to, kind, text, data }) => {
    const from = socket.data.code;
    if (!from) return;
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const ts = Date.now();
    db.prepare('INSERT INTO messages (id, from_code, to_code, kind, text, data, ts) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, from, to, kind || 'text', text || '', data ? JSON.stringify(data) : null, ts);

    const msg = { id, from, kind, text, data, ts, read_at: 0 };

    // Отправить получателю если онлайн
    const targetSocket = onlineUsers.get(to);
    if (targetSocket) {
      io.to(targetSocket).emit('newMessage', { from, message: msg });
    }
    // Отправить подтверждение себе
    socket.emit('messageSent', { to, message: msg });
  });

  // ----- ОТМЕТИТЬ ПРОЧИТАННЫМ -----
  socket.on('markRead', ({ withCode }) => {
    const code = socket.data.code;
    const ts = Date.now();
    db.prepare('UPDATE messages SET read_at = ? WHERE from_code = ? AND to_code = ? AND read_at = 0').run(ts, withCode, code);

    const targetSocket = onlineUsers.get(withCode);
    if (targetSocket) {
      io.to(targetSocket).emit('messagesRead', { by: code, at: ts });
    }
  });

  // ----- ПЕЧАТАЕТ -----
  socket.on('typing', ({ to, typing }) => {
    const from = socket.data.code;
    const targetSocket = onlineUsers.get(to);
    if (targetSocket) {
      io.to(targetSocket).emit('friendTyping', { from, typing });
    }
  });

  // ----- ЗВЁЗДЫ: ПЕРЕВОД -----
  socket.on('transferStars', ({ to, amount }) => {
    const from = socket.data.code;
    if (!ADMIN_CODES.includes(from)) return;
    if (!amount || amount <= 0) return;
    db.prepare('UPDATE users SET stars = stars + ? WHERE code = ?').run(amount, to);
    const u = db.prepare('SELECT stars FROM users WHERE code = ?').get(to);
    const targetSocket = onlineUsers.get(to);
    if (targetSocket) {
      io.to(targetSocket).emit('starsUpdated', { stars: u.stars, received: amount });
    }
  });

  // ----- ПРЕМИУМ АКТИВАЦИЯ -----
  socket.on('activatePremium', ({ to, days }) => {
    const from = socket.data.code;
    if (!ADMIN_CODES.includes(from)) return;
    const until = Date.now() + days * 24 * 60 * 60 * 1000;
    db.prepare('UPDATE users SET premium = 1, premium_until = ? WHERE code = ?').run(until, to);
    const targetSocket = onlineUsers.get(to);
    if (targetSocket) {
      io.to(targetSocket).emit('premiumActivated', { until });
    }
  });

  // ----- ПОДАРОК -----
  socket.on('sendGift', ({ to, gift }) => {
    const from = socket.data.code;
    const user = db.prepare('SELECT worn_gifts FROM users WHERE code = ?').get(to);
    // сохраняем подарок в отдельной таблице (или в JSON у юзера)
    db.prepare('UPDATE users SET stars = stars WHERE code = ?').run(to); // ничего
    const targetSocket = onlineUsers.get(to);
    if (targetSocket) {
      io.to(targetSocket).emit('giftReceived', { gift, from });
    }
  });

  // ----- ОТЗЫВ -----
  socket.on('sendReview', ({ to, text }) => {
    const from = socket.data.code;
    const review = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      from, to, text, ts: Date.now()
    };
    const me = db.prepare('SELECT name FROM users WHERE code = ?').get(from);
    review.fromName = me.name;
    db.prepare('INSERT INTO reviews (id, from_code, to_code, text, ts) VALUES (?, ?, ?, ?, ?)')
      .run(review.id, from, to, text, review.ts);
    const targetSocket = onlineUsers.get(to);
    if (targetSocket) {
      io.to(targetSocket).emit('reviewReceived', { review });
    }
  });

  socket.on('loadReviews', ({ targetCode }, cb) => {
    const rows = db.prepare(`
      SELECT r.*, u.name AS from_name FROM reviews r
      JOIN users u ON u.code = r.from_code
      WHERE r.to_code = ?
      ORDER BY r.ts DESC LIMIT 50
    `).all(targetCode);
    cb({
      reviews: rows.map(r => ({
        id: r.id,
        from: r.from_code,
        fromName: r.from_name,
        to: r.to_code,
        text: r.text,
        ts: r.ts
      }))
    });
  });

  // ----- ИСТОРИИ -----
  socket.on('addStory', ({ media }) => {
    const code = socket.data.code;
    const user = db.prepare('SELECT name FROM users WHERE code = ?').get(code);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const ts = Date.now();
    db.prepare('INSERT INTO stories (id, author_code, author_name, media, ts) VALUES (?, ?, ?, ?, ?)')
      .run(id, code, user.name, media, ts);
    // Удалить старые
    db.prepare('DELETE FROM stories WHERE ts < ?').run(Date.now() - 24 * 60 * 60 * 1000);
    const story = { id, author: code, authorName: user.name, media, ts };
    notifyFriends(code, 'storyAdded', { story });
  });

  // ----- ОТКЛЮЧЕНИЕ -----
  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code) return;
    if (onlineUsers.get(code) === socket.id) {
      onlineUsers.delete(code);
      notifyFriends(code, 'friendOnline', { code, online: false });
    }
    console.log('❌ disconnect', socket.id);
  });

  // ----- ПОМОЩНИКИ -----
  function notifyFriends(code, event, payload) {
    const friends = db.prepare('SELECT friend_code FROM friends WHERE user_code = ?').all(code);
    friends.forEach(f => {
      const targetSocket = onlineUsers.get(f.friend_code);
      if (targetSocket) {
        io.to(targetSocket).emit(event, payload);
      }
    });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
});