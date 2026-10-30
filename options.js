import {
  BACKEND_LABELS, BUILD, CONTENT_TYPES, DEFAULT_MODE, DEFAULT_SETTINGS, JEV_PRESETS, SCOPES, TYPE_ACTIONS,
  loadSettings, modeKey, newModeId, saveActiveModes, saveMode,
} from './settings.js';

const $ = (id) => document.getElementById(id);

let toastTimer = null;
function toast(text, kind = '') {
  const t = $('toast');
  t.textContent = text;
  t.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = kind), kind === 'error' ? 4000 : 1200);
}

// 所有写入都走这里：失败（比如超过 sync 的单项 8KB 上限）时提示出来
async function save(fn, okText = '已保存') {
  try {
    await fn();
    toast(okText);
  } catch (err) {
    toast(`保存失败：${err?.message || err}`, 'error');
  }
}

// 正在输入的框不被外部变化覆盖
function setValue(el, v) {
  if (document.activeElement !== el) el.value = v;
}

let s = await loadSettings();
// 正在编辑的模式，不一定在使用中（可能一个都没在用）
const firstMode = () => s.activeModes[0] ?? s.modes[0]?.id;
let editing = firstMode();
const editingMode = () => s.modes.find((m) => m.id === editing) || s.modes[0];

// ---- 模式 ----
function renderModes() {
  if (!s.modes.some((m) => m.id === editing)) editing = firstMode();
  const tabs = s.modes.map((m) => {
    const b = document.createElement('button');
    const on = s.activeModes.includes(m.id);
    b.type = 'button';
    b.role = 'tab';
    b.textContent = m.name;
    b.title = on ? `${m.name}（使用中）` : m.name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(m.id === editing));
    b.addEventListener('click', () => {
      editing = m.id;
      renderModes();
    });
    return b;
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'add';
  add.textContent = '＋ 新建';
  add.addEventListener('click', () => addMode());
  $('modeTabs').replaceChildren(...tabs, add);

  const m = editingMode();
  const switched = $('modeName').dataset.mode !== m.id;
  $('modeName').dataset.mode = m.id;
  // 切换到另一个模式时全部重填；同一个模式只更新没在输入的框
  const set = switched ? (el, v) => (el.value = v) : setValue;
  set($('modeName'), m.name);
  set($('intent'), m.intent);
  set($('exclude'), m.exclude);
  set($('keywords'), m.keywords);
  set($('threshold'), m.threshold);
  $('thresholdVal').textContent = Number($('threshold').value).toFixed(2);
  $('modeActive').checked = s.activeModes.includes(m.id);
  $('delMode').disabled = s.modes.length <= 1;
}

$('modeActive').addEventListener('change', () => {
  const on = $('modeActive').checked;
  const ids = on ? [...s.activeModes, editing] : s.activeModes.filter((id) => id !== editing);
  save(() => saveActiveModes(s, ids), on ? '已启用' : '已停用');
});

function bindModeField(id, read = (el) => el.value.trim()) {
  $(id).addEventListener('change', () => {
    const m = editingMode();
    m[id === 'modeName' ? 'name' : id] = read($(id));
    save(() => saveMode(m));
  });
}
bindModeField('modeName', (el) => el.value.trim() || '未命名');
// 想看/不想看在离开输入框时才保存：边打字边存会让页面按半截的意图反复调用模型
bindModeField('intent');
bindModeField('exclude');
bindModeField('keywords');
bindModeField('threshold', (el) => Number(el.value));
$('threshold').addEventListener('input', () => ($('thresholdVal').textContent = Number($('threshold').value).toFixed(2)));

async function addMode(base) {
  const id = newModeId();
  const { id: _old, ...data } = base || { ...DEFAULT_MODE, name: `模式 ${s.modes.length + 1}` };
  if (base) data.name = `${base.name.slice(0, 17)} 副本`;
  await save(() => chrome.storage.sync.set({ [modeKey(id)]: data, modeOrder: [...s.modes.map((m) => m.id), id] }), '已新建');
  editing = id;
  s = await loadSettings();
  renderModes();
  $('modeName').focus();
  $('modeName').select();
}

$('dupMode').addEventListener('click', () => addMode(editingMode()));

$('delMode').addEventListener('click', async () => {
  const m = editingMode();
  if (s.modes.length <= 1) return;
  if (!confirm(`删除模式“${m.name}”？`)) return;
  const order = s.modes.map((x) => x.id).filter((id) => id !== m.id);
  const active = s.activeModes.filter((id) => id !== m.id);
  await save(async () => {
    await chrome.storage.sync.set({ modeOrder: order, activeModes: active });
    await chrome.storage.sync.remove(modeKey(m.id));
  }, '已删除');
  editing = active[0] ?? order[0];
});

// ---- 内容类型、生效页面、显示 ----
function buildTypes() {
  $('types').replaceChildren(...CONTENT_TYPES.map((t) => {
    const row = document.createElement('div');
    row.className = 'type';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = t.label;
    if (t.hint) name.append(Object.assign(document.createElement('small'), { textContent: t.hint }));
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.role = 'radiogroup';
    seg.ariaLabel = t.label;
    // 视频是主体内容，全部 0 分没有意义
    const actions = Object.entries(TYPE_ACTIONS).filter(([a]) => !(t.id === 'video' && a === 'zero'));
    for (const [action, label] of actions) {
      const l = document.createElement('label');
      const input = Object.assign(document.createElement('input'), { type: 'radio', name: `type-${t.id}`, value: action });
      input.addEventListener('change', () => save(() => chrome.storage.sync.set({ typeRules: { ...s.typeRules, [t.id]: action } })));
      l.append(input, label);
      seg.append(l);
    }
    row.append(name, seg);
    return row;
  }));

  $('scopes').replaceChildren(...SCOPES.map((sc) => {
    const l = document.createElement('label');
    l.className = 'check';
    const input = Object.assign(document.createElement('input'), { type: 'checkbox', id: `scope-${sc.id}` });
    input.addEventListener('change', () => save(() => chrome.storage.sync.set({ scopes: { ...s.scopes, [sc.id]: input.checked } })));
    l.append(input, `也在“${sc.label}”页面过滤`);
    return l;
  }));
}

function renderTypes() {
  for (const input of $('types').querySelectorAll('input')) {
    input.checked = s.typeRules[input.name.slice('type-'.length)] === input.value;
  }
  for (const sc of SCOPES) $(`scope-${sc.id}`).checked = Boolean(s.scopes[sc.id]);
  $('showBadge').checked = s.showBadge;
  $('useTags').checked = s.useTags;
}
$('showBadge').addEventListener('change', () => save(() => chrome.storage.sync.set({ showBadge: $('showBadge').checked })));
// 页面和后台缓存都按这个开关区分，切换后会重新打分
$('useTags').addEventListener('change', () => save(() => chrome.storage.sync.set({ useTags: $('useTags').checked })));

// ---- 决策模型 ----
for (const [id, p] of Object.entries(JEV_PRESETS)) $('jevPreset').add(new Option(p.label, id));
$('jevPreset').add(new Option('自定义（兼容 System One 的其他网关）', 'custom'));

function matchPreset() {
  const hit = Object.entries(JEV_PRESETS).find(([, p]) => p.endpoint === $('jevEndpoint').value.trim());
  $('jevPreset').value = hit ? hit[0] : 'custom';
}

function syncBackendBoxes() {
  $('jevBox').hidden = $('backend').value !== 'jev';
  $('httpBox').hidden = $('backend').value !== 'http';
}

function renderBackend() {
  for (const id of ['backend', 'endpoint', 'apiKey', 'jevEndpoint', 'jevApiKey', 'jevModel']) setValue($(id), s[id]);
  matchPreset();
  syncBackendBoxes();
}

function readForm() {
  return {
    backend: $('backend').value,
    endpoint: $('endpoint').value.trim(),
    apiKey: $('apiKey').value.trim(),
    jevEndpoint: $('jevEndpoint').value.trim() || DEFAULT_SETTINGS.jevEndpoint,
    jevApiKey: $('jevApiKey').value.trim(),
    jevModel: $('jevModel').value.trim() || DEFAULT_SETTINGS.jevModel,
  };
}

function originOf(f) {
  const url = f.backend === 'jev' ? f.jevEndpoint : f.backend === 'http' ? f.endpoint : null;
  if (!url) return '';
  try {
    return `${new URL(url).origin}/*`;
  } catch {
    return null;
  }
}

// 模型相关设置变了：保存并让 rev 加一，页面会重新打分（打过的分在缓存里，不会重复调用）
async function saveBackend() {
  const f = readForm();
  const origin = originOf(f);
  if (origin === null) return toast('接口地址格式不对', 'error');
  await save(async () => {
    const { rev = 0 } = await chrome.storage.sync.get('rev');
    await chrome.storage.local.set({ apiKey: f.apiKey, jevApiKey: f.jevApiKey });
    await chrome.storage.sync.set({
      backend: f.backend, endpoint: f.endpoint, jevEndpoint: f.jevEndpoint, jevModel: f.jevModel, rev: rev + 1,
    });
  });
  if (origin && !(await chrome.permissions.contains({ origins: [origin] }))) {
    status('这个接口地址还没有授权，点“测试连接”完成授权，否则打分会失败。', 'error');
  }
}

$('backend').addEventListener('change', () => {
  syncBackendBoxes();
  saveBackend();
});
$('jevPreset').addEventListener('change', () => {
  const p = JEV_PRESETS[$('jevPreset').value];
  if (!p) return;
  $('jevEndpoint').value = p.endpoint;
  $('jevModel').value = p.model;
  saveBackend();
});
$('jevEndpoint').addEventListener('input', matchPreset);
for (const id of ['endpoint', 'apiKey', 'jevEndpoint', 'jevApiKey', 'jevModel']) $(id).addEventListener('change', saveBackend);

for (const btn of document.querySelectorAll('[data-toggle]')) {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.toggle);
    input.type = input.type === 'password' ? 'text' : 'password';
    btn.textContent = input.type === 'password' ? '显示' : '隐藏';
  });
}

function status(text, kind = '') {
  $('testStatus').textContent = text;
  $('testStatus').className = kind;
}

// 用表单里的值给两个示例标题打分，确认地址、Key、模型都能用。走后台脚本，和页面打分是同一条路径。
$('test').addEventListener('click', async () => {
  const f = readForm();
  const origin = originOf(f);
  if (origin === null) return status('接口地址格式不对', 'error');
  if (f.backend === 'jev' && !f.jevApiKey) return status('请先填写 jev 的 API Key', 'error');
  // permissions.request 必须在点击事件里同步发起，不能先 await 别的
  const perm = origin ? chrome.permissions.request({ origins: [origin] }) : Promise.resolve(true);
  if (!(await perm)) return status('没有拿到访问接口地址的权限', 'error');

  const m = editingMode();
  const query = m.intent || m.exclude
    ? { intents: m.intent ? [m.intent] : [], exclude: m.exclude }
    : { intents: ['Rust 编程入门'], exclude: '' };
  const samples = [
    { id: 'match', kind: 'video', title: '【Rust入门】从零开始写一个命令行工具', up: '示例UP主', sub: '', duration: '18:20' },
    { id: 'other', kind: 'video', title: '今天吃什么？一周晚饭不重样', up: '示例UP主', sub: '', duration: '08:45' },
  ];
  status('测试中…');
  const t0 = performance.now();
  const resp = await chrome.runtime.sendMessage({ type: 'test', settings: f, query, items: samples }).catch(() => null);
  if (!resp) return status('失败：后台没有响应，可能还是旧版本，请到扩展管理页刷新插件', 'error');
  if (!resp.ok) return status(`失败：${resp.error}`, 'error');
  const ms = Math.round(performance.now() - t0);
  const lines = samples.map((it) => `${resp.scores[it.id] ?? '无分数'}  ${it.title}`);
  const using = query.intents.length ? `想看“${query.intents[0]}”` : `不想看“${query.exclude}”`;
  status(`${BACKEND_LABELS[resp.backend] || resp.backend} 连接正常（${ms} ms），${using}：\n${lines.join('\n')}`, 'ok');
});

// ---- 用量与缓存 ----
async function renderUsage() {
  const el = $('usageText');
  const r = await chrome.runtime.sendMessage({ type: 'usage' }).catch(() => null);
  if (!r?.ok) return (el.textContent = '读取失败');
  const { usage: u, cache: c } = r;
  const b = (n) => Object.assign(document.createElement('b'), { textContent: String(n) });
  el.replaceChildren(
    '今天：模型请求 ', b(u.requests), ' 次，打分 ', b(u.scored), ' 条，缓存命中 ', b(u.hits), ' 条。',
    document.createElement('br'),
    '本机缓存 ', b(c.entries), ' 条分数（', b(c.buckets), ' 组），', b(c.tags ?? 0), ' 个视频的标签。',
  );
}

$('clearCache').addEventListener('click', async () => {
  if (!confirm('清除所有已缓存的分数和视频标签？之后看到的内容会重新调用模型打分。')) return;
  const r = await chrome.runtime.sendMessage({ type: 'clear-cache' }).catch(() => null);
  if (r?.ok) toast('缓存已清除');
  else toast('清除失败', 'error');
  renderUsage();
});

// ---- 启动 ----
chrome.runtime.sendMessage({ type: 'ping' }).then((r) => r?.build === BUILD, () => false).then((fresh) => {
  if (fresh) return;
  $('warn').hidden = false;
  $('warn').textContent = '插件后台还在运行旧版本代码，设置不会生效。请到扩展管理页点本插件的“刷新”按钮，再刷新 B 站页面。';
});

buildTypes();
renderModes();
renderTypes();
renderBackend();
renderUsage();
setInterval(renderUsage, 5000);

// 弹窗或其他设置页改了设置
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && !('apiKey' in changes || 'jevApiKey' in changes)) return;
  s = await loadSettings();
  renderModes();
  renderTypes();
  renderBackend();
});

// 关掉页面前把还没离开的输入框存掉
window.addEventListener('pagehide', () => {
  const el = document.activeElement;
  if (el && ['modeName', 'intent', 'exclude', 'keywords'].includes(el.id)) el.dispatchEvent(new Event('change'));
});
