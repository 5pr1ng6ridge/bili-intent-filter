// 代码版本。弹窗每次打开都从磁盘读最新文件，后台脚本却要在扩展页点“刷新”才会更新；
// 弹窗拿自己的 BUILD 和后台的比对，不一致就提示用户刷新扩展。改了 background/scorers 记得加一。
export const BUILD = 5;

export const BACKEND_LABELS = { local: '内置基线', jev: 'Jev', http: '自定义接口' };

// 内容类型，与 rules.js 里的识别结果对应
export const CONTENT_TYPES = [
  { id: 'video', label: '视频' },
  { id: 'live', label: '直播' },
  { id: 'course', label: '课程', hint: '课堂、付费课程' },
  { id: 'bangumi', label: '番剧影视', hint: '番剧、国创、电影、纪录片等' },
  { id: 'ad', label: '广告', hint: '推广视频和商品' },
  { id: 'other', label: '其他', hint: '漫画、专栏等' },
];
export const TYPE_ACTIONS = { score: '模型打分', zero: '直接 0 分', pass: '不处理' };
export const DEFAULT_TYPE_RULES = {
  video: 'score', live: 'score', course: 'score', bangumi: 'score', ad: 'zero', other: 'pass',
};

// 默认生效于首页、搜索、视频页等；这两类“自己的”页面可单独开关
export const SCOPES = [
  { id: 'history', label: '历史记录' },
  { id: 'favorites', label: '收藏夹与稍后再看' },
];

// 普通设置存 chrome.storage.sync（随浏览器账号同步），API Key 存 chrome.storage.local（只留在本机）。
// 每个模式单独存一个 key（mode_<id>），避免单个 key 超过 sync 的 8KB 上限。
// 可以同时使用多个模式（activeModes）：想看的内容各自打分取最高，不想看和屏蔽关键词合并，阈值取最低。
// 也可以一个都不用，这时只按内容类型过滤。
export const DEFAULT_SETTINGS = {
  enabled: true,
  activeModes: [],
  modeOrder: [],
  useTags: true,       // 拉取视频标签一起交给模型
  typeRules: DEFAULT_TYPE_RULES,
  scopes: { history: false, favorites: false },
  backend: 'local',    // 'local' 内置基线 | 'jev' TypeSafe Jev | 'http' 自定义接口
  endpoint: 'http://127.0.0.1:8765/score',
  jevEndpoint: 'https://api.typesafe.ai/v1/systemone',
  jevModel: 'jev-latest',
  showBadge: true,
  rev: 0,              // 模型相关配置变化时加一，通知页面全部重新打分
};

export const DEFAULT_MODE = {
  name: '新模式',
  intent: '',          // 想看什么
  exclude: '',         // 不想看什么（交给模型判断）
  keywords: '',        // 屏蔽关键词，命中直接 0 分，不调用模型
  threshold: 0.3,
};

export const DEFAULT_SECRETS = {
  apiKey: '',          // 自定义接口的 Key（可选）
  jevApiKey: '',
};

// jev 的几个接入方式，接口字段相同，只是地址和模型名不同
export const JEV_PRESETS = {
  typesafe: { label: 'TypeSafe 官方', endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' },
  openrouter: { label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/systemone', model: '~typesafe/jev-latest' },
};

export const modeKey = (id) => `mode_${id}`;
export const newModeId = () => `m${Date.now().toString(36)}`;

// 0.3 及以前只有一组 intent/exclude/threshold，迁移成名为“默认”的模式；
// 0.4 只能选一个模式（activeMode），换成列表 activeModes
export async function migrate() {
  const all = await chrome.storage.sync.get(null);
  if (!Array.isArray(all.modeOrder) || !all.modeOrder.length) {
    const mode = {
      ...DEFAULT_MODE,
      name: '默认',
      intent: all.intent || '',
      exclude: all.exclude || '',
      threshold: typeof all.threshold === 'number' ? all.threshold : DEFAULT_MODE.threshold,
    };
    await chrome.storage.sync.set({ modeOrder: ['default'], activeModes: ['default'], [modeKey('default')]: mode });
    await chrome.storage.sync.remove(['intent', 'exclude', 'threshold', 'activeMode']);
  } else if (!Array.isArray(all.activeModes)) {
    const id = all.modeOrder.includes(all.activeMode) ? all.activeMode : all.modeOrder[0];
    await chrome.storage.sync.set({ activeModes: [id] });
    await chrome.storage.sync.remove('activeMode');
  }
}

export async function loadSettings() {
  await migrate();
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(null),
    chrome.storage.local.get(DEFAULT_SECRETS),
  ]);
  const s = { ...DEFAULT_SETTINGS, ...sync, ...local };
  s.typeRules = { ...DEFAULT_TYPE_RULES, ...sync.typeRules };
  s.scopes = { ...DEFAULT_SETTINGS.scopes, ...sync.scopes };
  s.modes = s.modeOrder
    .filter((id) => sync[modeKey(id)])
    .map((id) => ({ ...DEFAULT_MODE, ...sync[modeKey(id)], id }));
  s.activeModes = s.modes.map((m) => m.id).filter((id) => s.activeModes.includes(id));
  s.selected = s.modes.filter((m) => s.activeModes.includes(m.id)); // 按模式顺序
  return s;
}

// 一次写入多个模式（sync 存储有写入频率限制）
export async function saveModes(modes) {
  await chrome.storage.sync.set(Object.fromEntries(modes.map(({ id, ...data }) => [modeKey(id), data])));
}
export const saveMode = (mode) => saveModes([mode]);

// 按模式顺序保存正在使用的模式
export async function saveActiveModes(s, ids) {
  await chrome.storage.sync.set({ activeModes: s.modes.map((m) => m.id).filter((id) => ids.includes(id)) });
}

export async function bumpRev() {
  const { rev } = await chrome.storage.sync.get({ rev: 0 });
  await chrome.storage.sync.set({ rev: rev + 1 });
}
