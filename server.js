 const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// --- Раздача статики ---
const server = http.createServer((req, res) => {
  let file = req.url === '/' ? '/index.html' : req.url;
  const fp = path.join(__dirname, 'public', file);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(fp);
    const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

// --- Состояние игры ---
const W = 800, H = 500, GROUND = H - 40, GRAVITY = 0.5;
const TOWER_BLOCKS = [];

function buildTower() {
  TOWER_BLOCKS.length = 0;
  const bw = 45, bh = 22;
  const baseX = W/2 - bw*2;
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 4; col++) {
      TOWER_BLOCKS.push({
        id: TOWER_BLOCKS.length,
        x: baseX + col*bw + (row%2 ? bw/2 : 0) - (row%2 ? bw/4 : 0),
        y: GROUND - (row+1)*bh - row*1,
        w: bw - 2, h: bh - 2,
        vx: 0, vy: 0,
        broken: false
      });
    }
  }
}
buildTower();

const state = {
  blocks: TOWER_BLOCKS,
  players: {},   // id -> {x,y,vx,vy,color,score,...}
  nextId: 1
};

const COLORS = ['#4fc3f7', '#ff7043'];

// --- Физика ---
function step() {
  // Игроки
  for (const id in state.players) {
    const p = state.players[id];
    if (!p.input) p.input = { left:false, right:false, up:false, down:false };

    const speed = 5;
    p.vx = 0;
    if (p.input.left) p.vx = -speed;
    if (p.input.right) p.vx = speed;

    p.x += p.vx;
    // Границы
    if (p.x < 0) p.x = 0;
    if (p.x + p.w > W) p.x = W - p.w;

    // Гравитация
    p.vy += GRAVITY;
    p.y += p.vy;

    // Земля
    if (p.y + p.h >= GROUND) {
      p.y = GROUND - p.h;
      p.vy = 0;
      p.onGround = true;
    } else {
      p.onGround = false;
    }

    // Прыжок/удар вверх
    if (p.input.up && p.onGround && p.jumpCd <= 0) {
      p.vy = -11;
      p.jumpCd = 12;
      p.onGround = false;
    }
    if (p.jumpCd > 0) p.jumpCd--;

    // Удар вниз
    if (p.input.down && p.downCd <= 0) {
      p.vy = 12;
      p.downCd = 20;
      p.hitDown = true;
    } else {
      p.hitDown = false;
    }
    if (p.downCd > 0) p.downCd--;
  }

  // Блоки
  for (const b of state.blocks) {
    if (b.broken) continue;

    b.vy += GRAVITY;
    b.x += b.vx;
    b.y += b.vy;
    b.vx *= 0.98;

    // Земля
    if (b.y + b.h >= GROUND) {
      b.y = GROUND - b.h;
      b.vy = 0;
      b.vx *= 0.7;
      if (Math.abs(b.vx) < 0.2) b.vx = 0;
    }
  }

  // Коллизии игрок-блок (толкание)
  for (const id in state.players) {
    const p = state.players[id];
    for (const b of state.blocks) {
      if (b.broken) continue;
      if (rectHit(p, b)) {
        // Толкаем блок
        const dx = (b.x + b.w/2) - (p.x + p.w/2);
        const dy = (b.y + b.h/2) - (p.y + p.h/2);
        if (Math.abs(dx) > Math.abs(dy)) {
          b.vx = Math.sign(dx) * 8;
        } else {
          if (dy < 0) { // игрок сверху — удар вниз
            b.vy = 10;
            if (p.hitDown) b.vx = (Math.random()-0.5)*6;
          } else {
            b.vy = -6;
          }
        }
        p.score += 1;
        p.lastHit = Date.now();
      }
    }
  }

  // Коллизии блок-блок (упрощённо: раздвигаем)
  for (let i = 0; i < state.blocks.length; i++) {
    const a = state.blocks[i];
    if (a.broken) continue;
    for (let j = i+1; j < state.blocks.length; j++) {
      const b = state.blocks[j];
      if (b.broken) continue;
      if (rectHit(a, b)) {
        // Расталкиваем по вертикали
        const overlapX = Math.min(a.x+a.w, b.x+b.w) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y+a.h, b.y+b.h) - Math.max(a.y, b.y);
        if (overlapY < overlapX) {
          const push = overlapY / 2;
          if (a.y < b.y) { a.y -= push; b.y += push; }
          else { a.y += push; b.y -= push; }
          a.vy = 0; b.vy = 0;
          // Передаём горизонтальную скорость
          const avg = (a.vx + b.vx) / 2;
          a.vx = avg * 0.9; b.vx = avg * 0.9;
        }
      }
    }
  }
}

function rectHit(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}

// --- Игровой цикл ---
setInterval(() => {
  step();
  // Рассылаем состояние всем
  const payload = JSON.stringify({ type: 'state', state });
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(payload);
  });
}, 1000 / 60);

// --- WebSocket ---
wss.on('connection', (ws) => {
  const id = state.nextId++;
  const color = COLORS[(id - 1) % COLORS.length];
  const side = (id % 2 === 1) ? 0 : 1;

  state.players[id] = {
    id, color, side,
    x: side === 0 ? W*0.25 : W*0.75,
    y: GROUND - 40,
    w: 40, h: 40, vx: 0, vy: 0,
    onGround: true, score: 0, jumpCd: 0, downCd: 0,
    input: { left:false, right:false, up:false, down:false }
  };

  ws.send(JSON.stringify({ type: 'init', id, color, side }));
  console.log(`Игрок ${id} подключился (${color})`);

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'input') {
        const p = state.players[id];
        if (p) p.input = data.input;
      }
      if (data.type === 'resetTower') {
        buildTower();
        for (const pid in state.players) state.players[pid].score = 0;
      }
    } catch(e) {}
  });

  ws.on('close', () => {
    delete state.players[id];
    console.log(`Игрок ${id} отключился`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
