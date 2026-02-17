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
const WIN_POINTS_REWARD = 10; // 赢一局奖励积分

/**
 * 游戏阶段
 */
const PHASE = {
  WAITING: 'waiting',           // 等待玩家加入
  GRAB_BANKER: 'grab_banker',   // 抢庄阶段
  CHOOSE_BET: 'choose_bet',     // 选下注对象阶段（替代原来的选倍数）
  DEAL_CARDS: 'deal_cards',     // 发牌/看牌阶段
  SPLIT_CARDS: 'split_cards',   // 分牌阶段
  SHOW_RESULT: 'show_result'    // 展示结果
};

function createRoom(roomId) {
  return {
    id: roomId,
    players: new Map(),          // playerId -> Player
    phase: PHASE.WAITING,
    banker: null,                // 庄家playerId
    grabBankerPlayers: [],       // 抢庄的玩家列表
    grabBankerResponses: new Map(), // playerId -> bool
    betResponses: new Map(),     // playerId -> [targetPlayerIds] 下注对象
    hands: new Map(),            // playerId -> [cards]
    evaluations: new Map(),      // playerId -> evaluation
    splitResponses: new Map(),   // playerId -> group3 indices
    results: null,
    roundCount: 0,
    baseAmount: ROOM_BASE,
    countdown: null,
    hasPlayedFirstRound: false,  // 是否已经完成过第一轮（用于自动准备）
    grabBankerStartTime: null,   // 抢庄阶段开始时间戳
    grabBankerTimeout: 10        // 抢庄倒计时秒数
  };
}

function createPlayer(id, nickname, socketId) {
  return {
    id,
    nickname,
    socketId,
    coins: BASE_COINS,
    points: 0,                   // 互动积分
    ready: false,
    betTargets: [],              // 下注对象列表
    escaped: false,
    connected: true
  };
}

function getRoomPlayerList(room) {
  const list = [];
  const playerIds = Array.from(room.players.keys());
  for (let i = 0; i < playerIds.length; i++) {
    const pid = playerIds[i];
    const p = room.players.get(pid);
    list.push({
      id: pid,
      nickname: p.nickname,
      coins: p.coins,
      points: p.points,
      ready: p.ready,
      isBanker: room.banker === pid,
      connected: p.connected,
      seatIndex: i + 1            // 座位号，从1开始
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
  room.grabBankerStartTime = Date.now();
  room.grabBankerTimeout = 10;

  broadcastRoomState(room);
  io.to(room.id).emit('phase_change', {
    phase: PHASE.GRAB_BANKER,
    message: '抢庄阶段 - 请选择是否抢庄',
    timeout: room.grabBankerTimeout
  });

  room.countdown = setTimeout(() => {
    for (const [pid] of room.players) {
      if (!room.grabBankerResponses.has(pid)) {
        room.grabBankerResponses.set(pid, false);
      }
    }
    resolveGrabBanker(room);
  }, room.grabBankerTimeout * 1000);
}

function resolveGrabBanker(room) {
  clearTimers(room);

  room.grabBankerPlayers = [];
  for (const [pid, grabbed] of room.grabBankerResponses) {
    if (grabbed) room.grabBankerPlayers.push(pid);
  }

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

  setTimeout(() => startChooseBetPhase(room), 2000);
}

/**
 * 选下注对象阶段（替代原来的选倍数）
 * 闲家可以选择下注自己、其他闲家（不含庄家）
 */
function startChooseBetPhase(room) {
  room.phase = PHASE.CHOOSE_BET;
  room.betResponses.clear();

  // 庄家自动完成（庄家不需要选择下注对象）
  room.betResponses.set(room.banker, []);

  // 构建可下注对象列表（所有闲家，包含自己）
  const betTargets = [];
  const playerIds = Array.from(room.players.keys());
  for (let i = 0; i < playerIds.length; i++) {
    const pid = playerIds[i];
    if (pid === room.banker) continue;
    const p = room.players.get(pid);
    betTargets.push({
      id: pid,
      nickname: p.nickname,
      seatIndex: i + 1
    });
  }

  broadcastRoomState(room);
  io.to(room.id).emit('phase_change', {
    phase: PHASE.CHOOSE_BET,
    message: '选择下注对象',
    timeout: 10,
    bankerId: room.banker,
    betTargets
  });

  room.countdown = setTimeout(() => {
    for (const [pid] of room.players) {
      if (pid !== room.banker && !room.betResponses.has(pid)) {
        // 超时默认下注自己
        room.betResponses.set(pid, [pid]);
        room.players.get(pid).betTargets = [pid];
      }
    }
    startDealPhase(room);
  }, 10000);
}

function startDealPhase(room) {
  clearTimers(room);
  room.phase = PHASE.DEAL_CARDS;

  const playerIds = Array.from(room.players.keys());
  const hands = gameEngine.dealCards(playerIds.length);
  room.hands.clear();
  playerIds.forEach((pid, idx) => {
    room.hands.set(pid, hands[idx]);
  });

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

  room.countdown = setTimeout(() => startSplitPhase(room), 3000);
}

function startSplitPhase(room) {
  clearTimers(room);
  room.phase = PHASE.SPLIT_CARDS;
  room.splitResponses.clear();

  broadcastRoomState(room);

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

/**
 * 结算逻辑：基于下注对象的新结算方式
 * 每个闲家可以下注多个闲家（含自己），每笔下注独立与庄家比较
 */
function resolveRound(room) {
  clearTimers(room);
  room.phase = PHASE.SHOW_RESULT;

  const bankerEval = room.evaluations.get(room.banker);
  let bankerTotal = 0;

  // 每个闲家的结算详情
  const playerResults = [];

  for (const [pid, p] of room.players) {
    if (pid === room.banker) continue;

    const betTargets = p.betTargets || [pid]; // 默认下注自己
    let totalChange = 0;
    const betDetails = [];

    for (const targetId of betTargets) {
      const targetEval = room.evaluations.get(targetId);
      if (!targetEval) continue;

      const comparison = gameEngine.compareHands(targetEval, bankerEval);
      const winnerEval = comparison > 0 ? targetEval : bankerEval;
      const amount = room.baseAmount * winnerEval.multiplier;
      const tax = Math.floor(amount * 0.05);

      const targetPlayer = room.players.get(targetId);
      if (comparison > 0) {
        // 该笔下注赢了
        const net = amount - tax;
        totalChange += net;
        bankerTotal -= amount;
        betDetails.push({
          targetId,
          targetNickname: targetPlayer ? targetPlayer.nickname : '?',
          targetHandName: targetEval.handName,
          result: 'win',
          amount: net
        });
      } else {
        // 该笔下注输了
        totalChange -= amount;
        bankerTotal += amount - tax;
        betDetails.push({
          targetId,
          targetNickname: targetPlayer ? targetPlayer.nickname : '?',
          targetHandName: targetEval.handName,
          result: 'lose',
          amount: -amount
        });
      }
    }

    p.coins += totalChange;

    // 积分奖励：总结算为正则赢，奖励10积分
    if (totalChange > 0) {
      p.points += WIN_POINTS_REWARD;
    }

    playerResults.push({
      id: pid,
      nickname: p.nickname,
      cards: room.hands.get(pid),
      eval: room.evaluations.get(pid),
      coinsChange: totalChange,
      coins: p.coins,
      points: p.points,
      betTargets: betTargets,
      betDetails,
      betCount: betTargets.length
    });
  }

  // 庄家积分：如果庄家总收益为正也奖励
  const bankerPlayer = room.players.get(room.banker);
  bankerPlayer.coins += bankerTotal;
  if (bankerTotal > 0) {
    bankerPlayer.points += WIN_POINTS_REWARD;
  }

  const resultData = {
    banker: {
      id: room.banker,
      nickname: bankerPlayer.nickname,
      cards: room.hands.get(room.banker),
      eval: bankerEval,
      coinsChange: bankerTotal,
      coins: bankerPlayer.coins,
      points: bankerPlayer.points
    },
    players: playerResults
  };

  room.results = resultData;
  io.to(room.id).emit('round_result', resultData);

  // 标记已完成首轮
  room.hasPlayedFirstRound = true;

  // 清理并准备下一轮
  setTimeout(() => {
    room.phase = PHASE.WAITING;
    room.banker = null;
    room.hands.clear();
    room.evaluations.clear();
    room.splitResponses.clear();
    room.betResponses.clear();

    // 重置下注对象
    for (const [, p] of room.players) {
      p.betTargets = [];
    }

    // 自动准备：如果已完成过第一轮，所有在线玩家自动进入准备状态
    if (room.hasPlayedFirstRound) {
      for (const [, p] of room.players) {
        if (p.connected) {
          p.ready = true;
        } else {
          p.ready = false;
        }
      }
      broadcastRoomState(room);

      // 检查是否可以自动开始
      if (checkAllReady(room)) {
        io.to(room.id).emit('system_msg', { message: '自动准备完成，下一轮即将开始！' });
        setTimeout(() => startGrabBankerPhase(room), 2000);
      }
    } else {
      for (const [, p] of room.players) {
        p.ready = false;
      }
      broadcastRoomState(room);
    }
  }, 8000);
}

function checkAllReady(room) {
  if (room.players.size < 2) return false;
  let connectedCount = 0;
  for (const [, p] of room.players) {
    if (p.connected) {
      connectedCount++;
      if (!p.ready) return false;
    }
  }
  return connectedCount >= 2;
}

// ======================== Socket.IO 事件处理 ========================

io.on('connection', (socket) => {
  console.log(`玩家连接: ${socket.id}`);

  // 加入房间（允许在等待阶段和抢庄阶段加入）
  socket.on('join_room', ({ roomId, nickname }) => {
    if (!roomId || !nickname) {
      socket.emit('error_msg', { message: '请输入房间号和昵称' });
      return;
    }

    if (playerSockets.has(socket.id)) {
      socket.emit('error_msg', { message: '你已经在一个房间中了' });
      return;
    }

    let room = rooms.get(roomId);
    if (!room) {
      room = createRoom(roomId);
      rooms.set(roomId, room);
    }

    // 允许在等待阶段和抢庄阶段加入
    const canJoin = (room.phase === PHASE.WAITING || room.phase === PHASE.GRAB_BANKER);
    if (!canJoin) {
      socket.emit('error_msg', { message: '游戏正在进行中，请等待下一轮抢庄时加入' });
      return;
    }

    if (room.players.size >= 6) {
      socket.emit('error_msg', { message: '房间已满（最多6人）' });
      return;
    }

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

    // 如果在抢庄阶段加入，同步状态给新玩家
    if (room.phase === PHASE.GRAB_BANKER) {
      // 新玩家自动设为已准备（因为游戏已经在进行）
      player.ready = true;

      broadcastRoomState(room);

      // 计算剩余倒计时，让新玩家的倒计时与其他玩家同步
      const elapsed = (Date.now() - room.grabBankerStartTime) / 1000;
      const remaining = Math.max(1, Math.ceil(room.grabBankerTimeout - elapsed));

      socket.emit('phase_change', {
        phase: PHASE.GRAB_BANKER,
        message: '抢庄阶段 - 请选择是否抢庄',
        timeout: remaining
      });
    } else {
      broadcastRoomState(room);
    }

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

    // 检查所有玩家（含新加入的）是否都回应了
    if (room.grabBankerResponses.size >= room.players.size) {
      resolveGrabBanker(room);
    }
  });

  // 选下注对象（替代原来的选倍数）
  socket.on('choose_bet', ({ targets }) => {
    const info = playerSockets.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomId);
    if (!room || room.phase !== PHASE.CHOOSE_BET) return;
    if (info.playerId === room.banker) return;

    // 验证下注对象合法性：必须是闲家ID
    const validTargets = [];
    for (const tid of targets) {
      if (room.players.has(tid) && tid !== room.banker) {
        validTargets.push(tid);
      }
    }

    if (validTargets.length === 0) {
      validTargets.push(info.playerId); // 默认下注自己
    }

    room.betResponses.set(info.playerId, validTargets);
    room.players.get(info.playerId).betTargets = validTargets;

    const player = room.players.get(info.playerId);
    const targetNames = validTargets.map(tid => {
      const tp = room.players.get(tid);
      return tp ? (tid === info.playerId ? '自己' : tp.nickname) : '?';
    });
    io.to(room.id).emit('system_msg', {
      message: `${player.nickname} 下注了 ${targetNames.join('、')}（${validTargets.length}注）`
    });

    // 所有闲家都选了
    const nonBankerCount = room.players.size - 1;
    const respondedCount = room.betResponses.size - 1;
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

    if (group3 && group3.length === 3) {
      const validation = gameEngine.validatePlayerSplit(cards, group3);
      if (validation.valid) {
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

    if (room.splitResponses.size === room.players.size) {
      resolveRound(room);
    }
  });

  // 自动分牌
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

  // 扔互动道具（鸡蛋/牛粪/鲜花）
  socket.on('throw_item', ({ targetId, itemType, count }) => {
    const info = playerSockets.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomId);
    if (!room) return;

    const player = room.players.get(info.playerId);
    if (!player) return;

    const validItems = ['egg', 'poop', 'flower'];
    if (!validItems.includes(itemType)) return;

    const throwCount = Math.min(Math.max(1, count || 1), 99);

    // 检查积分
    if (player.points < throwCount) {
      socket.emit('error_msg', { message: `积分不足！需要 ${throwCount} 积分，你只有 ${player.points} 积分` });
      return;
    }

    // 检查目标玩家存在
    if (!room.players.has(targetId)) return;

    // 扣除积分
    player.points -= throwCount;

    const targetPlayer = room.players.get(targetId);
    const itemNames = { egg: '鸡蛋', poop: '牛粪', flower: '鲜花' };
    const itemEmojis = { egg: '🥚', poop: '💩', flower: '🌹' };

    // 广播互动动画
    io.to(room.id).emit('throw_item_effect', {
      fromId: info.playerId,
      fromNickname: player.nickname,
      targetId,
      targetNickname: targetPlayer.nickname,
      itemType,
      itemEmoji: itemEmojis[itemType],
      count: throwCount
    });

    io.to(room.id).emit('system_msg', {
      message: `${player.nickname} 向 ${targetPlayer.nickname} 扔了 ${throwCount} 个${itemNames[itemType]} ${itemEmojis[itemType]}`
    });

    // 只发送积分更新，不触发完整的 room_state（避免牌面刷新）
    io.to(room.id).emit('points_update', {
      playerId: info.playerId,
      points: player.points
    });
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

        if (room.phase !== PHASE.WAITING && room.phase !== PHASE.SHOW_RESULT) {
          player.escaped = true;
          const penalty = room.baseAmount * 3;
          player.coins -= penalty;
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

        if (room.phase === PHASE.WAITING) {
          room.players.delete(info.playerId);
        }

        broadcastRoomState(room);

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
