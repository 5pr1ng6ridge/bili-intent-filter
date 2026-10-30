// 日常用的小弹窗：开关、选模式（可多选）、调阈值、看统计。想看什么、关键词、Key 等具体内容只在设置页里出现。
import { BACKEND_LABELS, BUILD, loadSettings, saveActiveModes, saveModes } from './settings.js';

const $ = (id) => document.getElementById(id);
const openOptions = () => chrome.runtime.openOptionsPage();
$('openOptions').addEventListener('click', openOptions);

let s = await loadSettings();

function render() {
  document.body.classList.toggle('off', !s.enabled);
  $('enabled').checked = s.enabled;

  $('modes').replaceChildren(...s.modes.map((m) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = m.name;
    b.title = m.name;
    b.setAttribute('aria-pressed', String(s.activeModes.includes(m.id)));
    b.addEventListener('click', () => toggleMode(m.id));
    return b;
  }));

  const sel = s.selected;
  const only = sel.length === 1;
  const hasQuery = sel.some((m) => m.intent.trim() || m.exclude.trim());
  const which = only ? '这个模式' : '选中的模式';
  const hint = $('modeHint');
  if (!sel.length) {
    hint.replaceChildren('没有选用模式，只按内容类型过滤。');
  } else if (!hasQuery) {
    hint.replaceChildren(
      sel.some((m) => m.keywords.trim()) ? `${which}只按内容类型和关键词过滤，阈值不起作用。` : `${which}还没有填写想看的内容。`,
      Object.assign(document.createElement('a'), { textContent: '去设置', onclick: openOptions }),
    );
  } else if (!only) {
    hint.replaceChildren('符合任一模式就算相关，不想看的内容和关键词合并。');
  }
  hint.hidden = hasQuery && only;

  // 多个模式时实际阈值取最低；拖动后所选模式统一改成这个值
  $('thresholdLabel').textContent = sel.length > 1 ? `阈值（${sel.length} 个模式一起调）` : '阈值';
  $('threshold').disabled = !hasQuery;
  if (!sel.length) return ($('thresholdVal').textContent = '—');
  const threshold = Math.min(...sel.map((m) => m.threshold));
  $('threshold').value = threshold;
  $('thresholdVal').textContent = threshold.toFixed(2);
}

async function toggleMode(id) {
  const on = s.activeModes.includes(id);
  await saveActiveModes(s, on ? s.activeModes.filter((x) => x !== id) : [...s.activeModes, id]);
  s = await loadSettings();
  render();
}

$('enabled').addEventListener('change', async () => {
  s.enabled = $('enabled').checked;
  render();
  await chrome.storage.sync.set({ enabled: s.enabled });
});

// ---- 阈值：拖动时只让当前页面预览，松手再保存（sync 存储有写入频率限制） ----
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const toTab = (msg) => (tab?.id ? chrome.tabs.sendMessage(tab.id, msg).catch(() => null) : Promise.resolve(null));

$('threshold').addEventListener('input', () => {
  const v = Number($('threshold').value);
  $('thresholdVal').textContent = v.toFixed(2);
  toTab({ type: 'preview', threshold: v });
});
$('threshold').addEventListener('change', async () => {
  const v = Number($('threshold').value);
  for (const m of s.selected) m.threshold = v;
  await saveModes(s.selected);
});

// ---- 统计 ----
const SCOPE_LABELS = { history: '历史记录', favorites: '收藏夹' };

async function updatePage() {
  const isBili = tab?.url && /(^|\.)bilibili\.com$/.test(new URL(tab.url).hostname);
  if (!isBili) return ($('page').textContent = '当前标签页不是 B 站页面');
  const st = await toTab({ type: 'stats' });
  if (!st?.ok) return ($('page').textContent = '页面还没加载插件，刷新一下页面');
  if (!s.enabled) return ($('page').textContent = '已暂停');
  if (!st.active) return ($('page').textContent = `${SCOPE_LABELS[st.scope] || '这类'}页面未启用（可在设置中开启）`);
  const page = $('page');
  page.replaceChildren('本页 ', bold(st.total), ' 条，已模糊 ', bold(st.hidden), ' 条');
  if (st.ruled) page.append(`（规则 ${st.ruled}）`);
  if (st.pending) page.append(` · 打分中 ${st.pending}`);
  if (st.errors) page.append(` · 失败 ${st.errors}`);
}

async function updateUsage() {
  const el = $('usage');
  const label = BACKEND_LABELS[s.backend] || s.backend;
  if (s.backend === 'local') return (el.textContent = `${label}：本地计算，不消耗用量`);
  const r = await chrome.runtime.sendMessage({ type: 'usage' }).catch(() => null);
  if (!r?.ok) return (el.textContent = label);
  el.replaceChildren(`今天 ${label} 打分 `, bold(r.usage.scored), ' 条，缓存命中 ', bold(r.usage.hits), ' 条');
}

function bold(n) {
  return Object.assign(document.createElement('b'), { textContent: String(n) });
}

// 后台脚本是旧版本时（改了代码但没在扩展页刷新），设置不会生效
chrome.runtime.sendMessage({ type: 'ping' }).then((r) => r?.build === BUILD, () => false).then((fresh) => {
  if (fresh) return;
  $('warn').hidden = false;
  $('warn').textContent = '插件后台还在运行旧版本代码。请到扩展管理页点本插件的“刷新”按钮，再刷新 B 站页面。';
});

render();
updatePage();
updateUsage();
setInterval(updatePage, 1000);
chrome.storage.onChanged.addListener(async (_c, area) => {
  if (area !== 'sync') return;
  s = await loadSettings();
  render();
  updateUsage();
});
