// Every user-visible string, in both languages. The server only ever sends
// keys and parameters, so two players in one game can read different languages.

export const LANGS = { en: 'English', zh: '中文' };

const STRINGS = {
  en: {
    'app.title': 'Avalon',
    'app.tagline': 'The Resistance: Avalon — play with 5 to 10 friends',

    'home.create': 'Create a room',
    'home.join': 'Join a room',
    'home.name': 'Your name',
    'home.namePlaceholder': 'e.g. Arthur',
    'home.code': 'Room code',
    'home.codePlaceholder': 'ABCD',
    'home.go': 'Enter',
    'home.rulesLink': 'How to play',

    'lobby.title': 'Lobby',
    'lobby.code': 'Room code',
    'lobby.copy': 'Copy link',
    'lobby.copied': 'Link copied',
    'lobby.players': 'Players ({n})',
    'lobby.host': 'host',
    'lobby.you': 'you',
    'lobby.roles': 'Optional roles',
    'lobby.start': 'Start game',
    'lobby.leave': 'Leave',
    'lobby.waitingHost': 'Waiting for the host to start…',
    'lobby.needMore': 'Need at least {min} players ({n} so far)',
    'lobby.hostOnlyRoles': 'Only the host can change these.',
    'lobby.share': 'Share this code so others can join.',

    'role.merlin': 'Merlin',
    'role.percival': 'Percival',
    'role.servant': 'Loyal Servant of Arthur',
    'role.assassin': 'Assassin',
    'role.morgana': 'Morgana',
    'role.mordred': 'Mordred',
    'role.oberon': 'Oberon',
    'role.minion': 'Minion of Mordred',

    'roleDesc.merlin': 'You know who is evil — but Mordred is hidden from you. Guide good without revealing yourself: if the Assassin names you at the end, evil wins.',
    'roleDesc.percival': 'You see two players, one of whom is Merlin and the other Morgana. You do not know which is which.',
    'roleDesc.servant': 'You know nothing. Vote well, watch the quests, and protect Merlin.',
    'roleDesc.assassin': 'You know your fellow evil. If good completes three quests, you get one shot at naming Merlin — name him and evil wins anyway.',
    'roleDesc.morgana': 'You appear to Percival as Merlin does. Sow doubt.',
    'roleDesc.mordred': 'Merlin cannot see you. You are evil that walks in daylight.',
    'roleDesc.oberon': 'You are evil, but you do not know the other evil players, and they do not know you.',
    'roleDesc.minion': 'You know your fellow evil. Fail quests without being caught.',

    'side.good': 'Good',
    'side.evil': 'Evil',

    'know.evil': 'evil',
    'know.merlinOrMorgana': 'Merlin or Morgana',
    'know.title': 'What you know',
    'know.nothing': 'You know nothing about the other players.',

    'board.title': 'Quests',
    'board.quest': 'Quest {n}',
    'board.players': '{n} players',
    'board.twoFails': 'needs 2 fails',
    'board.rejects': 'Rejected proposals: {n}/{max}',
    'board.rejectWarn': 'One more rejection and evil wins.',
    'board.evilCount': '{n} evil among {total}',

    'phase.reveal': 'Look at your role',
    'phase.team': 'Team proposal',
    'phase.vote': 'Vote on the team',
    'phase.quest': 'The quest',
    'phase.assassin': 'The Assassin strikes',
    'phase.over': 'Game over',

    'reveal.confirm': 'I have seen my role',
    'reveal.waiting': 'Waiting for: {names}',
    'reveal.hide': 'Hide',
    'reveal.show': 'Show my role',

    'team.yourTurn': 'You are the leader. Choose {n} players for quest {round}.',
    'team.theirTurn': '{name} is the leader and is choosing {n} players for quest {round}.',
    'team.submit': 'Propose team',
    'team.selected': 'Selected {n}/{max}',

    'vote.prompt': 'Do you approve this team?',
    'vote.approve': 'Approve',
    'vote.reject': 'Reject',
    'vote.cast': 'Your vote is in. Waiting for: {names}',
    'vote.team': 'Proposed team: {names}',
    'vote.result': 'Vote {n}: {yes} approve, {no} reject — {outcome}',
    'vote.approved': 'approved',
    'vote.rejected': 'rejected',

    'quest.prompt': 'You are on the quest. Play a card.',
    'quest.success': 'Success',
    'quest.fail': 'Fail',
    'quest.goodCannotFail': 'Good players must play Success.',
    'quest.played': 'Card played. Waiting for: {names}',
    'quest.watching': 'Quest {round} is under way: {names}',
    'quest.needsTwo': 'This quest needs 2 fail cards to fail.',

    'assassin.you': 'Good has won three quests. Name Merlin to steal the game.',
    'assassin.other': 'The Assassin is choosing a target…',
    'assassin.kill': 'Assassinate {name}',

    'over.goodWins': 'Good wins!',
    'over.evilWins': 'Evil wins!',
    'win.hammer': 'Five team proposals were rejected in a row.',
    'win.threeFails': 'Three quests failed.',
    'win.threeSuccesses': 'Three quests succeeded and the Assassin missed Merlin.',
    'win.merlinSlain': 'The Assassin found Merlin.',
    'over.roles': 'Everyone’s role',
    'over.assassinPicked': 'The Assassin chose {name}.',
    'over.again': 'Play again',

    'log.title': 'History',
    'log.joined': '{name} joined',
    'log.left': '{name} left',
    'log.gameStarted': 'Game started with {count} players',
    'log.leaderTurn': '{name} leads and must pick {size}',
    'log.teamProposed': '{name} proposed {members}',
    'log.voteApproved': 'Team approved ({yes}–{no})',
    'log.voteRejected': 'Team rejected ({yes}–{no})',
    'log.questSucceeded': 'Quest {round} succeeded ({fails} fail cards)',
    'log.questFailed': 'Quest {round} failed ({fails} fail cards)',
    'log.assassinTurn': 'The Assassin must name Merlin',
    'log.assassinHit': 'The Assassin named {name} — Merlin!',
    'log.assassinMiss': 'The Assassin named {name} — not Merlin',
    'log.gameOver': 'Game over',
    'log.newGame': 'Back to the lobby',

    'err.noSuchRoom': 'No room with that code.',
    'err.roomFull': 'That room is full ({max} players).',
    'err.nameRequired': 'Please enter a name.',
    'err.nameTaken': 'Someone in the room already uses that name.',
    'err.gameAlreadyStarted': 'That game has already started.',
    'err.hostOnly': 'Only the host can do that.',
    'err.needMorePlayers': 'You need at least {min} players.',
    'err.badPlayerCount': 'Avalon needs {min} to {max} players.',
    'err.tooManyGoodRoles': 'Too many special good roles for this player count (max {max}).',
    'err.tooManyEvilRoles': 'Too many special evil roles for this player count (max {max}).',
    'err.wrongPhase': 'You cannot do that right now.',
    'err.notLeader': 'You are not the leader.',
    'err.wrongTeamSize': 'The team must have exactly {size} players.',
    'err.alreadyVoted': 'You have already voted.',
    'err.notOnTeam': 'You are not on this quest.',
    'err.alreadyPlayed': 'You have already played a card.',
    'err.goodMustSucceed': 'Good players cannot fail a quest.',
    'err.assassinOnly': 'Only the Assassin can do that.',
    'err.targetMustBeGood': 'That player is not on the good side.',
    'err.notInGame': 'You are not in this game.',
    'err.unknownMember': 'Unknown player.',
    'err.duplicateMember': 'A player cannot be on the team twice.',
    'err.cannotLeaveMidGame': 'You cannot leave once the game has started.',
    'err.gameInProgress': 'The game is still in progress.',
    'err.unknownAction': 'Unknown action.',
    'err.badRequest': 'The server could not read that request.',
    'err.payloadTooLarge': 'That request was too large.',
    'err.serverError': 'Something went wrong on the server.',
    'err.network': 'Cannot reach the server. Retrying…',

    'conn.lost': 'Connection lost — reconnecting…',
    'conn.ok': 'Connected',

    'rules.title': 'How to play',
    'rules.body': `Avalon is a hidden-role game for 5–10 players. Most players are loyal servants of Arthur (good); the rest are minions of Mordred (evil), and they know each other.

Five quests are attempted. Each round the leader proposes a team; everyone votes to approve or reject it. Five rejections in a row and evil wins outright. If a team is approved, its members secretly play Success or Fail — good must play Success, evil may play either. One Fail card sinks the quest (two are needed on the fourth quest in games of 7 or more).

Evil wins by failing three quests. If good succeeds three times, the Assassin gets one guess at who Merlin is: guess right and evil still wins.`,
  },

  zh: {
    'app.title': '阿瓦隆',
    'app.tagline': '抵抗组织：阿瓦隆 —— 5 至 10 人同乐',

    'home.create': '创建房间',
    'home.join': '加入房间',
    'home.name': '你的昵称',
    'home.namePlaceholder': '例如：亚瑟',
    'home.code': '房间号',
    'home.codePlaceholder': 'ABCD',
    'home.go': '进入',
    'home.rulesLink': '玩法说明',

    'lobby.title': '等待室',
    'lobby.code': '房间号',
    'lobby.copy': '复制链接',
    'lobby.copied': '链接已复制',
    'lobby.players': '玩家（{n} 人）',
    'lobby.host': '房主',
    'lobby.you': '你',
    'lobby.roles': '可选角色',
    'lobby.start': '开始游戏',
    'lobby.leave': '离开',
    'lobby.waitingHost': '等待房主开始游戏……',
    'lobby.needMore': '至少需要 {min} 名玩家（当前 {n} 人）',
    'lobby.hostOnlyRoles': '只有房主可以修改。',
    'lobby.share': '把房间号发给朋友即可加入。',

    'role.merlin': '梅林',
    'role.percival': '派西维尔',
    'role.servant': '亚瑟的忠臣',
    'role.assassin': '刺客',
    'role.morgana': '莫甘娜',
    'role.mordred': '莫德雷德',
    'role.oberon': '奥伯伦',
    'role.minion': '莫德雷德的爪牙',

    'roleDesc.merlin': '你知道谁是坏人 —— 但莫德雷德对你隐身。暗中引导好人，又不能暴露自己：终局若被刺客指认，好人功亏一篑。',
    'roleDesc.percival': '你看到两名玩家，其中一人是梅林，另一人是莫甘娜，但你分不清谁是谁。',
    'roleDesc.servant': '你什么都不知道。谨慎投票，观察任务，保护梅林。',
    'roleDesc.assassin': '你认识所有同伴。若好人完成三次任务，你有一次机会指认梅林 —— 猜中则坏人依然获胜。',
    'roleDesc.morgana': '在派西维尔眼中，你与梅林毫无分别。制造混乱吧。',
    'roleDesc.mordred': '梅林看不见你。你是行走在阳光下的邪恶。',
    'roleDesc.oberon': '你属于坏人阵营，但你不认识其他坏人，他们也不认识你。',
    'roleDesc.minion': '你认识所有同伴。让任务失败，但别被抓住。',

    'side.good': '好人',
    'side.evil': '坏人',

    'know.evil': '坏人',
    'know.merlinOrMorgana': '梅林或莫甘娜',
    'know.title': '你所知道的',
    'know.nothing': '你对其他玩家一无所知。',

    'board.title': '任务进程',
    'board.quest': '第 {n} 轮',
    'board.players': '{n} 人',
    'board.twoFails': '需 2 张失败',
    'board.rejects': '连续否决：{n}/{max}',
    'board.rejectWarn': '再被否决一次，坏人直接获胜。',
    'board.evilCount': '{total} 人中有 {n} 名坏人',

    'phase.reveal': '查看身份',
    'phase.team': '组队',
    'phase.vote': '投票表决',
    'phase.quest': '执行任务',
    'phase.assassin': '刺客出手',
    'phase.over': '游戏结束',

    'reveal.confirm': '我已看过身份',
    'reveal.waiting': '等待：{names}',
    'reveal.hide': '隐藏',
    'reveal.show': '查看我的身份',

    'team.yourTurn': '你是队长，请为第 {round} 轮任务挑选 {n} 名玩家。',
    'team.theirTurn': '{name} 是队长，正在为第 {round} 轮任务挑选 {n} 名玩家。',
    'team.submit': '提交队伍',
    'team.selected': '已选 {n}/{max}',

    'vote.prompt': '你是否赞成这支队伍？',
    'vote.approve': '赞成',
    'vote.reject': '反对',
    'vote.cast': '你已投票。等待：{names}',
    'vote.team': '提名队伍：{names}',
    'vote.result': '第 {n} 次表决：{yes} 赞成，{no} 反对 —— {outcome}',
    'vote.approved': '通过',
    'vote.rejected': '否决',

    'quest.prompt': '你在任务队伍中，请出牌。',
    'quest.success': '成功',
    'quest.fail': '失败',
    'quest.goodCannotFail': '好人只能出「成功」。',
    'quest.played': '你已出牌。等待：{names}',
    'quest.watching': '第 {round} 轮任务进行中：{names}',
    'quest.needsTwo': '本轮任务需要 2 张失败牌才会失败。',

    'assassin.you': '好人已完成三次任务。指认梅林即可逆转战局。',
    'assassin.other': '刺客正在选择目标……',
    'assassin.kill': '刺杀 {name}',

    'over.goodWins': '好人获胜！',
    'over.evilWins': '坏人获胜！',
    'win.hammer': '队伍连续五次被否决。',
    'win.threeFails': '三次任务失败。',
    'win.threeSuccesses': '三次任务成功，且刺客未能找出梅林。',
    'win.merlinSlain': '刺客找到了梅林。',
    'over.roles': '全部身份',
    'over.assassinPicked': '刺客选择了 {name}。',
    'over.again': '再来一局',

    'log.title': '战报',
    'log.joined': '{name} 加入了房间',
    'log.left': '{name} 离开了房间',
    'log.gameStarted': '游戏开始，共 {count} 人',
    'log.leaderTurn': '{name} 担任队长，需挑选 {size} 人',
    'log.teamProposed': '{name} 提名了 {members}',
    'log.voteApproved': '队伍通过（{yes}–{no}）',
    'log.voteRejected': '队伍被否决（{yes}–{no}）',
    'log.questSucceeded': '第 {round} 轮任务成功（{fails} 张失败牌）',
    'log.questFailed': '第 {round} 轮任务失败（{fails} 张失败牌）',
    'log.assassinTurn': '刺客需要指认梅林',
    'log.assassinHit': '刺客指认了 {name} —— 正是梅林！',
    'log.assassinMiss': '刺客指认了 {name} —— 并非梅林',
    'log.gameOver': '游戏结束',
    'log.newGame': '返回等待室',

    'err.noSuchRoom': '找不到该房间号。',
    'err.roomFull': '房间已满（最多 {max} 人）。',
    'err.nameRequired': '请输入昵称。',
    'err.nameTaken': '房间里已有人使用该昵称。',
    'err.gameAlreadyStarted': '游戏已经开始了。',
    'err.hostOnly': '只有房主可以执行此操作。',
    'err.needMorePlayers': '至少需要 {min} 名玩家。',
    'err.badPlayerCount': '阿瓦隆需要 {min} 至 {max} 名玩家。',
    'err.tooManyGoodRoles': '当前人数下好人特殊角色过多（最多 {max} 个）。',
    'err.tooManyEvilRoles': '当前人数下坏人特殊角色过多（最多 {max} 个）。',
    'err.wrongPhase': '现在还不能这么做。',
    'err.notLeader': '你不是队长。',
    'err.wrongTeamSize': '队伍必须正好 {size} 人。',
    'err.alreadyVoted': '你已经投过票了。',
    'err.notOnTeam': '你不在本轮任务队伍中。',
    'err.alreadyPlayed': '你已经出过牌了。',
    'err.goodMustSucceed': '好人不能让任务失败。',
    'err.assassinOnly': '只有刺客可以执行此操作。',
    'err.targetMustBeGood': '该玩家不属于好人阵营。',
    'err.notInGame': '你不在这局游戏里。',
    'err.unknownMember': '未知玩家。',
    'err.duplicateMember': '同一名玩家不能重复入队。',
    'err.cannotLeaveMidGame': '游戏开始后不能离开。',
    'err.gameInProgress': '本局游戏尚未结束。',
    'err.unknownAction': '未知操作。',
    'err.badRequest': '服务器无法解析该请求。',
    'err.payloadTooLarge': '请求内容过大。',
    'err.serverError': '服务器出错了。',
    'err.network': '无法连接服务器，正在重试……',

    'conn.lost': '连接中断，正在重连……',
    'conn.ok': '已连接',

    'rules.title': '玩法说明',
    'rules.body': `阿瓦隆是一款 5–10 人的身份隐藏游戏。多数玩家是亚瑟的忠臣（好人阵营），其余是莫德雷德的爪牙（坏人阵营），坏人彼此认识。

全场共进行五轮任务。每轮由队长提名队伍，全体投票赞成或反对；若连续五次被否决，坏人直接获胜。队伍通过后，队员秘密出牌：好人只能出「成功」，坏人两者皆可。只要出现一张「失败」牌，任务即告失败（7 人以上的第四轮任务需要两张）。

坏人只要让三轮任务失败即获胜；若好人成功三轮，刺客有一次机会指认梅林，猜中则坏人反败为胜。`,
  },
};

const FALLBACK = 'en';

export function t(lang, key, params = {}) {
  const table = STRINGS[lang] ?? STRINGS[FALLBACK];
  const raw = table[key] ?? STRINGS[FALLBACK][key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

export function detectLang() {
  const saved = localStorage.getItem('avalon.lang');
  if (saved && saved in STRINGS) return saved;
  return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** Keys present in one language but not the other — the tests assert this is empty. */
export function missingKeys() {
  const langs = Object.keys(STRINGS);
  const all = new Set(langs.flatMap((l) => Object.keys(STRINGS[l])));
  const gaps = [];
  for (const lang of langs) {
    for (const key of all) if (!(key in STRINGS[lang])) gaps.push(`${lang}:${key}`);
  }
  return gaps.sort();
}

export { STRINGS };
