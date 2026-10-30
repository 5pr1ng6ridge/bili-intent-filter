// 在 B 站页面里找内容卡片 → 识别类型、提取信息 → 本地规则（类型、关键词）或交给后台打分 → 低于阈值的模糊。
(() => {
  const R = BifRules; // rules.js

  // B 站改版时主要改这里。只处理最外层匹配到的元素。
  const CARD_SELECTOR = [
    '.bili-video-card',               // 首页推荐、搜索结果、分区、空间、历史记录网格
    '.bili-live-card',                // 首页推荐里的直播
    '.floor-single-card',             // 首页穿插的直播、番剧、课堂、漫画
    '.video-page-card-small',         // 播放页右侧推荐
    '.video-page-special-card-small', // 播放页右侧的课程等
    '.video-card-ad-small',           // 播放页右侧广告
    '.ad-report',                     // 播放页的广告位
    '.media-card',                    // 搜索页的番剧影视
    '.activity-card',                 // 搜索页的推广大卡
    '.bili-bangumi-card',             // 空间、收藏夹里的番剧
    '.history-card',                  // 历史记录列表
  ].join(',');
  const AD_MARK = '.video-card-ad-small, .ad-report, [class*="__info--ad"]';
  const TITLE_SELECTORS = [
    '.bili-video-card__info--tit',
    '.bili-live-card__info--tit',
    '.bili-video-card__title',
    '.bili-bangumi-card__title',
    '.media-card-content-head-title a[title]',
    '.info__top a[title]',
    'p.title',
    '.title',
    'h3',
    'a[title]',
  ];
  const UP_SELECTOR = [
    '.bili-video-card__info--author',
    '.bili-live-card__info--author',
    '.upname .name',
    '.up-name__text',
    '.info__bottom a[title]',
  ].join(',');
  const SUB_SELECTOR = [
    '.bili-bangumi-card__subtitle',
    '.bili-live-card__stats--area',
    '.media-card-content-head-title-tag',
    '.video-page-special-card-small .desc',
  ].join(',');
  const DURATION_SELECTOR = '.bili-video-card__stats__duration, .duration';
  // 播放页等 Vue 2 服务端渲染的页面：页面脚本要等播放器初始化后才加载，hydrate 时逐个比对服务端输出的节点，
  // 卡片里多一个角标就会放弃 hydrate、整页重新渲染，顶栏的搜索框和入口会因此丢失。
  // Vue 开始 hydrate 时会去掉这个属性，在那之前不改里面的卡片，只在 <html> 上加 class 先整体遮住。
  const SSR_ROOT = '[data-server-rendered]';

  const BATCH_SIZE = 30;
  const FLUSH_DELAY = 150;
  const PRELOAD_MARGIN = '800px 0px'; // 离视口这么近才打分，没滚到的不花用量
  // 角标上标明分数来源（和 settings.js 的 BACKEND_LABELS 对应，这里用短名）
  const SOURCE_TAGS = { jev: 'Jev', http: '接口', local: '基线' };
  // 以下两项和 settings.js 保持一致（内容脚本不能 import 模块）
  const TYPE_LABELS = { video: '视频', live: '直播', course: '课程', bangumi: '番剧', ad: '广告', other: '其他' };
  const DEFAULT_TYPE_RULES = { video: 'score', live: 'score', course: 'score', bangumi: 'score', ad: 'zero', other: 'pass' };

  let cfg = null;
  let keywordRules = [];
  let modelSig = '';     // 模型分数对应的配置；变了就要重新打分
  let cfgVer = 0;        // 任何设置变化都加一，卡片据此重新套规则（不一定重新打分）
  let previewThreshold = null; // 弹窗拖动滑块时的临时阈值
  let wasActive = false;
  const state = new WeakMap(); // card -> { key, item, model, view }
  const queue = new Map();     // id -> item
  let flushTimer = null;

  // ---- 设置 ----
  async function loadConfig() {
    const s = await chrome.storage.sync.get(null);
    const order = Array.isArray(s.modeOrder) ? s.modeOrder.filter((id) => s[`mode_${id}`]) : [];
    // 可以一个模式都不用，这时只按内容类型过滤。
    // 还没迁移的旧版设置（0.4 的单个 activeMode、0.3 的平铺字段）先凑合着用，后台迁移完会再触发一次 onChanged
    const ids = Array.isArray(s.activeModes)
      ? order.filter((id) => s.activeModes.includes(id))
      : [order.includes(s.activeMode) ? s.activeMode : order[0]];
    const modes = order.length
      ? ids.map((id) => s[`mode_${id}`])
      : [{ intent: s.intent, exclude: s.exclude, threshold: s.threshold }];
    const q = R.combineModes(modes);
    cfg = {
      enabled: s.enabled ?? true,
      showBadge: s.showBadge ?? true,
      backend: s.backend || 'local',
      useTags: s.useTags ?? true,
      rev: s.rev || 0,
      typeRules: { ...DEFAULT_TYPE_RULES, ...s.typeRules },
      scopes: { history: false, favorites: false, ...s.scopes },
      intents: q.intents,
      exclude: q.exclude,
      threshold: q.threshold,
    };
    keywordRules = R.parseKeywords(q.keywords);
    const sig = [cfg.rev, cfg.backend, cfg.useTags, cfg.exclude, ...[...cfg.intents].sort()].join('\u0001');
    if (sig !== modelSig) {
      modelSig = sig;
      queue.clear();
    }
    previewThreshold = null;
    cfgVer++;
  }

  const threshold = () => previewThreshold ?? cfg.threshold;
  const hasQuery = () => cfg.intents.length > 0 || Boolean(cfg.exclude);

  function isActive() {
    if (!cfg?.enabled) return false;
    const scope = R.pageScope(location);
    return !scope || Boolean(cfg.scopes[scope]);
  }

  // ---- 卡片识别 ----
  function classify(card, links) {
    if (card.matches(AD_MARK) || card.querySelector(AD_MARK)) {
      const bv = links.map((a) => a.href.match(/\/video\/(BV[0-9A-Za-z]{10})/)?.[1]).find(Boolean);
      return { kind: 'ad', id: bv || null };
    }
    let first = null;
    for (const a of links) {
      const c = R.classifyHref(a.href);
      if (c?.kind === 'ad') return c; // 推广链接优先
      first ??= c;
    }
    return first;
  }

  function textOf(el) {
    if (!el) return '';
    const t = el.getAttribute('title') || el.querySelector('[title]')?.getAttribute('title') || el.textContent;
    return t.replace(/\s+/g, ' ').trim();
  }

  function extract(card) {
    const links = [...card.querySelectorAll('a[href]')];
    if (card.matches('a[href]')) links.unshift(card);
    const c = classify(card, links);
    if (!c) return null; // 骨架屏、活动横幅等
    let title = '';
    for (const sel of TITLE_SELECTORS) {
      title = textOf(card.querySelector(sel));
      if (title) break;
    }
    title = (title || card.querySelector('img[alt]')?.alt || '').replace(/^直播中\s*/, '').trim();
    // 广告位常常只有一张图，没有标题也照样识别
    if (!title && (c.kind !== 'ad' || !links.length)) return null;
    let up = textOf(card.querySelector(UP_SELECTOR));
    let sub = textOf(card.querySelector(SUB_SELECTOR));
    // 首页楼层卡的副标题：直播、课程是 UP 主，番剧是剧集名
    const floorSub = textOf(card.querySelector('a.sub-title'));
    if (floorSub && !up && (c.kind === 'live' || c.kind === 'course')) up = floorSub;
    else if (floorSub && !sub) sub = floorSub;
    return {
      id: c.id || `${c.kind}:${title || links[0].getAttribute('href')}`,
      kind: c.kind,
      title,
      up,
      sub,
      duration: textOf(card.querySelector(DURATION_SELECTOR)),
    };
  }

  // 卡片内容的指纹，变了说明被框架复用成了别的内容
  function fingerprint(card) {
    let key = card.getAttribute('href') || '';
    for (const a of card.querySelectorAll('a[href]')) key += ' ' + a.getAttribute('href');
    return key;
  }

  // ---- 判定 ----
  // 返回 null（不处理）| { pending } | { rule, note } | { score, backend, tags } | { error }
  function viewOf(st) {
    const { item } = st;
    const action = cfg.typeRules[item.kind] || 'score';
    if (action === 'pass') return null;
    const label = TYPE_LABELS[item.kind] || item.kind;
    if (action === 'zero') return { rule: label, note: `“${label}”类型设为直接 0 分` };
    if (keywordRules.length && R.matchKeywords(keywordRules, `${item.title}\n${item.up}\n${item.sub}`)) {
      return { rule: '关键词', note: '命中屏蔽关键词' };
    }
    if (!hasQuery()) return null; // 没填想看/不想看：只按类型和关键词过滤
    if (st.model?.sig !== modelSig) st.model = { sig: modelSig };
    const m = st.model;
    if (m.error) return { error: m.error };
    if (m.score === undefined) return { pending: true };
    return { score: m.score, backend: m.backend, tags: m.tags };
  }

  function evaluate(card, st) {
    st.view = viewOf(st);
    st.cfgVer = cfgVer;
    if (st.view?.pending && !st.model.requested) io.observe(card);
    render(card, st.view);
  }

  // ---- 显示 ----
  function badgeOf(card) {
    let b = card.querySelector(':scope > .bif-badge');
    if (!b) {
      b = document.createElement('span');
      b.className = 'bif-badge';
      card.appendChild(b);
    }
    return b;
  }

  function clearCard(card) {
    card.classList.remove('bif-card', 'bif-rel', 'bif-anim', 'bif-pending', 'bif-hidden', 'bif-error', 'bif-rule');
    card.querySelector(':scope > .bif-badge')?.remove();
  }

  function render(card, view) {
    if (!view) return clearCard(card);
    if (!card.classList.contains('bif-card')) {
      card.classList.add('bif-card');
      if (getComputedStyle(card).position === 'static') card.classList.add('bif-rel');
      // 第一次标记不做渐变，命中规则的卡片直接模糊，不会闪一下
      requestAnimationFrame(() => card.classList.add('bif-anim'));
    }
    const hidden = Boolean(view.rule) || (view.score !== undefined && view.score < threshold());
    card.classList.toggle('bif-pending', Boolean(view.pending));
    card.classList.toggle('bif-error', Boolean(view.error));
    card.classList.toggle('bif-rule', Boolean(view.rule));
    card.classList.toggle('bif-hidden', hidden);

    if (!cfg.showBadge || view.pending) {
      card.querySelector(':scope > .bif-badge')?.remove();
      return;
    }
    const b = badgeOf(card);
    if (view.error) {
      b.textContent = '?';
      b.title = view.error;
    } else if (view.rule) {
      b.textContent = `0 ${view.rule}`;
      b.title = view.note;
    } else {
      const tag = SOURCE_TAGS[view.backend] || view.backend || '';
      b.textContent = tag ? `${view.score.toFixed(2)} ${tag}` : view.score.toFixed(2);
      b.title = `相关度 ${view.score.toFixed(3)}（来自${tag || '未知来源'}），阈值 ${threshold().toFixed(2)}`
        + (view.tags?.length ? `\n标签：${view.tags.join('、')}` : '');
    }
  }

  function renderAll() {
    for (const card of document.querySelectorAll('.bif-card')) {
      const st = state.get(card);
      if (st?.view) render(card, st.view);
    }
  }

  // ---- 扫描 ----
  function scan() {
    const active = isActive();
    if (active !== wasActive) {
      wasActive = active;
      cfgVer++;
      if (!active) {
        // 排队中的请求作废，重新生效时这些卡片要再排一次
        queue.clear();
        for (const card of document.querySelectorAll('.bif-card')) {
          const st = state.get(card);
          if (st?.view?.pending) st.model = null;
          if (st) st.view = null;
          io.unobserve(card);
          clearCard(card);
        }
      }
    }
    // 没填想看/不想看时卡片不会进入“打分中”，也就不用先遮住
    const ssrRoot = active && hasQuery() ? document.querySelector(SSR_ROOT) : null;
    document.documentElement.classList.toggle('bif-wait', Boolean(ssrRoot));
    if (!active) return;
    const current = location.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/)?.[1];
    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
      if (card.parentElement?.closest(CARD_SELECTOR)) continue; // 嵌套卡片只处理最外层
      if (card.closest(SSR_ROOT)) continue; // 等页面 hydrate 完再处理
      const key = fingerprint(card);
      let st = state.get(card);
      if (st && st.key === key && st.cfgVer === cfgVer) continue;
      if (!st || st.key !== key) {
        const item = extract(card);
        if (!item || item.id === current) {
          // 还没加载完的卡片下次再看；当前正在播放的视频不处理
          state.delete(card);
          clearCard(card);
          continue;
        }
        st = { key, item, model: null, view: null };
        state.set(card, st);
        card.dataset.bifId = item.id;
        card.dataset.bifKind = item.kind; // 方便排查识别结果
      }
      evaluate(card, st);
    }
  }

  // ---- 按需打分 ----
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const st = state.get(e.target);
      if (!st?.view?.pending || !st.model || st.model.requested) continue;
      st.model.requested = true;
      queue.set(st.item.id, st.item);
    }
    scheduleFlush();
  }, { rootMargin: PRELOAD_MARGIN });

  function scheduleFlush() {
    if (flushTimer || queue.size === 0) return;
    flushTimer = setTimeout(flush, FLUSH_DELAY);
  }

  function cardsFor(id) {
    return document.querySelectorAll(`[data-bif-id="${CSS.escape(id)}"]`);
  }

  async function flush() {
    flushTimer = null;
    const items = [...queue.values()].slice(0, BATCH_SIZE);
    items.forEach((it) => queue.delete(it.id));
    const sig = modelSig;
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'score', items, intents: cfg.intents, exclude: cfg.exclude });
    } catch (err) {
      const msg = String(err?.message || err);
      // 扩展被刷新后，旧页面里的脚本和后台断开了联系
      resp = { ok: false, error: /context invalidated/i.test(msg) ? '插件已更新，请刷新本页' : msg };
    }
    for (const it of items) {
      const v = resp?.ok ? resp.scores?.[it.id] : undefined;
      for (const card of cardsFor(it.id)) {
        const st = state.get(card);
        if (st?.model?.sig !== sig) continue; // 设置已经变了，丢弃旧结果
        // 失败时放行，不让用户看到一页糊
        st.model = v === undefined
          ? { sig, error: resp?.ok ? '模型未返回这条内容的分数' : resp?.error || '打分失败' }
          : { sig, score: v, backend: resp.backend || '', tags: resp.tags?.[it.id] };
        evaluate(card, st);
      }
    }
    scheduleFlush();
  }

  // ---- 事件 ----
  let scanQueued = false;
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      scan();
    });
  }

  chrome.storage.onChanged.addListener(async (_changes, area) => {
    if (area !== 'sync') return;
    await loadConfig();
    scan();
  });

  // 弹窗：拖动阈值时预览、查看本页统计
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!cfg) return false;
    if (msg?.type === 'preview') {
      previewThreshold = msg.threshold;
      renderAll();
      sendResponse({ ok: true });
    } else if (msg?.type === 'stats') {
      const count = (cls) => document.querySelectorAll(`.bif-card${cls}`).length;
      sendResponse({
        ok: true,
        active: isActive(),
        scope: R.pageScope(location),
        hasQuery: hasQuery(),
        total: count(''),
        hidden: count('.bif-hidden'),
        ruled: count('.bif-rule'),
        pending: count('.bif-pending'),
        errors: count('.bif-error'),
      });
    }
    return false;
  });

  loadConfig().then(() => {
    // 等页面 hydrate 时遮住服务端渲染的卡片，和“打分中”的样式一样（见 SSR_ROOT）
    const wait = document.createElement('style');
    wait.textContent = `.bif-wait ${SSR_ROOT} :is(${CARD_SELECTOR}) > * { filter: blur(6px) grayscale(0.6); opacity: 0.6; }`;
    document.head.append(wait);
    new MutationObserver(queueScan).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['data-server-rendered'],
    });
    scan();
  });
})();
