/**
 * 斗牛游戏客户端
 * 处理所有 UI 交互和 Socket.IO 通信
 */

const SUIT_SYMBOLS = { spade: '♠', heart: '♥', club: '♣', diamond: '♦' };
const SUIT_COLOR = { spade: 'black', heart: 'red', club: 'black', diamond: 'red' };

// ======================== 状态 ========================

let socket = null;
let myId = null;
let myCards = [];
let selectedIndices = [];
let currentPhase = 'waiting';
let countdownTimer = null;
let isBanker = false;
let allPlayers = [];     // 完整玩家列表（含座位号）
let currentBankerId = null;

// ======================== DOM 元素 ========================

const $ = (id) => document.getElementById(id);

const loginScreen = $('login-screen');
const gameScreen = $('game-screen');
const nicknameInput = $('nickname-input');
const roomInput = $('room-input');
const joinBtn = $('join-btn');
const roomIdDisplay = $('room-id-display');
const roundDisplay = $('round-display');
const baseDisplay = $('base-display');
const phaseDisplay = $('phase-display');
const otherPlayers = $('other-players');
const actionPanel = $('action-panel');
const resultPanel = $('result-panel');
const myCardsDiv = $('my-cards');
const myHandType = $('my-hand-type');
const myName = $('my-name');
const myCoins = $('my-coins');
const myPoints = $('my-points');
const myCoinsTop = $('my-coins-top');
const myPointsTop = $('my-points-top');
const readyBtn = $('ready-btn');
const chatToggle = $('chat-toggle');
const chatPanel = $('chat-panel');
const chatMessages = $('chat-messages');
const chatInput = $('chat-input');
const chatSendBtn = $('chat-send-btn');
const systemMessages = $('system-messages');
const countdownContainer = $('countdown-container');
const countdownNumber = $('countdown-number');
const countdownProgress = $('countdown-progress');
const throwEffects = $('throw-effects');

// ======================== 初始化 ========================

function init() {
  socket = io();

  joinBtn.addEventListener('click', joinRoom);
  nicknameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  readyBtn.addEventListener('click', toggleReady);
  chatToggle.addEventListener('click', () => {
    chatPanel.style.display = chatPanel.style.display === 'none' ? 'flex' : 'none';
  });
  chatSendBtn.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

  setupSocketEvents();
}

function joinRoom() {
  const nickname = nicknameInput.value.trim();
  const roomId = roomInput.value.trim();
  if (!nickname) { showToast('请输入昵称'); return; }
  if (!roomId) { showToast('请输入房间号'); return; }

  socket.emit('join_room', { roomId, nickname });
}

// ======================== Socket 事件 ========================

function setupSocketEvents() {
  socket.on('joined', ({ playerId, roomId, nickname }) => {
    myId = playerId;
    loginScreen.classList.remove('active');
    gameScreen.classList.add('active');
    roomIdDisplay.textContent = roomId;
    myName.textContent = nickname;
    readyBtn.style.display = 'inline-block';
    showToast('成功加入房间');
  });

  socket.on('error_msg', ({ message }) => {
    showToast(message);
  });

  socket.on('room_state', (state) => {
    updateRoomState(state);
  });

  socket.on('phase_change', (data) => {
    handlePhaseChange(data);
  });

  socket.on('banker_decided', (data) => {
    showToast(data.message);
    currentBankerId = data.bankerId;
  });

  socket.on('round_result', (data) => {
    showResult(data);
  });

  socket.on('system_msg', ({ message }) => {
    showToast(message);
    addChatMessage(null, message, true);
  });

  socket.on('chat_msg', ({ nickname, message, time }) => {
    addChatMessage(nickname, message);
  });

  // 互动道具效果
  socket.on('throw_item_effect', (data) => {
    showThrowAnimation(data);
  });
}

// ======================== 更新界面 ========================

function updateRoomState(state) {
  currentPhase = state.phase;
  roundDisplay.textContent = state.roundCount;
  baseDisplay.textContent = state.baseAmount;
  allPlayers = state.players;
  currentBankerId = state.banker;

  const me = state.players.find(p => p.id === state.myId);
  if (me) {
    myCoins.textContent = me.coins;
    myPoints.textContent = me.points;
    myCoinsTop.textContent = me.coins;
    myPointsTop.textContent = me.points;
    isBanker = me.isBanker;
  }

  // 准备按钮
  if (state.phase === 'waiting') {
    readyBtn.style.display = 'inline-block';
    if (me && me.ready) {
      readyBtn.textContent = '取消准备';
      readyBtn.classList.add('is-ready');
    } else {
      readyBtn.textContent = '准备';
      readyBtn.classList.remove('is-ready');
    }
  } else {
    readyBtn.style.display = 'none';
  }

  // 其他玩家
  renderOtherPlayers(state.players.filter(p => p.id !== state.myId), state);

  // 手牌
  if (state.myCards && state.myCards.length > 0) {
    myCards = state.myCards;
    if (currentPhase === 'deal_cards' || currentPhase === 'split_cards') {
      renderMyCards(true);
    }
  }

  updatePhaseText(state.phase);
}

function updatePhaseText(phase) {
  const texts = {
    waiting: '等待玩家准备...',
    grab_banker: '抢庄阶段',
    choose_bet: '选择下注对象',
    deal_cards: '发牌中...',
    split_cards: '选牌组牛',
    show_result: '本轮结果'
  };
  phaseDisplay.textContent = texts[phase] || phase;
}

function renderOtherPlayers(players, state) {
  otherPlayers.innerHTML = '';
  for (const p of players) {
    const seat = document.createElement('div');
    seat.className = 'player-seat';
    seat.dataset.playerId = p.id;
    if (p.isBanker) seat.classList.add('is-banker');
    if (p.ready && state.phase === 'waiting') seat.classList.add('is-ready');
    if (!p.connected) seat.classList.add('disconnected');

    const initial = p.nickname.charAt(0).toUpperCase();
    seat.innerHTML = `
      <div class="player-avatar">
        ${initial}
        ${p.isBanker ? '<span class="banker-badge">庄</span>' : ''}
      </div>
      <div class="player-name">${escapeHtml(p.nickname)}</div>
      <div class="player-coins">💰 ${p.coins}</div>
      <div class="player-points-display">⭐ ${p.points}</div>
      ${state.phase === 'waiting'
        ? `<div class="player-status ${p.ready ? 'ready' : 'waiting'}">${p.ready ? '已准备' : '未准备'}</div>`
        : ''}
      ${!p.connected ? '<div class="player-status" style="color:#e74c3c;">已断开</div>' : ''}
      <div class="throw-btns">
        <button class="throw-btn" onclick="openThrowMenu('${p.id}','${escapeHtml(p.nickname)}')" title="互动">🎯</button>
      </div>
    `;

    otherPlayers.appendChild(seat);
  }
}

// ======================== 互动道具系统 ========================

function openThrowMenu(targetId, targetNickname) {
  const me = allPlayers.find(p => p.id === myId);
  const myPts = me ? me.points : 0;

  actionPanel.style.display = 'flex';
  actionPanel.innerHTML = `
    <div class="action-title">向 ${targetNickname} 扔道具</div>
    <div class="action-subtitle">当前积分：⭐ ${myPts}（1积分 = 1次）</div>
    <div class="throw-count-row">
      <label>数量：</label>
      <button class="btn btn-small throw-count-adj" onclick="adjustThrowCount(-1)">-</button>
      <span id="throw-count-val" class="throw-count-val">1</span>
      <button class="btn btn-small throw-count-adj" onclick="adjustThrowCount(1)">+</button>
      <button class="btn btn-small throw-count-adj" onclick="setThrowCount(5)">5</button>
      <button class="btn btn-small throw-count-adj" onclick="setThrowCount(10)">10</button>
    </div>
    <div class="action-buttons">
      <button class="btn btn-throw egg" onclick="doThrow('${targetId}','egg')">🥚 鸡蛋</button>
      <button class="btn btn-throw poop" onclick="doThrow('${targetId}','poop')">💩 牛粪</button>
      <button class="btn btn-throw flower" onclick="doThrow('${targetId}','flower')">🌹 鲜花</button>
    </div>
    <button class="btn btn-small" onclick="closeThrowMenu()" style="margin-top:8px;background:#555;">关闭</button>
  `;
}

function adjustThrowCount(delta) {
  const el = $('throw-count-val');
  let val = parseInt(el.textContent) + delta;
  if (val < 1) val = 1;
  if (val > 99) val = 99;
  el.textContent = val;
}

function setThrowCount(val) {
  $('throw-count-val').textContent = val;
}

function doThrow(targetId, itemType) {
  const count = parseInt($('throw-count-val').textContent) || 1;
  socket.emit('throw_item', { targetId, itemType, count });
  closeThrowMenu();
}

function closeThrowMenu() {
  // 只在不是游戏操作阶段时关闭
  if (currentPhase !== 'grab_banker' && currentPhase !== 'choose_bet' && currentPhase !== 'split_cards') {
    actionPanel.style.display = 'none';
  } else {
    // 恢复当前阶段的操作面板
    actionPanel.style.display = 'none';
  }
}

function showThrowAnimation(data) {
  const { itemEmoji, count, targetNickname, fromNickname } = data;
  const container = throwEffects;

  for (let i = 0; i < Math.min(count, 20); i++) {
    setTimeout(() => {
      const el = document.createElement('div');
      el.className = 'throw-emoji';
      el.textContent = itemEmoji;
      // 随机位置偏移
      el.style.left = (30 + Math.random() * 40) + '%';
      el.style.top = (20 + Math.random() * 40) + '%';
      el.style.animationDelay = (Math.random() * 0.2) + 's';
      container.appendChild(el);
      setTimeout(() => el.remove(), 1500);
    }, i * 80);
  }
}

// ======================== 手牌渲染 ========================

function renderMyCards(dealing = false) {
  myCardsDiv.innerHTML = '';
  selectedIndices = [];
  myHandType.textContent = '';

  for (let i = 0; i < myCards.length; i++) {
    const card = myCards[i];
    const el = createCardElement(card, i, dealing);

    if (currentPhase === 'split_cards') {
      el.addEventListener('click', () => toggleCardSelection(i, el));
    } else {
      el.classList.add('disabled');
    }

    myCardsDiv.appendChild(el);
  }

  if (currentPhase === 'split_cards') {
    updateSelectionUI();
  }
}

function createCardElement(card, index, dealing = false) {
  const el = document.createElement('div');
  const color = SUIT_COLOR[card.suit];
  el.className = `card ${color}${dealing ? ' dealing' : ''}`;
  el.dataset.index = index;

  const suitSymbol = SUIT_SYMBOLS[card.suit];
  el.innerHTML = `
    <span class="card-suit-top">${suitSymbol}</span>
    <span class="card-rank">${card.rank}</span>
    <span class="card-suit-center">${suitSymbol}</span>
    <span class="card-suit-bottom">${suitSymbol}</span>
  `;

  return el;
}

function toggleCardSelection(index, el) {
  if (selectedIndices.includes(index)) {
    selectedIndices = selectedIndices.filter(i => i !== index);
    el.classList.remove('selected');
  } else {
    if (selectedIndices.length >= 3) {
      showToast('最多选择3张牌');
      return;
    }
    selectedIndices.push(index);
    el.classList.add('selected');
  }
  updateSelectionUI();
}

function updateSelectionUI() {
  const count = selectedIndices.length;
  myHandType.textContent = `已选择 ${count}/3 张牌`;

  if (count === 3) {
    const sum = selectedIndices.reduce((s, idx) => {
      const card = myCards[idx];
      const val = ['J', 'Q', 'K'].includes(card.rank) ? 10 : (card.rank === 'A' ? 1 : parseInt(card.rank));
      return s + val;
    }, 0);

    if (sum % 10 === 0) {
      const remaining = [];
      for (let i = 0; i < 5; i++) {
        if (!selectedIndices.includes(i)) remaining.push(i);
      }
      const sum2 = remaining.reduce((s, idx) => {
        const card = myCards[idx];
        const val = ['J', 'Q', 'K'].includes(card.rank) ? 10 : (card.rank === 'A' ? 1 : parseInt(card.rank));
        return s + val;
      }, 0);
      const niuVal = sum2 % 10;
      const niuName = niuVal === 0 ? '牛牛' : `牛${['丁','二','三','四','五','六','七','八','九'][niuVal - 1]}`;
      myHandType.innerHTML = `<span style="color:#27ae60;">有牛！${niuName} ✓</span>`;
    } else {
      myHandType.innerHTML = `<span style="color:#e74c3c;">这3张牌之和(${sum})不是10的倍数</span>`;
    }
  }

  let splitActions = document.querySelector('.split-actions');
  if (!splitActions && currentPhase === 'split_cards') {
    splitActions = document.createElement('div');
    splitActions.className = 'split-actions';
    myCardsDiv.parentElement.appendChild(splitActions);
  }
  if (splitActions) {
    splitActions.innerHTML = '';
    if (currentPhase === 'split_cards') {
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'btn btn-confirm-split';
      confirmBtn.textContent = '确认分牌';
      confirmBtn.disabled = count !== 3;
      confirmBtn.style.opacity = count === 3 ? '1' : '0.5';
      confirmBtn.addEventListener('click', () => {
        if (selectedIndices.length === 3) {
          socket.emit('split_cards', { group3: [...selectedIndices] });
          confirmBtn.disabled = true;
          confirmBtn.textContent = '已提交';
          myHandType.textContent = '等待其他玩家...';
          document.querySelectorAll('.card').forEach(c => {
            c.classList.add('disabled');
            c.style.pointerEvents = 'none';
          });
        }
      });

      const autoBtn = document.createElement('button');
      autoBtn.className = 'btn btn-auto-split';
      autoBtn.textContent = '智能分牌';
      autoBtn.addEventListener('click', () => {
        socket.emit('auto_split');
        autoBtn.disabled = true;
        autoBtn.textContent = '已提交';
        myHandType.textContent = '已使用智能分牌，等待其他玩家...';
        document.querySelectorAll('.card').forEach(c => {
          c.classList.add('disabled');
          c.style.pointerEvents = 'none';
        });
      });

      splitActions.appendChild(confirmBtn);
      splitActions.appendChild(autoBtn);
    }
  }
}

// ======================== 阶段处理 ========================

function handlePhaseChange(data) {
  clearCountdown();
  actionPanel.style.display = 'none';
  resultPanel.style.display = 'none';

  switch (data.phase) {
    case 'grab_banker':
      showGrabBankerUI(data);
      startCountdown(data.timeout);
      break;

    case 'choose_bet':
      if (!isBanker) {
        showChooseBetUI(data);
      } else {
        showActionMessage('你是庄家', '等待闲家选择下注对象...');
      }
      startCountdown(data.timeout);
      break;

    case 'deal_cards':
      renderMyCards(true);
      break;

    case 'split_cards':
      renderMyCards(false);
      startCountdown(data.timeout);
      break;
  }
}

function showGrabBankerUI(data) {
  actionPanel.style.display = 'flex';
  actionPanel.innerHTML = `
    <div class="action-title">是否抢庄？</div>
    <div class="action-subtitle">抢庄的玩家中将随机选出一位庄家</div>
    <div class="action-buttons">
      <button class="btn btn-gold" onclick="grabBanker(true)">抢庄</button>
      <button class="btn btn-danger" onclick="grabBanker(false)">不抢</button>
    </div>
  `;
}

/**
 * 下注对象选择UI（替代原来的倍数选择）
 * 显示所有闲家供选择，可多选
 */
function showChooseBetUI(data) {
  const targets = data.betTargets || [];
  actionPanel.style.display = 'flex';

  let targetsHtml = '';
  for (const t of targets) {
    const isMe = t.id === myId;
    const label = isMe ? `${t.nickname}（自己）` : `${t.nickname}`;
    const checkedAttr = isMe ? 'checked' : '';
    targetsHtml += `
      <label class="bet-target-label">
        <input type="checkbox" class="bet-target-cb" value="${t.id}" ${checkedAttr}>
        <span class="bet-target-box">
          <span class="bet-target-seat">${t.seatIndex}号</span>
          <span class="bet-target-name">${escapeHtml(label)}</span>
        </span>
      </label>
    `;
  }

  actionPanel.innerHTML = `
    <div class="action-title">选择下注对象</div>
    <div class="action-subtitle">你下注的每个闲家都会独立和庄家比牌，盈亏累加结算</div>
    <div class="bet-targets-grid">${targetsHtml}</div>
    <button class="btn btn-gold" onclick="confirmBet()">确认下注</button>
  `;
}

function showActionMessage(title, subtitle) {
  actionPanel.style.display = 'flex';
  actionPanel.innerHTML = `
    <div class="action-title">${title}</div>
    <div class="action-subtitle">${subtitle}</div>
  `;
}

// ======================== 玩家操作 ========================

function grabBanker(grab) {
  socket.emit('grab_banker', { grab });
  actionPanel.innerHTML = `
    <div class="action-title">${grab ? '已抢庄' : '不抢庄'}</div>
    <div class="action-subtitle">等待其他玩家...</div>
  `;
}

function confirmBet() {
  const checkboxes = document.querySelectorAll('.bet-target-cb:checked');
  const targets = Array.from(checkboxes).map(cb => cb.value);

  if (targets.length === 0) {
    showToast('请至少选择一个下注对象');
    return;
  }

  socket.emit('choose_bet', { targets });

  const count = targets.length;
  actionPanel.innerHTML = `
    <div class="action-title">已下注 ${count} 个对象</div>
    <div class="action-subtitle">等待发牌...</div>
  `;
}

function toggleReady() {
  socket.emit('ready');
}

function sendChat() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  socket.emit('chat', { message: msg });
  chatInput.value = '';
}

// ======================== 结果展示 ========================

function showResult(data) {
  clearCountdown();
  actionPanel.style.display = 'none';
  resultPanel.style.display = 'block';
  resultPanel.classList.add('show');

  const splitActions = document.querySelector('.split-actions');
  if (splitActions) splitActions.remove();

  let html = '<div class="result-title">本轮结果</div>';

  // 庄家
  html += renderResultRow(data.banker, true, null);

  // 闲家
  for (const p of data.players) {
    html += renderResultRow(p, false, p.betDetails);
  }

  resultPanel.innerHTML = html;

  setTimeout(() => {
    resultPanel.style.display = 'none';
    resultPanel.classList.remove('show');
    myCardsDiv.innerHTML = '';
    myHandType.textContent = '';
    myCards = [];
    selectedIndices = [];
  }, 8000);
}

function renderResultRow(player, isBankerRow, betDetails) {
  const evalData = player.eval;
  const cards = player.cards || [];
  const change = player.coinsChange;
  const isWin = change > 0;
  const rowClass = isBankerRow ? 'is-banker' : (isWin ? 'win' : 'lose');

  let cardsHtml = '';
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const color = SUIT_COLOR[c.suit];
    const inGroup3 = evalData && evalData.group3 && evalData.group3.includes(i);
    cardsHtml += `
      <div class="result-card ${color}${inGroup3 ? ' in-group3' : ''}">
        <span>${c.rank}</span>
        <span>${SUIT_SYMBOLS[c.suit]}</span>
      </div>
    `;
  }

  const changeSign = change > 0 ? '+' : '';
  const changeClass = change > 0 ? 'positive' : 'negative';

  // 下注详情
  let betInfoHtml = '';
  if (!isBankerRow && betDetails && betDetails.length > 0) {
    const betSummary = betDetails.map(bd => {
      const icon = bd.result === 'win' ? '✅' : '❌';
      return `${icon}${bd.targetNickname}`;
    }).join(' ');
    betInfoHtml = `<div class="result-bet-details">${betSummary}</div>`;
  }

  let roleLabel = '';
  if (isBankerRow) {
    roleLabel = '庄家';
  } else {
    const betCount = player.betCount || 1;
    roleLabel = `闲家（${betCount}注）`;
  }

  return `
    <div class="result-row ${rowClass}">
      <div class="result-player-info">
        <span class="result-player-name">${escapeHtml(player.nickname)}</span>
        <span class="result-role-badge ${isBankerRow ? 'banker' : 'player'}">
          ${roleLabel}
        </span>
      </div>
      <div class="result-cards">${cardsHtml}</div>
      <div class="result-hand-type" style="color:${getHandTypeColor(evalData ? evalData.handType : 0)}">
        ${evalData ? evalData.handName : ''}
      </div>
      <div class="result-right">
        <div class="result-coins-change ${changeClass}">
          ${changeSign}${change}
        </div>
        ${betInfoHtml}
      </div>
    </div>
  `;
}

function getHandTypeColor(handType) {
  if (handType >= 11) return '#ffd700';
  if (handType >= 8) return '#e74c3c';
  if (handType >= 1) return '#27ae60';
  return '#95a5a6';
}

// ======================== 倒计时 ========================

function startCountdown(seconds) {
  clearCountdown();
  countdownContainer.style.display = 'block';
  let remaining = seconds;
  const total = seconds;
  const circumference = 2 * Math.PI * 45;

  countdownNumber.textContent = remaining;
  countdownProgress.style.strokeDasharray = circumference;
  countdownProgress.style.strokeDashoffset = 0;

  countdownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearCountdown();
      return;
    }
    countdownNumber.textContent = remaining;
    const offset = circumference * (1 - remaining / total);
    countdownProgress.style.strokeDashoffset = offset;

    if (remaining <= 3) {
      countdownProgress.style.stroke = '#e74c3c';
    }
  }, 1000);
}

function clearCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  countdownContainer.style.display = 'none';
  countdownProgress.style.stroke = '#ffd700';
}

// ======================== 工具函数 ========================

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'system-toast';
  toast.textContent = message;
  systemMessages.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function addChatMessage(sender, text, isSystem = false) {
  const div = document.createElement('div');
  div.className = `chat-msg${isSystem ? ' system' : ''}`;
  if (isSystem) {
    div.textContent = text;
  } else {
    div.innerHTML = `<span class="chat-sender">${escapeHtml(sender)}:</span> <span class="chat-text">${escapeHtml(text)}</span>`;
  }
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ======================== 启动 ========================
document.addEventListener('DOMContentLoaded', init);
