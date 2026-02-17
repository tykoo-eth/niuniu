const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const gameEngine = require('./game.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ======================== 游戏状态管理 ========================

const rooms = new Map();       // roomId -> Room
const playerSockets = new Map(); // socketId -> { roomId, playerId, nickname }

const BASE_COINS = 10000;     // 每个玩家初始金币
const ROOM_BASE = 100;        // 房间基数

/**
 * 游戏阶段
 */
const PHASE = {
  WAITING: 'waiting',         // 等待玩家加入
  GRAB_BANKER: 'grab_banker', // 抢庄阶段
  CHOOSE_MULTI: 'choose_multi', // 选倍数阶段
  DEAL_CARDS: 'deal_cards',   // 发牌/看牌阶段
  SPLIT_CARDS: 'split_cards', // 分牌阶段
  SHOW_RESULT: 'show_result'  // 展示结果
};

function createRoom(roomId) {
  return {
    id: roomId,
    players: new Map(),   // playerId -> Player
    phase: PHASE.WAITING,
    banker: null,          // 庄家playerId
    grabBankerPlayers: [], // 抢庄的玩家列表
    grabBankerResponses: new Map(), // playerId -> bool
    multiplierResponses: new Map(), // playerId -> number
    hands: new Map(),      // playerId -> [cards]
    evaluations: new Map(), // playerId -> evaluation
    splitResponses: new Map(), // playerId -> group3 indices
    results: null,
    roundCount: 0,
    baseAmount: ROOM_BASE,
    countdown: null
  };
}

function createPlayer(id, nickname, socketId) {
  return {
    id,
    nickname,
    socketId,
    coins: BASE_COINS,
    ready: false,
    multiplier: 1,
    escaped: false,
    connected: true
  };
}

function getRoomPlayerList(room) {
  const list = [];
  for (const [pid, p] of room.players) {
    list.push({
      id: pid,
      nickname: p.nickname,
      coins: p.coins,
      ready: p.ready,
      isBanker: room.banker === pid,
      connected: p.connected
    });
  }
  return list;
}

function broadcastRoomState(room) {
  const playerList = getRoomPlayerList(room);
  for (const [pid, p] of room.players) {
    if (!p.connected) continue;
    const myCards = room.hands.get(pid) || [];
    io.to(p.socketId).emit('room_state', {
      roomId: room.id,
      phase: room.phase,
      players: playerList,
      myCards,
      banker: room.banker,
      myId: pid,
      roundCount: room.roundCount,
      baseAmount: room.baseAmount
    });
  }
}

// ======================== 游戏流程控制 ========================

function clearTimers(room) {
  if (room.countdown) {
    clearTimeout(room.countdown);
    room.countdown = null;
  }
}

function startGrabBankerPhase(room) {
  room.phase = PHASE.GRAB_BANKER;
  room.grabBankerResponses.clear();
  room.grabBankerPlayers = [];
  room.roundCount++;

  broadcastRoomState(room);
  io.to(room.id).emit('phase_change', {
    phase: PHASE.GRAB_BANKER,
    message: '抢庄阶段 - 请选择是否抢庄',
    timeout: 10
  });

  // 10秒超时自动处理
  room.countdown = setTimeout(() => {
    for (const [pid] of room.players) {
      if (!room.grabBankerResponses.has(pid)) {
        room.grabBankerResponses.set(pid, false);
      }
    }
    resolveGrabBanker(room);
  }, 10000);
}

function resolveGrabBanker(room) {
  clearTimers(room);

  // 收集抢庄玩家
  room.grabBankerPlayers = [];
  for (const [pid, grabbed] of room.grabBankerResponses) {
    if (grabbed) room.grabBankerPlayers.push(pid);
  }

  // 如果没人抢庄，随机指定
  if (room.grabBankerPlayers.length === 0) {
    const allPlayers = Array.from(room.players.keys());
    room.banker = allPlayers[Math.floor(Math.random() * allPlayers.length)];
    const bankerName = room.players.get(room.banker).nickname;
    io.to(room.id).emit('banker_decided', {
      bankerId: room.banker,
      bankerName,
      message: `无人抢庄，随机指定 ${bankerName} 为庄家`
    });
  } else {
    // 在抢庄玩家中随机选择
    room.banker = room.grabBankerPlayers[
      Math.floor(Math.random() * room.grabBankerPlayers.length)
    ];
    const bankerName = room.players.get(room.banker).nickname;
    io.to(room.id).emit('banker_decided', {
      bankerId: room.banker,
      bankerName,
      message: `${bankerName} 成为庄家！`
    });
  }

  // 进入选倍数阶段
  setTimeout(() => startChooseMultiplierPhase(room), 2000);
}

function startChooseMultiplierPhase(room) {
  room.phase = PHASE.CHOOSE_MULTI;
  room.multiplierResponses.clear();

  // 庄家自动倍数1
  room.multiplierResponses.set(room.banker, 1);
  room.players.get(room.banker).multiplier = 1;

  broadcastRoomState(room);
  io.to(room.id).emit('phase_change', {
    phase: PHASE.CHOOSE_MULTI,
    message: '闲家选择倍数',
    timeout: 8,
    bankerId: room.banker
  });

  // 8秒超时
  room.countdown = setTimeout(() => {
    for (const [pid] of room.players) {
      if (pid !== room.banker && !room.multiplierResponses.has(pid)) {
        room.multiplierResponses.set(pid, 1);
        room.players.get(pid).multiplier = 1;
      }
    }
    startDealPhase(room);
  }, 8000);
}

function startDealPhase(room) {
  clearTimers(room);
  room.phase = PHASE.DEAL_CARDS;

  // 发牌
  const playerIds = Array.from(room.players.keys());
  const hands = gameEngine.dealCards(playerIds.length);
  room.hands.clear();
  playerIds.forEach((pid, idx) => {
    room.hands.set(pid, hands[idx]);
  });

  // 自动评估所有手牌
  room.evaluations.clear();
  for (const [pid, cards] of room.hands) {
    room.evaluations.set(pid, gameEngine.evaluateHand(cards));
  }

  broadcastRoomState(room);
  io.to(room.id).emit('phase_change', {
    phase: PHASE.DEAL_CARDS,
    message: '发牌完成，请查看手牌',
    timeout: 3
  });

  // 3秒后进入分牌阶段
  room.countdown = setTimeout(() => startSplitPhase(room), 3000);
}

function startSplitPhase(room) {
  clearTimers(room);
  room.phase = PHASE.SPLIT_CARDS;
  room.splitResponses.clear();

  broadcastRoomState(room);

  // 给每个玩家发送他们的牌型评估（最佳分法提示）
  for (const [pid, p] of room.players) {
    if (!p.connected) continue;
    const eval_ = room.evaluations.get(pid);
    io.to(p.socketId).emit('phase_change', {
      phase: PHASE.SPLIT_CARDS,
      message: '请选择3张牌组成牛（点数之和为10的倍数）',
      timeout: 20,
      bestSplit: eval_
    });
  }

  // 20秒超时自动使用最优分法
  room.countdown = setTimeout(() => {
    for (const [pid] of room.players) {
      if (!room.splitResponses.has(pid)) {
        const eval_ = room.evaluations.get(pid);
        room.splitResponses.set(pid, {
          group3: eval_.group3,
          auto: true
        });
      }
    }
    resolveRound(room);
  }, 20000);
}

function resolveRound(room) {
  clearTimers(room);
  room.phase = PHASE.SHOW_RESULT;

  const bankerEval = room.evaluations.get(room.banker);
  const players = [];

  for (const [pid, p] of room.players) {
    if (pid === room.banker) continue;
    players.push({
      playerId: pid,
      eval: room.evaluations.get(pid),
      multiplier: p.multiplier
    });
  }

  const results = gameEngine.calculateResults(bankerEval, players, room.baseAmount);

  // 计算庄家总收益
  let bankerTotal = 0;
  for (const r of results) {
    bankerTotal += r.bankerChange;
  }

  // 更新金币
  const bankerPlayer = room.players.get(room.banker);
  bankerPlayer.coins += bankerTotal;

  for (const r of results) {
    const p = room.players.get(r.playerId);
    p.coins += r.amount;
  }

  // 构建结果数据发送给所有玩家
  const resultData = {
    banker: {
      id: room.banker,
      nickname: bankerPlayer.nickname,
      cards: room.hands.get(room.banker),
      eval: bankerEval,
      coinsChange: bankerTotal,
      coins: bankerPlayer.coins
    },
    players: results.map(r => {
      const p = room.players.get(r.playerId);
      return {
        id: r.playerId,
        nickname: p.nickname,
        cards: room.hands.get(r.playerId),
        eval: room.evaluations.get(r.playerId),
        result: r.result,
        coinsChange: r.amount,
        coins: p.coins,
        multiplier: p.multiplier,
        handName: r.handName
      };
    })
  };

  room.results = resultData;
  io.to(room.id).emit('round_result', resultData);

  // 重置准备状态
  for (const [, p] of room.players) {
    p.ready = false;
    p.multiplier = 1;
  }

  // 清理本轮数据
  setTimeout(() => {
    room.phase = PHASE.WAITING;
    room.banker = null;
    room.hands.clear();
    room.evaluations.clear();
    room.splitResponses.clear();
    broadcastRoomState(room);
  }, 8000);
}

function checkAllReady(room) {
  if (room.players.size < 2) return false;
  for (const [, p] of room.players) {
    if (!p.ready || !p.connected) return false;
  }
  return true;
}

// ======================== Socket.IO 事件处理 ========================

io.on('connection', (socket) => {
  console.log(`玩家连接: ${socket.id}`);

  // 加入房间
  socket.on('join_room', ({ roomId, nickname }) => {
    if (!roomId || !nickname) {
      socket.emit('error_msg', { message: '请输入房间号和昵称' });
      return;
    }

    // 检查是否已经在某个房间
    if (playerSockets.has(socket.id)) {
      socket.emit('error_msg', { message: '你已经在一个房间中了' });
      return;
    }

    let room = rooms.get(roomId);
    if (!room) {
      room = createRoom(roomId);
      rooms.set(roomId, room);
    }

    if (room.phase !== PHASE.WAITING) {
      socket.emit('error_msg', { message: '游戏正在进行中，请等待本轮结束' });
      return;
    }

    if (room.players.size >= 6) {
      socket.emit('error_msg', { message: '房间已满（最多6人）' });
      return;
    }

    // 检查昵称是否重复
    for (const [, p] of room.players) {
      if (p.nickname === nickname) {
        socket.emit('error_msg', { message: '昵称已被使用，请换一个' });
        return;
      }
    }

    const playerId = `p_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const player = createPlayer(playerId, nickname, socket.id);
    room.players.set(playerId, player);

    playerSockets.set(socket.id, { roomId, playerId, nickname });
    socket.join(roomId);

    console.log(`${nickname} 加入房间 ${roomId}`);

    socket.emit('joined', { playerId, roomId, nickname });
    broadcastRoomState(room);
    io.to(roomId).emit('system_msg', { message: `${nickname} 加入了房间` });
  });

  // 准备
  socket.on('ready', () => {
    const info = playerSockets.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomId);
    if (!room || room.phase !== PHASE.WAITING) return;

    const player = room.players.get(info.playerId);
    if (!player) return;

    player.ready = !player.ready;
    broadcastRoomState(room);

    if (checkAllReady(room)) {
      io.to(room.id).emit('system_msg', { message: '所有玩家已准备，游戏即将开始！' });
      setTimeout(() => startGrabBankerPhase(room), 1500);
    }
  });

  // 抢庄
  socket.on('grab_banker', ({ grab }) => {
    const info = playerSockets.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomId);
    if (!room || room.phase !== PHASE.GRAB_BANKER) return;

    room.grabBankerResponses.set(info.playerId, grab);
    const player = room.players.get(info.playerId);
    io.to(room.id).emit('system_msg', {
      message: `${player.nickname} ${grab ? '抢庄' : '不抢'}`
    });

    // 所有人都回应了
    if (room.grabBankerResponses.size === room.players.size) {
      resolveGrabBanker(room);
    }
  });

  // 选倍数
  socket.on('choose_multiplier', ({ multiplier }) => {
    const info = playerSockets.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomId);
    if (!room || room.phase !== PHASE.CHOOSE_MULTI) return;
    if (info.playerId === room.banker) return;

    const validMultipliers = [1, 2, 3, 4, 5];
    if (!validMultipliers.includes(multiplier)) return;

    room.multiplierResponses.set(info.playerId, multiplier);
    room.players.get(info.playerId).multiplier = multiplier;

    const player = room.players.get(info.playerId);
    io.to(room.id).emit('system_msg', {
      message: `${player.nickname} 选择了 ${multiplier} 倍`
    });

    // 所有闲家都选了
    const nonBankerCount = room.players.size - 1;
    const respondedCount = room.multiplierResponses.size - 1; // 减去庄家
    if (respondedCount >= nonBankerCount) {
      startDealPhase(room);
    }
  });

  // 分牌
  socket.on('split_cards', ({ group3 }) => {
    const info = playerSockets.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomId);
    if (!room || room.phase !== PHASE.SPLIT_CARDS) return;

    const cards = room.hands.get(info.playerId);
    if (!cards) return;

    // 验证分牌
    if (group3 && group3.length === 3) {
      const validation = gameEngine.validatePlayerSplit(cards, group3);
      if (validation.valid) {
        // 使用玩家选择的分法重新评估
        const eval_ = room.evaluations.get(info.playerId);
        eval_.group3 = validation.group3;
        eval_.group2 = validation.group2;
        eval_.handType = validation.handType;
        eval_.handName = validation.handName;
        eval_.multiplier = validation.multiplier;
        room.evaluations.set(info.playerId, eval_);
      }
    }

    room.splitResponses.set(info.playerId, { group3 });

    // 所有人都分完了
    if (room.splitResponses.size === room.players.size) {
      resolveRound(room);
    }
  });

  // 自动分牌（使用最优方案）
  socket.on('auto_split', () => {
    const info = playerSockets.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomId);
    if (!room || room.phase !== PHASE.SPLIT_CARDS) return;

    room.splitResponses.set(info.playerId, { auto: true });

    if (room.splitResponses.size === room.players.size) {
      resolveRound(room);
    }
  });

  // 聊天
  socket.on('chat', ({ message }) => {
    const info = playerSockets.get(socket.id);
    if (!info) return;
    io.to(info.roomId).emit('chat_msg', {
      nickname: info.nickname,
      message,
      time: new Date().toLocaleTimeString()
    });
  });

  // 断开连接
  socket.on('disconnect', () => {
    const info = playerSockets.get(socket.id);
    if (!info) return;

    const room = rooms.get(info.roomId);
    if (room) {
      const player = room.players.get(info.playerId);
      if (player) {
        player.connected = false;
        io.to(room.id).emit('system_msg', { message: `${info.nickname} 断开了连接` });

        // 如果在游戏中逃跑
        if (room.phase !== PHASE.WAITING && room.phase !== PHASE.SHOW_RESULT) {
          player.escaped = true;
          // 扣除押金
          const penalty = room.baseAmount * 3;
          player.coins -= penalty;
          // 给其他玩家分
          const others = Array.from(room.players.entries()).filter(
            ([pid]) => pid !== info.playerId
          );
          const share = Math.floor(penalty / 2 / others.length);
          for (const [, op] of others) {
            op.coins += share;
          }
          io.to(room.id).emit('system_msg', {
            message: `${info.nickname} 逃跑了！扣除 ${penalty} 游戏币`
          });
        }

        // 如果在等待阶段直接移除
        if (room.phase === PHASE.WAITING) {
          room.players.delete(info.playerId);
        }

        broadcastRoomState(room);

        // 如果房间没人了就清理
        let allDisconnected = true;
        for (const [, p] of room.players) {
          if (p.connected) { allDisconnected = false; break; }
        }
        if (allDisconnected || room.players.size === 0) {
          clearTimers(room);
          rooms.delete(room.id);
          console.log(`房间 ${room.id} 已清理`);
        }
      }
    }

    playerSockets.delete(socket.id);
    console.log(`玩家断开: ${socket.id}`);
  });
});

// ======================== 启动服务器 ========================

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`\n🐂 斗牛游戏服务器已启动！`);
  console.log(`🌐 打开浏览器访问: http://localhost:${PORT}`);
  console.log(`👥 支持 2-6 人同时游戏\n`);
});
