const express = require('express'), http = require('http'), path = require('path'),
  fs = require('fs'), crypto = require('crypto');
const { Server } = require('socket.io');

const app = express(), server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e7 });
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- "База" в db.json ---------- */
const DB = path.join(__dirname, 'db.json');
let db = { users: {}, messages: [], groups: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB, 'utf8'))); } catch (e) {}
let timer;
const save = () => { clearTimeout(timer); timer = setTimeout(() => fs.writeFile(DB, JSON.stringify(db), () => {}), 300); };

const hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const uid = () => crypto.randomBytes(8).toString('hex');
const online = {}; // code -> Set(socketId)
const isOn = c => !!(online[c] && online[c].size);
const pub = u => ({ code: u.code, name: u.name, photo: u.photo || null, online: isOn(u.code) });
const toUser = (code, ev, data) => io.to('u:' + code).emit(ev, data);
const groupsOf = c => Object.values(db.groups).filter(g => g.members.includes(c));
const inChat = (m, me, other, gid) =>
  gid ? m.groupId === gid : (!m.groupId && ((m.from === me && m.to === other) || (m.from === other && m.to === me)));

io.on('connection', socket => {
  const me = () => db.users[socket.data.code];

  socket.on('register', (d, cb) => {
    d = d || {};
    const name = String(d.name || '').trim().slice(0, 24), pass = String(d.pass || '');
    if (!name || !pass) return cb({ ok: false, error: 'Заполните поля' });
    let u = Object.values(db.users).find(x => x.name.toLowerCase() === name.toLowerCase());
    if (u) {
      if (hash(pass, u.salt) !== u.hash) return cb({ ok: false, error: 'Неверный пароль' });
    } else {
      let code = name === 'ADMIN' ? 'ADMIN' : String(d.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      if (!code || db.users[code]) code = crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
      const salt = uid();
      u = db.users[code] = { code, name, salt, hash: hash(pass, salt), photo: null, stars: 0, friends: [] };
    }
    if (typeof d.photo === 'string' && d.photo.startsWith('data:image') && d.photo.length < 3e6) u.photo = d.photo;
    save();

    socket.data.code = u.code;
    socket.join('u:' + u.code);
    (online[u.code] ||= new Set()).add(socket.id);
    u.friends.forEach(c => toUser(c, 'friendOnline', { code: u.code, online: true }));

    const lasts = {};
    for (const m of db.messages) {
      if (m.groupId) { if (db.groups[m.groupId]?.members.includes(u.code)) lasts[m.groupId] = m; }
      else if (m.from === u.code) lasts[m.to] = m;
      else if (m.to === u.code) lasts[m.from] = m;
    }
    cb({
      ok: true,
      user: { code: u.code, name: u.name, photo: u.photo, stars: u.stars },
      friends: u.friends.map(c => db.users[c]).filter(Boolean).map(pub),
      groups: groupsOf(u.code),
      lasts,
    });
  });

  socket.on('disconnect', () => {
    const c = socket.data.code; if (!c || !online[c]) return;
    online[c].delete(socket.id);
    if (!online[c].size) { const u = db.users[c]; u && u.friends.forEach(f => toUser(f, 'friendOnline', { code: c, online: false })); }
  });

  socket.on('searchUsers', ({ query } = {}, cb) => {
    const u = me(); if (!u) return cb({ ok: false });
    const q = String(query || '').trim().toLowerCase();
    const users = Object.values(db.users)
      .filter(x => x.code !== u.code && (x.code.toLowerCase() === q || x.name.toLowerCase().includes(q)))
      .slice(0, 20).map(pub);
    cb({ ok: true, users });
  });

  socket.on('addFriendByCode', ({ code } = {}, cb) => {
    const u = me(); if (!u) return cb({ ok: false, error: 'Не авторизован' });
    const f = db.users[String(code || '').trim().toUpperCase()];
    if (!f) return cb({ ok: false, error: 'Пользователь не найден' });
    if (f.code === u.code) return cb({ ok: false, error: 'Это вы' });
    const already = u.friends.includes(f.code);
    if (!already) {
      u.friends.push(f.code); if (!f.friends.includes(u.code)) f.friends.push(u.code);
      save(); toUser(f.code, 'friendAdded', pub(u));
    }
    cb({ ok: true, already, friend: pub(f) });
  });

  socket.on('createGroup', ({ name, members } = {}, cb) => {
    const u = me(); if (!u) return cb({ ok: false });
    name = String(name || '').trim().slice(0, 40);
    if (!name) return cb({ ok: false, error: 'Введите название' });
    const list = [...new Set([u.code, ...(members || []).filter(c => u.friends.includes(c))])];
    if (list.length < 2) return cb({ ok: false, error: 'Выберите друзей' });
    const g = db.groups['g' + uid()] = { id: '', name, members: list, owner: u.code };
    g.id = Object.keys(db.groups).find(k => db.groups[k] === g);
    save(); list.forEach(c => toUser(c, 'groupAdded', g));
    cb({ ok: true, group: g });
  });

  socket.on('loadHistory', ({ withCode, groupId } = {}, cb) => {
    const u = me(); if (!u) return cb({ history: [] });
    if (groupId && !db.groups[groupId]?.members.includes(u.code)) return cb({ history: [] });
    cb({ history: db.messages.filter(m => inChat(m, u.code, withCode, groupId)).slice(-300) });
  });

  socket.on('markRead', () => {});

  socket.on('sendMessage', (d = {}, cb) => {
    const u = me(); if (!u) return;
    const text = String(d.text || '').slice(0, 4000);
    if (!text.trim()) return;
    const m = { id: uid(), from: u.code, kind: 'text', text, ts: Date.now(), reactions: {} };
    if (d.groupId) {
      const g = db.groups[d.groupId];
      if (!g || !g.members.includes(u.code)) return;
      m.groupId = g.id; db.messages.push(m); save();
      g.members.forEach(c => c === u.code ? toUser(c, 'messageSent', { groupId: g.id, message: m })
                                          : toUser(c, 'newMessage', { from: u.code, message: m }));
    } else {
      if (!u.friends.includes(d.to)) return;
      m.to = d.to; db.messages.push(m); save();
      toUser(u.code, 'messageSent', { to: d.to, message: m });
      toUser(d.to, 'newMessage', { from: u.code, message: m });
    }
    cb && cb({ ok: true });
  });

  socket.on('reactToMessage', ({ id, emoji } = {}) => {
    const u = me(); const m = db.messages.find(x => x.id === id);
    if (!u || !m || typeof emoji !== 'string') return;
    const people = m.groupId ? (db.groups[m.groupId]?.members || []) : [m.from, m.to];
    if (!people.includes(u.code)) return;
    m.reactions ||= {};
    const arr = m.reactions[emoji] ||= [];
    const i = arr.indexOf(u.code);
    i >= 0 ? arr.splice(i, 1) : arr.push(u.code);
    if (!arr.length) delete m.reactions[emoji];
    save(); people.forEach(c => toUser(c, 'messageReacted', { id, reactions: m.reactions }));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Volna: http://localhost:' + PORT));
