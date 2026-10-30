import { BUILD, loadSettings, migrate } from './settings.js';
import { SCORER_VERSION, combineParts, scoreLocal, scoreHttp, scoreJev } from './scorers.js';

chrome.runtime.onInstalled.addListener(async () => {
  await migrate();
  await pruneCache();
});

// ---- 设置：内存里留一份，存储变了再重读 ----
let settingsPromise = null;
const getSettings = () => (settingsPromise ??= loadSettings());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' || 'apiKey' in changes || 'jevApiKey' in changes) settingsPromise = null;
});

function backendKey(s) {
  if (s.backend === 'http') return `http|${s.endpoint}`;
  if (s.backend === 'jev') return `jev|${s.jevEndpoint}|${s.jevModel}`;
  return s.backend;
}

// jobs: [{ item, parts }]，返回 values[i][k]，见 scorers.js
function runParts(s, jobs) {
  switch (s.backend) {
    case 'http':
      return scoreHttp(jobs, s.endpoint, s.apiKey);
    case 'jev':
      return scoreJev(jobs, { endpoint: s.jevEndpoint, model: s.jevModel, apiKey: s.jevApiKey });
    case 'local':
      return scoreLocal(jobs);
    default:
      // 不认识的后端直接报错，不悄悄退回关键词匹配
      throw new Error(`未知的决策模型“${s.backend}”，请在扩展页刷新插件`);
  }
}

// 每个“想看”一项相关度，所有“不想看”（页面已经合并好）一项
function queryParts(intents, exclude) {
  const parts = [...new Set(intents.filter(Boolean))].map((text) => ({ type: 'rel', text }));
  if (exclude) parts.push({ type: 'exc', text: exclude });
  return parts;
}

// ---- 视频标签 ----
// 从 B 站公开接口拉标签（不带 Cookie），按 BV 号缓存。只给需要交给模型的视频拉，缓存命中的不拉。
const TAG_API = 'https://api.bilibili.com/x/web-interface/view/detail/tag?bvid=';
const TAG_CACHE_KEY = 'tagCache';
const TAG_CACHE_LIMIT = 8000;
const TAG_MAX = 12;
const TAG_CONCURRENCY = 6;
const TAG_TIMEOUT = 4000;
const TAG_PAUSE = 5 * 60 * 1000; // 被 B 站拦截后暂停这么久，期间只用卡片上的信息打分
const BV_ID = /^BV[0-9A-Za-z]{10}$/;

let tagCache = null;  // Promise<Map<bvid, string[]>>，Map 顺序即最近使用顺序
let tagsDirty = false;
let tagPausedUntil = 0;
const tagPending = new Map(); // bvid -> Promise，多个标签页同时要同一个视频时只拉一次

const loadTags = () => (tagCache ??= chrome.storage.local.get(TAG_CACHE_KEY)
  .then((r) => new Map(Object.entries(r[TAG_CACHE_KEY] || {}))));

// 返回标签列表；网络问题或被拦截返回 undefined（不缓存，下次再试）
async function fetchTags(bvid) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TAG_TIMEOUT);
  try {
    const res = await fetch(TAG_API + bvid, { credentials: 'omit', signal: ctrl.signal });
    const data = res.ok ? await res.json() : null;
    if (res.status === 412 || res.status === 429 || data?.code === -412 || data?.code === -352) {
      tagPausedUntil = Date.now() + TAG_PAUSE;
      return undefined;
    }
    if (!data) return undefined;
    if (data.code !== 0) return []; // 视频不存在、不可见等，记成没有标签
    const seen = new Set();
    const tags = [];
    for (const t of data.data || []) {
      const name = String(t?.tag_name || '').trim();
      // topic 是活动话题（“××计划”之类），和内容关系不大
      if (!name || t.tag_type === 'topic' || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      tags.push(name);
      if (tags.length >= TAG_MAX) break;
    }
    return tags;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function getTags(bvid) {
  if (!tagPending.has(bvid)) {
    tagPending.set(bvid, fetchTags(bvid).then(async (tags) => {
      if (!tags) return;
      const cache = await loadTags();
      cache.delete(bvid);
      cache.set(bvid, tags);
      if (cache.size > TAG_CACHE_LIMIT) cache.delete(cache.keys().next().value);
      tagsDirty = true;
      scheduleFlush();
    }).finally(() => tagPending.delete(bvid)));
  }
  return tagPending.get(bvid);
}

// 给视频条目补上 tags 字段（拉取失败的就不补）
async function attachTags(items) {
  const videos = items.filter((it) => it.kind === 'video' && BV_ID.test(it.id));
  if (!videos.length) return;
  const cache = await loadTags();
  const missing = [...new Set(videos.map((it) => it.id))].filter((id) => !cache.has(id));
  let next = 0;
  const worker = async () => {
    while (next < missing.length && Date.now() >= tagPausedUntil) await getTags(missing[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(TAG_CONCURRENCY, missing.length) }, worker));
  for (const it of videos) {
    const tags = cache.get(it.id);
    if (!tags) continue;
    cache.delete(it.id); // 只调整内存里的顺序，不为此写存储
    cache.set(it.id, tags);
    it.tags = tags;
  }
}

// 已知的标签一起返回给页面，显示在角标提示里
async function knownTags(items) {
  const cache = await loadTags();
  const out = {};
  for (const it of items) if (cache.has(it.id)) out[it.id] = cache.get(it.id);
  return out;
}

// ---- 持久缓存 ----
// 每个分项（后端配置 + 打分版本 + 是否用标签 + 某个“想看”或合并后的“不想看”）一个桶，存在 storage.local 的
// cache_<hash> 里。多选模式时各个“想看”分别缓存，换着组合也能复用；关键词、类型规则、阈值都在页面里处理，
// 改了不影响缓存。
const BUCKET_LIMIT = 4000; // 每桶最多条目
const BUCKETS_LIMIT = 30;  // 最多保留几个桶
const FLUSH_DELAY = 2000;
const INDEX_KEY = 'cacheIndex'; // { [hash]: { t: 最近使用时间, n: 条目数, v: 打分版本 } }

const buckets = new Map(); // hash -> Promise<{ hash, scores: Map, pending: Map, dirty }>
let flushTimer = null;

async function bucketHash(s, part) {
  const raw = JSON.stringify([backendKey(s), SCORER_VERSION, s.useTags ? 1 : 0, part.type, part.text]);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(buf).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function getBucket(hash) {
  if (!buckets.has(hash)) {
    // 同一个桶并发加载只读一次存储
    buckets.set(hash, chrome.storage.local.get(`cache_${hash}`).then((r) => ({
      hash,
      scores: new Map(Object.entries(r[`cache_${hash}`] || {})),
      pending: new Map(), // id -> 正在打分的 Promise，避免多个标签页重复请求
      dirty: true,        // 刷新使用时间
    })));
  }
  return buckets.get(hash);
}

function remember(bucket, id, v) {
  bucket.scores.delete(id); // 重新插入，Map 顺序即最近使用顺序
  bucket.scores.set(id, v);
  if (bucket.scores.size > BUCKET_LIMIT) bucket.scores.delete(bucket.scores.keys().next().value);
  bucket.dirty = true;
}

function scheduleFlush() {
  flushTimer ??= setTimeout(flush, FLUSH_DELAY);
}

async function flush() {
  flushTimer = null;
  const { [INDEX_KEY]: index = {} } = await chrome.storage.local.get(INDEX_KEY);
  const writes = {};
  for (const p of buckets.values()) {
    const b = await p;
    if (!b.dirty) continue;
    b.dirty = false;
    writes[`cache_${b.hash}`] = Object.fromEntries(b.scores);
    index[b.hash] = { t: Date.now(), n: b.scores.size, v: SCORER_VERSION };
  }
  const stale = Object.keys(index)
    .sort((a, b) => index[b].t - index[a].t)
    .slice(BUCKETS_LIMIT);
  for (const h of stale) {
    delete index[h];
    delete writes[`cache_${h}`];
    buckets.delete(h);
  }
  writes[INDEX_KEY] = index;
  writes.usage = usage;
  if (tagsDirty) {
    tagsDirty = false;
    writes[TAG_CACHE_KEY] = Object.fromEntries(await tagCache);
  }
  await chrome.storage.local.set(writes);
  if (stale.length) await chrome.storage.local.remove(stale.map((h) => `cache_${h}`));
}

// 安装、更新时删掉旧打分版本留下的桶（它们的 key 再也不会被算出来）
async function pruneCache() {
  const { [INDEX_KEY]: index = {} } = await chrome.storage.local.get(INDEX_KEY);
  const old = Object.keys(index).filter((h) => index[h].v !== SCORER_VERSION);
  if (!old.length) return;
  for (const h of old) delete index[h];
  await chrome.storage.local.set({ [INDEX_KEY]: index });
  await chrome.storage.local.remove(old.map((h) => `cache_${h}`));
}

async function clearCache() {
  const { [INDEX_KEY]: index = {} } = await chrome.storage.local.get(INDEX_KEY);
  buckets.clear();
  tagCache = null;
  tagsDirty = false;
  await chrome.storage.local.remove([INDEX_KEY, TAG_CACHE_KEY, ...Object.keys(index).map((h) => `cache_${h}`)]);
}

async function cacheStats() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    await flush();
  }
  const { [INDEX_KEY]: index = {} } = await chrome.storage.local.get(INDEX_KEY);
  const list = Object.values(index);
  return { buckets: list.length, entries: list.reduce((n, x) => n + x.n, 0), tags: (await loadTags()).size };
}

// ---- 当天用量 ----
// requests：实际发出的模型请求数（jev 每条一次，自定义接口每个分项每批一次）；scored：交给模型的条目；hits：缓存命中
const today = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD，本地时区
let usage = { day: today(), requests: 0, scored: 0, hits: 0 };
const usageLoaded = chrome.storage.local.get('usage').then((r) => {
  if (r.usage?.day === usage.day) usage = r.usage;
});

function countUsage(field, n) {
  if (usage.day !== today()) usage = { day: today(), requests: 0, scored: 0, hits: 0 };
  usage[field] += n;
}

// ---- 打分 ----
// 返回 { scores, backend, tags }，backend 用来在角标上标明分数来源。
// 想看/不想看由页面传过来（页面知道自己用了哪些模式），后端配置读已保存的设置。
async function score({ items, intents = [], exclude = '' }) {
  const s = await getSettings();
  const parts = queryParts(intents, exclude);
  if (!parts.length) return { scores: {}, backend: s.backend };
  // 内置基线算得比读缓存还快，不缓存
  if (s.backend === 'local') {
    if (s.useTags) await attachTags(items);
    const values = await scoreLocal(items.map((item) => ({ item, parts })));
    const scores = Object.fromEntries(items.map((it, i) => [it.id, combineParts(parts, values[i])]));
    return { scores, backend: s.backend, tags: s.useTags ? await knownTags(items) : {} };
  }

  await usageLoaded;
  const bks = await Promise.all(parts.map(async (p) => getBucket(await bucketHash(s, p))));
  const values = new Map(items.map((it) => [it.id, parts.map(() => undefined)]));
  const waits = [];
  const jobMap = new Map(); // id -> { item, parts, slots }，slots 是对应的分项下标
  // 以下到设置 pending 为止不能有 await，否则别的请求会看不到这里要打的分
  parts.forEach((p, k) => {
    const b = bks[k];
    for (const item of items) {
      if (b.scores.has(item.id)) {
        const v = b.scores.get(item.id);
        remember(b, item.id, v);
        values.get(item.id)[k] = v;
      } else if (b.pending.has(item.id)) {
        waits.push(b.pending.get(item.id).then((v) => { values.get(item.id)[k] = v; }));
      } else {
        if (!jobMap.has(item.id)) jobMap.set(item.id, { item, parts: [], slots: [] });
        jobMap.get(item.id).parts.push(p);
        jobMap.get(item.id).slots.push(k);
      }
    }
  });
  const jobs = [...jobMap.values()];
  countUsage('hits', items.length - jobs.length);

  if (jobs.length) {
    const run = (async () => {
      if (s.useTags) await attachTags(jobs.map((j) => j.item));
      return runParts(s, jobs);
    })();
    jobs.forEach((j, ji) => j.slots.forEach((k, n) => {
      bks[k].pending.set(j.item.id, run.then((v) => v[ji][n], () => undefined));
    }));
    countUsage('scored', jobs.length);
    countUsage('requests', s.backend === 'jev' ? jobs.length : new Set(jobs.flatMap((j) => j.slots)).size);
    try {
      const fresh = await run;
      jobs.forEach((j, ji) => j.slots.forEach((k, n) => {
        const v = fresh[ji][n];
        if (v === undefined) return; // 没给分的不缓存，页面按“未知”处理
        values.get(j.item.id)[k] = v;
        remember(bks[k], j.item.id, v);
      }));
    } finally {
      for (const j of jobs) for (const k of j.slots) bks[k].pending.delete(j.item.id);
      scheduleFlush();
    }
  }
  await Promise.all(waits);
  scheduleFlush();
  const scores = {};
  for (const it of items) {
    const v = combineParts(parts, values.get(it.id));
    if (v !== undefined) scores[it.id] = v;
  }
  return { scores, backend: s.backend, tags: s.useTags ? await knownTags(items) : {} };
}

// 设置页的“测试连接”：用表单里还没保存的设置打分，不读写缓存
async function test({ settings, query, items }) {
  const parts = queryParts(query.intents || [], query.exclude || '');
  const values = await runParts(settings, items.map((item) => ({ item, parts })));
  const scores = {};
  items.forEach((it, i) => {
    const v = combineParts(parts, values[i]);
    if (v !== undefined) scores[it.id] = v;
  });
  return { scores, backend: settings.backend };
}

// ---- 消息 ----
const handlers = {
  ping: () => ({ build: BUILD }),
  score: async (msg) => ({ ok: true, ...(await score(msg)) }),
  test: async (msg) => ({ ok: true, ...(await test(msg)) }),
  usage: async () => {
    await usageLoaded;
    if (usage.day !== today()) countUsage('hits', 0);
    return { ok: true, usage, cache: await cacheStats() };
  },
  'clear-cache': async () => {
    await clearCache();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg))
    .then(sendResponse, (err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // 异步回复
});
