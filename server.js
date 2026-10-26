const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// File Database Path
const DB_FILE = path.join(__dirname, 'server_db.json');

// Initialize Local JSON DB
let db = {
  users: {},
  messages: []
};

if (fs.existsSync(DB_FILE)) {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    db = JSON.parse(raw);
  } catch (e) {
    console.warn('DB file corrupt, creating new database.', e);
  }
} else {
  saveDB();
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save DB file', e);
  }
}

// Serve Frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Active Client Connections Map: Handle -> WebSocket
const activeSockets = new Map();

wss.on('connection', (ws) => {
  let authenticatedHandle = null;

  ws.on('message', (messageRaw) => {
    try {
      const data = JSON.parse(messageRaw);
      const { type, payload } = data;

      switch (type) {
        case 'REGISTER': {
          let handle = payload.handle.startsWith('@') ? payload.handle.toLowerCase() : '@' + payload.handle.toLowerCase();
          if (db.users[handle]) {
            ws.send(JSON.stringify({ type: 'REGISTER_RESPONSE', success: false, error: 'Пользователь с таким @username уже существует' }));
            return;
          }

          const newUser = {
            id: 'usr_' + Date.now(),
            name: payload.name || handle,
            handle: handle,
            password: payload.password,
            color: payload.color || '#2563eb',
            registeredAt: Date.now()
          };

          db.users[handle] = newUser;
          saveDB();

          authenticatedHandle = handle;
          activeSockets.set(handle, ws);

          ws.send(JSON.stringify({ type: 'REGISTER_RESPONSE', success: true, user: newUser }));
          broadcastUsersList();
          break;
        }

        case 'LOGIN': {
          let handle = payload.handle.startsWith('@') ? payload.handle.toLowerCase() : '@' + payload.handle.toLowerCase();
          const user = db.users[handle];

          if (!user || user.password !== payload.password) {
            ws.send(JSON.stringify({ type: 'LOGIN_RESPONSE', success: false, error: 'Неверный username или пароль' }));
            return;
          }

          authenticatedHandle = handle;
          activeSockets.set(handle, ws);

          ws.send(JSON.stringify({ type: 'LOGIN_RESPONSE', success: true, user: user }));
          broadcastUsersList();
          break;
        }

        case 'GET_USERS': {
          ws.send(JSON.stringify({ type: 'USERS_LIST', users: formatUsersList() }));
          break;
        }

        case 'GET_MESSAGES': {
          if (!authenticatedHandle) return;
          const partnerHandle = payload.partnerHandle;
          const conversation = db.messages.filter(m =>
            (m.from === authenticatedHandle && m.to === partnerHandle) ||
            (m.from === partnerHandle && m.to === authenticatedHandle)
          );

          // Mark received messages as read
          conversation.forEach(m => {
            if (m.to === authenticatedHandle) m.read = true;
          });
          saveDB();

          ws.send(JSON.stringify({ type: 'MESSAGES_HISTORY', partnerHandle: partnerHandle, messages: conversation }));
          break;
        }

        case 'SEND_MESSAGE': {
          if (!authenticatedHandle) return;

          const now = new Date();
          const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

          const newMsg = {
            id: 'msg_' + Date.now(),
            from: authenticatedHandle,
            to: payload.to,
            type: payload.msgType || 'text',
            text: payload.text || '',
            fileName: payload.fileName,
            fileSize: payload.fileSize,
            duration: payload.duration,
            time: timeStr,
            read: false,
            timestamp: Date.now()
          };

          db.messages.push(newMsg);
          saveDB();

          // Send confirmation to sender
          ws.send(JSON.stringify({ type: 'MESSAGE_SENT_CONFIRM', msg: newMsg }));

          // Forward to target if online
          const targetSocket = activeSockets.get(payload.to);
          if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
            targetSocket.send(JSON.stringify({ type: 'NEW_INCOMING_MESSAGE', msg: newMsg }));
          }

          broadcastUsersList();
          break;
        }

        case 'CALL_SIGNAL': {
          if (!authenticatedHandle) return;
          const targetSocket = activeSockets.get(payload.to);
          if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
            targetSocket.send(JSON.stringify({
              type: 'CALL_SIGNAL',
              from: authenticatedHandle,
              signalType: payload.signalType,
              callType: payload.callType
            }));
          }
          break;
        }
      }
    } catch (err) {
      console.error('Error handling WebSocket message', err);
    }
  });

  ws.on('close', () => {
    if (authenticatedHandle) {
      activeSockets.delete(authenticatedHandle);
      broadcastUsersList();
    }
  });
});

function formatUsersList() {
  const list = [];
  for (let handle in db.users) {
    const user = db.users[handle];
    list.push({
      id: user.id,
      name: user.name,
      handle: user.handle,
      color: user.color,
      online: activeSockets.has(handle)
    });
  }
  return list;
}

function broadcastUsersList() {
  const payload = JSON.stringify({ type: 'USERS_LIST', users: formatUsersList() });
  for (let socket of activeSockets.values()) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    }
  }
}

// Get Local IP Addresses for LAN sharing
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (let k in interfaces) {
    for (let k2 of interfaces[k]) {
      if (k2.family === 'IPv4' && !k2.internal) {
        addresses.push(k2.address);
      }
    }
  }
  return addresses;
}

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(` QWETRY Messenger Server launched successfully!`);
  console.log(`======================================================`);
  console.log(` Local access:   http://localhost:${PORT}`);
  const ips = getLocalIPs();
  ips.forEach(ip => {
    console.log(` Network access: http://${ip}:${PORT}`);
  });
  console.log(`======================================================\n`);
});
