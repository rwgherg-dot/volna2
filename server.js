const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// In-Memory Data Stores
const users = new Map(); // userId -> { id, username, password, displayName, avatarColor, status }
const activeSockets = new Map(); // socketId -> userId
const servers = new Map(); // serverId -> { id, name, inviteCode, ownerId, members: [{ userId, role }], channels: [...] }
const messages = new Map(); // channelId -> [{ id, channelId, serverId, author, content, timestamp, reactions }]
const voiceStates = new Map(); // serverId -> { [channelId]: [userIds] }

// Helper to sanitize user object (remove password)
function sanitizeUser(user) {
  if (!user) return null;
  const { password, ...safeUser } = user;
  return safeUser;
}

// Calculate total online unique users
function getOnlineUserCount() {
  const onlineUserIds = new Set();
  for (const [socketId, userId] of activeSockets.entries()) {
    if (userId) {
      onlineUserIds.add(userId);
    }
  }
  return onlineUserIds.size;
}

// Broadcast online count to all clients
function broadcastOnlineCount() {
  const count = getOnlineUserCount();
  io.emit('online:count', { count });
}

// Create Default Server on start
const DEFAULT_SERVER_ID = 'srv_default';
const DEFAULT_TEXT_CHAN_ID = 'chan_general_text';
const DEFAULT_VOICE_CHAN_ID = 'chan_general_voice';

function initDefaultData() {
  if (!servers.has(DEFAULT_SERVER_ID)) {
    const defaultServer = {
      id: DEFAULT_SERVER_ID,
      name: 'Главный Сервер',
      inviteCode: 'WELCOME',
      ownerId: 'system',
      members: [],
      channels: [
        { id: DEFAULT_TEXT_CHAN_ID, name: 'основной', type: 'text' },
        { id: DEFAULT_VOICE_CHAN_ID, name: 'Голосовой чат', type: 'voice' }
      ]
    };
    servers.set(DEFAULT_SERVER_ID, defaultServer);
    messages.set(DEFAULT_TEXT_CHAN_ID, [
      {
        id: 'msg_system_1',
        channelId: DEFAULT_TEXT_CHAN_ID,
        serverId: DEFAULT_SERVER_ID,
        author: { id: 'system', username: 'Система', displayName: 'Система', avatarColor: '#6366f1' },
        content: 'Добро пожаловать на Главный Сервер!',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        reactions: {}
      }
    ]);
    voiceStates.set(DEFAULT_SERVER_ID, {});
  }
}
initDefaultData();

// Get full server object with populated member details
function getPopulatedServer(serverId) {
  const srv = servers.get(serverId);
  if (!srv) return null;

  const populatedMembers = srv.members.map(m => {
    const u = users.get(m.userId);
    const isOnline = Array.from(activeSockets.values()).includes(m.userId);
    return {
      userId: m.userId,
      role: m.role,
      displayName: u ? u.displayName : 'Пользователь',
      username: u ? u.username : 'user',
      avatarColor: u ? u.avatarColor : '#6366f1',
      status: isOnline ? 'online' : 'offline'
    };
  });

  const srvVoiceState = voiceStates.get(serverId) || {};
  const populatedVoice = {};
  for (const [chanId, userIds] of Object.entries(srvVoiceState)) {
    populatedVoice[chanId] = (userIds || []).map(uId => {
      const u = users.get(uId);
      return {
        userId: uId,
        displayName: u ? u.displayName : 'Пользователь',
        avatarColor: u ? u.avatarColor : '#6366f1'
      };
    });
  }

  return {
    ...srv,
    members: populatedMembers,
    voiceStates: populatedVoice
  };
}

// Automatically add user to default server if not member
function ensureUserInDefaultServer(userId) {
  const srv = servers.get(DEFAULT_SERVER_ID);
  if (srv && !srv.members.some(m => m.userId === userId)) {
    srv.members.push({ userId, role: 'member' });
  }
}

// Socket Connection Handler
io.on('connection', (socket) => {
  broadcastOnlineCount();

  // --- Auth: Register ---
  socket.on('auth:register', (data, callback) => {
    const { username, password, displayName } = data || {};
    if (!username || !password) {
      const err = { success: false, error: 'Заполните имя пользователя и пароль' };
      if (typeof callback === 'function') callback(err);
      socket.emit('auth:error', err);
      return;
    }

    const cleanUsername = username.trim().toLowerCase();
    for (const u of users.values()) {
      if (u.username.toLowerCase() === cleanUsername) {
        const err = { success: false, error: 'Имя пользователя уже занято' };
        if (typeof callback === 'function') callback(err);
        socket.emit('auth:error', err);
        return;
      }
    }

    const avatarColors = ['#6366f1', '#8b5cf6', '#ec4899', '#10b981', '#f59e0b', '#3b82f6', '#ef4444', '#14b8a6'];
    const avatarColor = avatarColors[Math.floor(Math.random() * avatarColors.length)];
    const userId = 'usr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);

    const newUser = {
      id: userId,
      username: cleanUsername,
      password: password,
      displayName: (displayName && displayName.trim()) ? displayName.trim() : username,
      avatarColor: avatarColor,
      status: 'online'
    };

    users.set(userId, newUser);
    ensureUserInDefaultServer(userId);

    socket.userId = userId;
    activeSockets.set(socket.id, userId);

    const safeUser = sanitizeUser(newUser);
    const res = { success: true, user: safeUser };

    if (typeof callback === 'function') callback(res);
    socket.emit('auth:success', safeUser);

    broadcastOnlineCount();
  });

  // --- Auth: Login ---
  socket.on('auth:login', (data, callback) => {
    const { username, password } = data || {};
    if (!username || !password) {
      const err = { success: false, error: 'Заполните имя пользователя и пароль' };
      if (typeof callback === 'function') callback(err);
      socket.emit('auth:error', err);
      return;
    }

    const cleanUsername = username.trim().toLowerCase();
    let foundUser = null;
    for (const u of users.values()) {
      if (u.username.toLowerCase() === cleanUsername) {
        foundUser = u;
        break;
      }
    }

    if (!foundUser || foundUser.password !== password) {
      const err = { success: false, error: 'Неверное имя пользователя или пароль' };
      if (typeof callback === 'function') callback(err);
      socket.emit('auth:error', err);
      return;
    }

    ensureUserInDefaultServer(foundUser.id);
    socket.userId = foundUser.id;
    activeSockets.set(socket.id, foundUser.id);

    const safeUser = sanitizeUser(foundUser);
    const res = { success: true, user: safeUser };

    if (typeof callback === 'function') callback(res);
    socket.emit('auth:success', safeUser);

    broadcastOnlineCount();
  });

  // --- User Profile Update ---
  socket.on('user:update_profile', (data, callback) => {
    if (!socket.userId) return;
    const user = users.get(socket.userId);
    if (!user) return;

    if (data.displayName && data.displayName.trim()) {
      user.displayName = data.displayName.trim();
    }
    if (data.avatarColor) {
      user.avatarColor = data.avatarColor;
    }

    const safeUser = sanitizeUser(user);
    const res = { success: true, user: safeUser };
    if (typeof callback === 'function') callback(res);
    socket.emit('user:profile_updated', safeUser);
  });

  // --- Server: List ---
  socket.on('server:list', (data, callback) => {
    if (!socket.userId) {
      if (typeof callback === 'function') callback({ success: false, error: 'Не авторизован' });
      return;
    }
    ensureUserInDefaultServer(socket.userId);

    const userServers = [];
    for (const srv of servers.values()) {
      if (srv.members.some(m => m.userId === socket.userId)) {
        socket.join(srv.id);
        userServers.push(getPopulatedServer(srv.id));
      }
    }

    const res = { success: true, servers: userServers };
    if (typeof callback === 'function') callback(res);
    socket.emit('server:list', userServers);
  });

  // --- Server: Create ---
  socket.on('server:create', (data, callback) => {
    if (!socket.userId) return;
    const name = (data && data.name) ? data.name.trim() : '';
    if (!name) {
      if (typeof callback === 'function') callback({ success: false, error: 'Укажите название сервера' });
      return;
    }

    const serverId = 'srv_' + Date.now();
    const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const defaultTextChan = { id: 'chan_' + Date.now() + '_1', name: 'основной', type: 'text' };
    const defaultVoiceChan = { id: 'chan_' + Date.now() + '_2', name: 'Голосовой чат', type: 'voice' };

    const newServer = {
      id: serverId,
      name,
      inviteCode,
      ownerId: socket.userId,
      members: [{ userId: socket.userId, role: 'admin' }],
      channels: [defaultTextChan, defaultVoiceChan]
    };

    servers.set(serverId, newServer);
    messages.set(defaultTextChan.id, []);
    voiceStates.set(serverId, {});

    socket.join(serverId);

    const populated = getPopulatedServer(serverId);
    const res = { success: true, server: populated };
    if (typeof callback === 'function') callback(res);
    io.to(serverId).emit('server:updated', populated);
  });

  // --- Server: Join by Invite ---
  socket.on('server:join_invite', (data, callback) => {
    if (!socket.userId) return;
    const inviteCode = (data && data.inviteCode) ? data.inviteCode.trim().toUpperCase() : '';
    if (!inviteCode) {
      if (typeof callback === 'function') callback({ success: false, error: 'Введите код приглашения' });
      return;
    }

    let targetServer = null;
    for (const srv of servers.values()) {
      if (srv.inviteCode === inviteCode) {
        targetServer = srv;
        break;
      }
    }

    if (!targetServer) {
      const err = { success: false, error: 'Сервер с таким кодом не найден' };
      if (typeof callback === 'function') callback(err);
      return;
    }

    if (!targetServer.members.some(m => m.userId === socket.userId)) {
      targetServer.members.push({ userId: socket.userId, role: 'member' });
    }

    socket.join(targetServer.id);
    const populated = getPopulatedServer(targetServer.id);
    const res = { success: true, server: populated };

    if (typeof callback === 'function') callback(res);
    io.to(targetServer.id).emit('server:updated', populated);
  });

  // --- Channel: Create ---
  socket.on('channel:create', (data, callback) => {
    if (!socket.userId) return;
    const { serverId, name, type } = data || {};
    const srv = servers.get(serverId);
    if (!srv) {
      if (typeof callback === 'function') callback({ success: false, error: 'Сервер не найден' });
      return;
    }

    const userMember = srv.members.find(m => m.userId === socket.userId);
    if (!userMember || userMember.role !== 'admin') {
      if (typeof callback === 'function') callback({ success: false, error: 'Только администратор может создавать каналы' });
      return;
    }

    const cleanName = (name || '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!cleanName) {
      if (typeof callback === 'function') callback({ success: false, error: 'Укажите название канала' });
      return;
    }

    const newChan = {
      id: 'chan_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      name: cleanName,
      type: type === 'voice' ? 'voice' : 'text'
    };

    srv.channels.push(newChan);
    if (newChan.type === 'text') {
      messages.set(newChan.id, []);
    }

    const populated = getPopulatedServer(serverId);
    if (typeof callback === 'function') callback({ success: true, channel: newChan, server: populated });
    io.to(serverId).emit('server:updated', populated);
  });

  // --- Channel: History ---
  socket.on('channel:history', (data, callback) => {
    const channelId = typeof data === 'string' ? data : (data && data.channelId);
    const chanMsgs = messages.get(channelId) || [];
    const res = { success: true, channelId, messages: chanMsgs };
    if (typeof callback === 'function') callback(res);
    socket.emit('channel:history', res);
  });

  // --- Message: Send ---
  socket.on('message:send', (data, callback) => {
    if (!socket.userId) return;
    const { channelId, serverId, text } = data || {};
    if (!text || !text.trim()) return;

    const user = users.get(socket.userId);
    if (!user) return;

    if (!messages.has(channelId)) {
      messages.set(channelId, []);
    }

    const newMsg = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      channelId,
      serverId,
      author: sanitizeUser(user),
      content: text.trim(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      reactions: {}
    };

    messages.get(channelId).push(newMsg);

    if (typeof callback === 'function') callback({ success: true, message: newMsg });
    io.to(serverId).emit('message:new', newMsg);
  });

  // --- Message: React ---
  socket.on('message:react', (data, callback) => {
    if (!socket.userId) return;
    const { channelId, messageId, reaction, serverId } = data || {};
    if (!channelId || !messageId || !reaction) return;

    const chanMsgs = messages.get(channelId);
    if (!chanMsgs) return;

    const msg = chanMsgs.find(m => m.id === messageId);
    if (!msg) return;

    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[reaction]) msg.reactions[reaction] = [];

    const userIdx = msg.reactions[reaction].indexOf(socket.userId);
    if (userIdx !== -1) {
      msg.reactions[reaction].splice(userIdx, 1);
      if (msg.reactions[reaction].length === 0) {
        delete msg.reactions[reaction];
      }
    } else {
      msg.reactions[reaction].push(socket.userId);
    }

    if (typeof callback === 'function') callback({ success: true, message: msg });
    io.to(serverId).emit('message:updated', msg);
  });

  // --- Voice: Join ---
  socket.on('voice:join', (data, callback) => {
    if (!socket.userId) return;
    const { serverId, channelId } = data || {};
    if (!serverId || !channelId) return;

    // Leave any previous voice channels across all servers
    for (const [sId, srvVoice] of voiceStates.entries()) {
      for (const cId of Object.keys(srvVoice)) {
        if (srvVoice[cId]) {
          srvVoice[cId] = srvVoice[cId].filter(id => id !== socket.userId);
        }
      }
      io.to(sId).emit('server:updated', getPopulatedServer(sId));
    }

    let srvVoice = voiceStates.get(serverId);
    if (!srvVoice) {
      srvVoice = {};
      voiceStates.set(serverId, srvVoice);
    }
    if (!srvVoice[channelId]) {
      srvVoice[channelId] = [];
    }
    if (!srvVoice[channelId].includes(socket.userId)) {
      srvVoice[channelId].push(socket.userId);
    }

    const populated = getPopulatedServer(serverId);
    if (typeof callback === 'function') callback({ success: true, server: populated });
    io.to(serverId).emit('server:updated', populated);
  });

  // --- Voice: Leave ---
  socket.on('voice:leave', (data, callback) => {
    if (!socket.userId) return;
    const { serverId } = data || {};

    for (const [sId, srvVoice] of voiceStates.entries()) {
      if (!serverId || sId === serverId) {
        for (const cId of Object.keys(srvVoice)) {
          if (srvVoice[cId]) {
            srvVoice[cId] = srvVoice[cId].filter(id => id !== socket.userId);
          }
        }
        io.to(sId).emit('server:updated', getPopulatedServer(sId));
      }
    }

    if (typeof callback === 'function') callback({ success: true });
  });

  // --- Disconnect ---
  socket.on('disconnect', () => {
    const userId = activeSockets.get(socket.id);
    activeSockets.delete(socket.id);

    if (userId) {
      const stillActive = Array.from(activeSockets.values()).includes(userId);
      if (!stillActive) {
        for (const [sId, srvVoice] of voiceStates.entries()) {
          let updated = false;
          for (const cId of Object.keys(srvVoice)) {
            if (srvVoice[cId] && srvVoice[cId].includes(userId)) {
              srvVoice[cId] = srvVoice[cId].filter(id => id !== userId);
              updated = true;
            }
          }
          if (updated) {
            io.to(sId).emit('server:updated', getPopulatedServer(sId));
          }
        }
      }
    }

    broadcastOnlineCount();
  });
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`========================================`);
  console.log(`Server is running!`);
  console.log(`Listening on http://${HOST}:${PORT}`);
  console.log(`Local Access: http://localhost:${PORT}`);
  console.log(`========================================`);
});
