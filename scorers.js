// 打分后端。一次打分拆成若干“分项”，每个分项单独评估、单独缓存，组合模式时可以复用单个模式打过的分：
//   part: { type: 'rel', text: 想看的内容 }   → 相关度 0~1
//         { type: 'exc', text: 不想看的内容 } → 属于不想看内容的概率 0~1
//   job:  { item, parts }
//   item: { id, kind, title, up, sub, duration, tags? }，kind 见 settings.js 的 CONTENT_TYPES，空字段为 ''
// 每个后端都是 async (jobs, ...) => values，values[i][k] 对应 jobs[i].parts[k]，没评估出来的留 undefined。

// 打分方式（提示词、拼接字段等）变了就加一，后台的持久缓存会随之失效
export const SCORER_VERSION = 3;

// 把意图文本拆成若干短语：“Rust 入门，系统设计、不要八卦” → ['rust 入门', '系统设计', '不要八卦']
export function splitPhrases(text) {
  return (text || '')
    .split(/[,，、;；\n|]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// 中文按相邻两字切分，英文/数字按整词切分；单字短语退化为单字。
export function grams(text) {
  const s = (text || '').toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z0-9]+/g) || []) out.add(w);
  for (const run of s.match(/[㐀-鿿]+/g) || []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

// 短语有多少比例的片段出现在文本里
function coverage(phrase, textGrams) {
  const g = grams(phrase);
  if (g.size === 0) return 0;
  let hit = 0;
  for (const x of g) if (textGrams.has(x)) hit++;
  return hit / g.size;
}

// 转成 0~1 的数，不是数字返回 undefined
export function toUnit(raw) {
  const v = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(v)) return undefined;
  return Math.min(1, Math.max(0, v));
}

// 最终分数 = 各项“想看”里的最高相关度 ×（1 − 不想看的概率）。
// 只符合其中一个模式就算相关；没填“想看”时相关度按 1 算。缺任何一项返回 undefined。
export function combineParts(parts, values) {
  let rel = null;
  let exc = 0;
  for (let k = 0; k < parts.length; k++) {
    const v = values[k];
    if (v === undefined) return undefined;
    if (parts[k].type === 'rel') rel = Math.max(rel ?? 0, v);
    else exc = v;
  }
  return Math.round((rel ?? 1) * (1 - exc) * 1000) / 1000;
}

// 内置基线：字面重合度。不懂同义词，只用来跑通流程、给外部模型当对照。
export async function scoreLocal(jobs) {
  return jobs.map(({ item, parts }) => {
    const tg = grams(`${item.title} ${item.up} ${item.sub || ''} ${(item.tags || []).join(' ')}`);
    return parts.map((p) => Math.max(0, ...splitPhrases(p.text).map((ph) => coverage(ph, tg))));
  });
}

async function postJson(url, body, apiKey, timeoutMs = 15000) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`${HTTP_ERRORS[res.status] || 'HTTP 错误'}（${res.status}）${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return JSON.parse(text);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求超时');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const HTTP_ERRORS = {
  401: 'API Key 无效',
  403: '没有权限',
  404: '接口地址不存在',
  422: '请求格式校验失败',
  429: '请求太频繁，被限流',
  529: '服务过载',
};

// 自定义接口。约定见 README：每个分项单独调用一次，“想看”分项只带 intent，“不想看”分项只带 exclude，
// 后者返回的是 1 − 不想看的概率。
export async function scoreHttp(jobs, endpoint, apiKey) {
  const values = jobs.map((j) => j.parts.map(() => undefined));
  const groups = new Map(); // 分项 -> { part, slots: [[job 下标, 分项下标]] }
  jobs.forEach((j, ji) => j.parts.forEach((p, k) => {
    const key = `${p.type}\u0001${p.text}`;
    if (!groups.has(key)) groups.set(key, { part: p, slots: [] });
    groups.get(key).slots.push([ji, k]);
  }));
  const results = await Promise.allSettled([...groups.values()].map(async ({ part, slots }) => {
    const query = part.type === 'rel' ? { intent: part.text, exclude: '' } : { intent: '', exclude: part.text };
    const items = slots.map(([ji]) => ({ ...jobs[ji].item, tags: jobs[ji].item.tags || [] }));
    const data = await postJson(endpoint, { ...query, items }, apiKey);
    if (!data || typeof data.scores !== 'object') throw new Error('响应缺少 scores 字段');
    for (const [ji, k] of slots) {
      const v = toUnit(data.scores[jobs[ji].item.id]);
      if (v !== undefined) values[ji][k] = part.type === 'rel' ? v : 1 - v;
    }
  }));
  // 全部失败时把原因带回去显示在角标上
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length && failed.length === results.length) throw failed[0].reason;
  return values;
}

// ---- TypeSafe Jev（System One 接口） ----
// 一次请求只能有一个 state，所以每条内容单独请求；同一请求里的多个问题是并行评估的，
// 多个“想看”就各问一个 relevance。文档：https://docs.typesafe.ai/primitives/score.md 、/primitives/noul.md

// Score 的档位要描述“情形”而不是程度词，模型只看得到描述本身
const RELEVANCE_CRITERIA = [
  '这条内容和用户想看的主题毫无关系',
  '这条内容只是碰巧提到相关的词，实际讲的是别的事情',
  '这条内容涉及用户想看的主题的一部分，或是相邻的话题',
  '这条内容正是在讲用户想看的主题',
];

const KIND_LABELS = { video: '视频', live: '直播', course: '课程', bangumi: '番剧影视', ad: '推广内容', other: '其他' };

// relevance、relevance_2、relevance_3 …，不想看是 excluded
function questionNames(parts) {
  let n = 0;
  return parts.map((p) => (p.type === 'exc' ? 'excluded' : ++n === 1 ? 'relevance' : `relevance_${n}`));
}

export function buildJevRequest(item, parts, model) {
  const names = questionNames(parts);
  const questions = {};
  parts.forEach((p, k) => {
    questions[names[k]] = p.type === 'rel'
      ? {
        type: 'score',
        instructions: `用户在 B 站上想看的内容是：${p.text}。这条内容和用户想看的内容有多相关？`,
        criteria: RELEVANCE_CRITERIA,
      }
      : {
        type: 'noul',
        instructions: `用户明确不想看这些内容：${p.text}。这条内容属于用户不想看的内容吗？`,
      };
  });
  const state = { 类型: KIND_LABELS[item.kind] || KIND_LABELS.video, 标题: item.title };
  if (item.up) state.UP主 = item.up;
  if (item.sub) state.副标题 = item.sub;
  if (item.tags?.length) state.标签 = item.tags.join('、');
  if (item.duration) state.时长 = item.duration;
  return { model, state, questions };
}

// 返回和 parts 对应的值：相关度按档位折算到 0~1，不想看取 noul 概率
export function parseJevResponse(data, parts) {
  const names = questionNames(parts);
  return parts.map((p, k) => {
    const a = data?.answers?.[names[k]];
    if (p.type === 'rel') {
      if (typeof a?.score !== 'number') throw new Error(`jev 响应缺少 ${names[k]} 分数`);
      const top = a.legend ? Object.keys(a.legend).length - 1 : RELEVANCE_CRITERIA.length - 1;
      return toUnit(a.score / top);
    }
    if (typeof a?.noul !== 'number') throw new Error('jev 响应缺少 excluded 结果');
    return toUnit(a.noul);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scoreOneJev(job, cfg) {
  const body = buildJevRequest(job.item, job.parts, cfg.model);
  for (let attempt = 0; ; attempt++) {
    try {
      return parseJevResponse(await postJson(cfg.endpoint, body, cfg.apiKey), job.parts);
    } catch (err) {
      // 限流或过载时稍等重试一次
      if (attempt === 0 && (err.status === 429 || err.status === 529)) {
        await sleep(1500);
        continue;
      }
      throw err;
    }
  }
}

export async function scoreJev(jobs, cfg, concurrency = 6) {
  if (!cfg.apiKey) throw new Error('还没有填写 jev 的 API Key');
  const values = jobs.map((j) => j.parts.map(() => undefined));
  let ok = 0;
  let firstError = null;
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const ji = next++;
      try {
        values[ji] = await scoreOneJev(jobs[ji], cfg);
        ok++;
      } catch (err) {
        firstError ??= err;
        if (err.status === 401 || err.status === 403) next = jobs.length; // Key 有问题就不用再试了
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  // 全部失败时把原因带回去显示在角标上；部分失败的内容就留空
  if (ok === 0 && firstError) throw firstError;
  return values;
}
