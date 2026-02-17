/**
 * 斗牛(牛牛)游戏引擎
 * 包含所有游戏逻辑：发牌、牌型判断、比较大小、计算得分
 */

const SUITS = ['spade', 'heart', 'club', 'diamond']; // 黑桃、红桃、梅花、方片
const SUIT_NAMES = { spade: '♠', heart: '♥', club: '♣', diamond: '♦' };
const SUIT_RANK = { spade: 4, heart: 3, club: 2, diamond: 1 };
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const RANK_VALUE = {
  'A': 1, '2': 2, '3': 3, '4': 4, '5': 5,
  '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  'J': 10, 'Q': 10, 'K': 10
};
const RANK_COMPARE = {
  'A': 1, '2': 2, '3': 3, '4': 4, '5': 5,
  '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  'J': 11, 'Q': 12, 'K': 13
};

// 牌型等级
const HAND_TYPE = {
  NO_NIU: 0,       // 没牛
  NIU_1: 1,        // 牛丁
  NIU_2: 2,        // 牛二
  NIU_3: 3,        // 牛三
  NIU_4: 4,        // 牛四
  NIU_5: 5,        // 牛五
  NIU_6: 6,        // 牛六
  NIU_7: 7,        // 牛七
  NIU_8: 8,        // 牛八
  NIU_9: 9,        // 牛九
  NIU_NIU: 10,     // 牛牛
  FOUR_BOMB: 11,   // 四炸
  FIVE_FACE: 12,   // 五花牛
  FIVE_SMALL: 13   // 五小牛
};

const HAND_TYPE_NAMES = {
  0: '没牛', 1: '牛丁', 2: '牛二', 3: '牛三', 4: '牛四',
  5: '牛五', 6: '牛六', 7: '牛七', 8: '牛八', 9: '牛九',
  10: '牛牛', 11: '四炸', 12: '五花牛', 13: '五小牛'
};

// 牌型倍数
const HAND_MULTIPLIER = {
  0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1,
  8: 2, 9: 2, 10: 3, 11: 4, 12: 5, 13: 8
};

/**
 * 创建一副牌（52张，无大小王）
 */
function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, value: RANK_VALUE[rank] });
    }
  }
  return deck;
}

/**
 * Fisher-Yates 洗牌算法
 */
function shuffle(deck) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * 发牌：给 n 个玩家各发 5 张牌
 */
function dealCards(playerCount) {
  const deck = shuffle(createDeck());
  const hands = [];
  for (let i = 0; i < playerCount; i++) {
    hands.push(deck.slice(i * 5, i * 5 + 5));
  }
  return hands;
}

/**
 * 检查是否为五小牛：所有牌点数 < 5 且总和 <= 10
 */
function isFiveSmall(cards) {
  return cards.every(c => c.value < 5) && cards.reduce((s, c) => s + c.value, 0) <= 10;
}

/**
 * 检查是否为五花牛：所有牌为 J/Q/K
 */
function isFiveFace(cards) {
  return cards.every(c => ['J', 'Q', 'K'].includes(c.rank));
}

/**
 * 检查是否为四炸：4张相同点数
 */
function isFourBomb(cards) {
  const counts = {};
  for (const c of cards) {
    counts[c.rank] = (counts[c.rank] || 0) + 1;
  }
  return Object.values(counts).some(v => v === 4);
}

/**
 * 获取四炸中相同的那张牌的点数（用于比较）
 */
function getFourBombRank(cards) {
  const counts = {};
  for (const c of cards) {
    counts[c.rank] = (counts[c.rank] || 0) + 1;
  }
  for (const [rank, count] of Object.entries(counts)) {
    if (count === 4) return RANK_COMPARE[rank];
  }
  return 0;
}

/**
 * 找到最优的牛牌组合
 * 返回 { hasNiu, niuValue, group3, group2 }
 * group3: 能凑成10/20/30的3张牌索引
 * group2: 剩下2张牌的索引
 * niuValue: 剩下2张牌的点数和对10取模
 */
function findBestNiu(cards) {
  let bestResult = { hasNiu: false, niuValue: 0, group3: [], group2: [], handType: HAND_TYPE.NO_NIU };

  // 遍历所有 C(5,3) = 10 种组合
  for (let i = 0; i < 5; i++) {
    for (let j = i + 1; j < 5; j++) {
      for (let k = j + 1; k < 5; k++) {
        const sum3 = cards[i].value + cards[j].value + cards[k].value;
        if (sum3 % 10 === 0) {
          // 找到有牛的组合
          const group3 = [i, j, k];
          const group2 = [];
          for (let m = 0; m < 5; m++) {
            if (m !== i && m !== j && m !== k) group2.push(m);
          }
          const sum2 = cards[group2[0]].value + cards[group2[1]].value;
          const niuValue = sum2 % 10;
          const handType = niuValue === 0 ? HAND_TYPE.NIU_NIU : niuValue;

          if (handType > bestResult.handType) {
            bestResult = { hasNiu: true, niuValue, group3, group2, handType };
          }
        }
      }
    }
  }

  return bestResult;
}

/**
 * 评估一手牌，返回完整的牌型信息
 */
function evaluateHand(cards) {
  // 先检查特殊牌型（优先级从高到低）
  const fiveSmall = isFiveSmall(cards);
  const fiveFace = isFiveFace(cards);
  const fourBomb = isFourBomb(cards);

  // 五小牛最大
  if (fiveSmall) {
    return {
      handType: HAND_TYPE.FIVE_SMALL,
      handName: HAND_TYPE_NAMES[HAND_TYPE.FIVE_SMALL],
      multiplier: HAND_MULTIPLIER[HAND_TYPE.FIVE_SMALL],
      group3: [0, 1, 2],
      group2: [3, 4],
      cards
    };
  }

  // 五花牛次之（如果既是四炸又是五花牛，按大的算，但5张JQK不可能有4张相同，所以不冲突）
  if (fiveFace) {
    return {
      handType: HAND_TYPE.FIVE_FACE,
      handName: HAND_TYPE_NAMES[HAND_TYPE.FIVE_FACE],
      multiplier: HAND_MULTIPLIER[HAND_TYPE.FIVE_FACE],
      group3: [0, 1, 2],
      group2: [3, 4],
      cards
    };
  }

  // 四炸
  if (fourBomb) {
    return {
      handType: HAND_TYPE.FOUR_BOMB,
      handName: HAND_TYPE_NAMES[HAND_TYPE.FOUR_BOMB],
      multiplier: HAND_MULTIPLIER[HAND_TYPE.FOUR_BOMB],
      fourBombRank: getFourBombRank(cards),
      group3: [0, 1, 2],
      group2: [3, 4],
      cards
    };
  }

  // 普通牛牌型
  const niu = findBestNiu(cards);
  if (niu.hasNiu) {
    return {
      handType: niu.handType,
      handName: HAND_TYPE_NAMES[niu.handType],
      multiplier: HAND_MULTIPLIER[niu.handType],
      group3: niu.group3,
      group2: niu.group2,
      cards
    };
  }

  // 没牛
  return {
    handType: HAND_TYPE.NO_NIU,
    handName: HAND_TYPE_NAMES[HAND_TYPE.NO_NIU],
    multiplier: HAND_MULTIPLIER[HAND_TYPE.NO_NIU],
    group3: [],
    group2: [],
    cards
  };
}

/**
 * 获取手牌中最大的牌（用于比较）
 */
function getHighestCard(cards) {
  let highest = cards[0];
  for (let i = 1; i < cards.length; i++) {
    if (RANK_COMPARE[cards[i].rank] > RANK_COMPARE[highest.rank]) {
      highest = cards[i];
    } else if (RANK_COMPARE[cards[i].rank] === RANK_COMPARE[highest.rank]) {
      if (SUIT_RANK[cards[i].suit] > SUIT_RANK[highest.suit]) {
        highest = cards[i];
      }
    }
  }
  return highest;
}

/**
 * 比较两手牌的大小
 * 返回: 1 = hand1赢, -1 = hand2赢, 0 = 平局
 */
function compareHands(eval1, eval2) {
  // 不同牌型直接比较牌型大小
  if (eval1.handType !== eval2.handType) {
    return eval1.handType > eval2.handType ? 1 : -1;
  }

  // 相同牌型的特殊处理
  // 四炸：比较四张相同牌的大小
  if (eval1.handType === HAND_TYPE.FOUR_BOMB) {
    if (eval1.fourBombRank !== eval2.fourBombRank) {
      return eval1.fourBombRank > eval2.fourBombRank ? 1 : -1;
    }
    return 0;
  }

  // 五花牛或其他特殊牌型相同：比较最大牌
  if (eval1.handType === HAND_TYPE.FIVE_FACE || eval1.handType === HAND_TYPE.FIVE_SMALL) {
    const h1 = getHighestCard(eval1.cards);
    const h2 = getHighestCard(eval2.cards);
    if (RANK_COMPARE[h1.rank] !== RANK_COMPARE[h2.rank]) {
      return RANK_COMPARE[h1.rank] > RANK_COMPARE[h2.rank] ? 1 : -1;
    }
    return SUIT_RANK[h1.suit] > SUIT_RANK[h2.suit] ? 1 : -1;
  }

  // 都没牛：比较最大牌
  if (eval1.handType === HAND_TYPE.NO_NIU) {
    const h1 = getHighestCard(eval1.cards);
    const h2 = getHighestCard(eval2.cards);
    if (RANK_COMPARE[h1.rank] !== RANK_COMPARE[h2.rank]) {
      return RANK_COMPARE[h1.rank] > RANK_COMPARE[h2.rank] ? 1 : -1;
    }
    return SUIT_RANK[h1.suit] > SUIT_RANK[h2.suit] ? 1 : -1;
  }

  // 普通牛（牛丁到牛牛）且相同：比较最大牌
  const h1 = getHighestCard(eval1.cards);
  const h2 = getHighestCard(eval2.cards);
  if (RANK_COMPARE[h1.rank] !== RANK_COMPARE[h2.rank]) {
    return RANK_COMPARE[h1.rank] > RANK_COMPARE[h2.rank] ? 1 : -1;
  }
  return SUIT_RANK[h1.suit] > SUIT_RANK[h2.suit] ? 1 : -1;
}

/**
 * 玩家手动选择3张牌作为第一组
 * 检查选择是否有效（3张牌之和为10的倍数）
 * 返回 { valid, group3, group2, handType, handName }
 */
function validatePlayerSplit(cards, selectedIndices) {
  if (selectedIndices.length !== 3) return { valid: false, reason: '必须选择3张牌' };

  const group3 = selectedIndices.sort((a, b) => a - b);
  const group2 = [];
  for (let i = 0; i < 5; i++) {
    if (!group3.includes(i)) group2.push(i);
  }

  const sum3 = group3.reduce((s, idx) => s + cards[idx].value, 0);

  if (sum3 % 10 !== 0) {
    return { valid: false, reason: '这3张牌之和不是10的倍数，无法组成牛' };
  }

  const sum2 = group2.reduce((s, idx) => s + cards[idx].value, 0);
  const niuValue = sum2 % 10;
  const handType = niuValue === 0 ? HAND_TYPE.NIU_NIU : niuValue;

  return {
    valid: true,
    group3,
    group2,
    handType,
    handName: HAND_TYPE_NAMES[handType],
    multiplier: HAND_MULTIPLIER[handType]
  };
}

/**
 * 计算游戏结果
 * banker: { playerId, eval }
 * players: [{ playerId, eval, multiplier }]
 * baseAmount: 房间基数
 */
function calculateResults(bankerEval, players, baseAmount) {
  const results = [];

  for (const player of players) {
    const comparison = compareHands(player.eval, bankerEval);
    const winnerEval = comparison > 0 ? player.eval : bankerEval;
    const amount = baseAmount * player.multiplier * winnerEval.multiplier;
    const tax = Math.floor(amount * 0.05);

    if (comparison > 0) {
      // 闲家赢
      results.push({
        playerId: player.playerId,
        result: 'win',
        amount: amount - tax,
        bankerChange: -amount,
        handName: player.eval.handName
      });
    } else {
      // 庄家赢（包括平局情况，庄家优势）
      results.push({
        playerId: player.playerId,
        result: 'lose',
        amount: -amount,
        bankerChange: amount - tax,
        handName: player.eval.handName
      });
    }
  }

  return results;
}

module.exports = {
  SUITS, SUIT_NAMES, SUIT_RANK, RANKS, RANK_VALUE, RANK_COMPARE,
  HAND_TYPE, HAND_TYPE_NAMES, HAND_MULTIPLIER,
  createDeck, shuffle, dealCards,
  isFiveSmall, isFiveFace, isFourBomb,
  findBestNiu, evaluateHand, compareHands,
  validatePlayerSplit, calculateResults,
  getHighestCard
};
