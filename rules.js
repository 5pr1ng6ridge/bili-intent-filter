// 内容脚本用的纯规则函数：链接类型识别、屏蔽关键词、多模式合并、页面范围。
// 以普通脚本加载在 content.js 之前（内容脚本不能用 import），也可以在 Node 里 require 测试。
var BifRules = (() => {
  // 顺序有意义：广告链接可能指向 /video/BV，要先判广告
  const KIND_PATTERNS = [
    ['ad', /(?:^|\/\/|\.)(?:cm|gaoneng)\.bilibili\.com\/|[?&](?:creative_id|from_bcg)=/],
    ['live', /live\.bilibili\.com\/(?:blanc\/)?(\d+)/],
    ['course', /\/cheese\/(?:play|detail)\/((?:ss|ep)\d+)/],
    ['bangumi', /\/bangumi\/(?:play|media)\/((?:ss|ep|md)\d+)/],
    ['video', /\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i],
    ['other', /manga\.bilibili\.com\/detail\/(mc\d+)|\/read\/(cv\d+)|\/opus\/(\d+)/],
  ];
  const BV = /\/video\/(BV[0-9A-Za-z]{10})/;

  // 返回 { kind, id } 或 null（不是内容链接，比如 UP 主空间）
  function classifyHref(href) {
    for (const [kind, re] of KIND_PATTERNS) {
      const m = href.match(re);
      if (!m) continue;
      if (kind === 'ad') return { kind, id: href.match(BV)?.[1] || null };
      const raw = m.slice(1).find(Boolean);
      return { kind, id: kind === 'video' ? raw : `${kind}:${raw}` };
    }
    return null;
  }

  // “八卦，引战、/开箱|测评/i” → 匹配器列表。/.../ 包起来的按正则处理
  function parseKeywords(text) {
    const out = [];
    for (const raw of (text || '').split(/[,，、;；\n]+/)) {
      const t = raw.trim();
      if (!t) continue;
      const re = t.match(/^\/(.+)\/([a-z]*)$/);
      if (re) {
        try {
          const rx = new RegExp(re[1], re[2].includes('i') ? re[2] : re[2] + 'i');
          out.push({ label: t, test: (s) => rx.test(s) });
          continue;
        } catch {
          // 不是合法正则，当普通文字处理
        }
      }
      const lower = t.toLowerCase();
      out.push({ label: t, test: (s) => s.toLowerCase().includes(lower) });
    }
    return out;
  }

  // 返回命中的关键词原文，没命中返回 null
  function matchKeywords(rules, text) {
    for (const r of rules) if (r.test(text)) return r.label;
    return null;
  }

  // 同时使用多个模式时合成一份查询（modes 按模式顺序）：
  //   intents  每个模式的“想看”各算一项，打分时取最高，只符合一个也算相关
  //   exclude  所有“不想看”拆开去重后合并成一句
  //   keywords 屏蔽关键词合并；threshold 取最低，免得某个模式想看的内容被另一个模式的阈值挡住
  function combineModes(modes) {
    const intents = [];
    const excludes = new Map(); // 小写 -> 原文
    const keywords = [];
    let threshold = null;
    for (const m of modes) {
      const intent = (m.intent || '').trim();
      if (intent && !intents.includes(intent)) intents.push(intent);
      for (const raw of (m.exclude || '').split(/[,，、;；\n]+/)) {
        const t = raw.trim();
        if (t && !excludes.has(t.toLowerCase())) excludes.set(t.toLowerCase(), t);
      }
      if ((m.keywords || '').trim()) keywords.push(m.keywords);
      if (typeof m.threshold === 'number') threshold = Math.min(threshold ?? 1, m.threshold);
    }
    return {
      intents,
      exclude: [...excludes.values()].join('，'),
      keywords: keywords.join('\n'),
      threshold: threshold ?? 0.3,
    };
  }

  // 'history' | 'favorites' | null（null 表示普通页面，始终生效）
  function pageScope(loc) {
    const { hostname: host, pathname: path } = loc;
    if (host === 'www.bilibili.com' && /^\/(?:history|account\/history)/.test(path)) return 'history';
    if (host === 'space.bilibili.com' && /^\/\d+\/favlist/.test(path)) return 'favorites';
    if (host === 'www.bilibili.com' && /^\/(?:medialist|list\/ml|watchlater|list\/watchlater)/.test(path)) return 'favorites';
    return null;
  }

  return { classifyHref, parseKeywords, matchKeywords, combineModes, pageScope };
})();

if (typeof module !== 'undefined') module.exports = BifRules;
