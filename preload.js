/**
 * 抖音 · 自用版 —— 推荐流净化 + 设置面板
 *
 * 两层过滤：
 *   1) 数据层（真·刷不到）：拦住 /aweme/v1/web/tab/feed/ 的响应，
 *      把不该出现的条目从 aweme_list 里删掉，播放器列表里根本没这些内容。
 *   2) DOM 层（兜底跳过）：数据里看不出、但页面上有「广告/进入直播间/立即购买」等
 *      角标的，检测到后自动切下一条。
 *
 * 判定字段来自实测 + GitHub 5434945/douyin-cleaner 的接口观察：
 *   接口里唯一可靠的广告信号是布尔值 is_ads，其余靠 aweme_type / commerce_top_labels 等。
 */

let ipcRenderer = null;
try { ipcRenderer = require('electron').ipcRenderer; } catch (e) { /* 非 Electron 环境 */ }

/* 窗口全屏桥接：渲染层 requestFullscreen 不是 F11，要走主进程 setFullScreen */
if (ipcRenderer) {
  window.__dyMain = {
    toggleFullScreen: () => ipcRenderer.send('dy-toggle-window-fullscreen'),
    isFullScreen: () => ipcRenderer.sendSync('dy-is-window-fullscreen'),
  };
  ipcRenderer.on('dy-fullscreen-changed', () => {
    if (typeof keepFabVisible === 'function') keepFabVisible();
  });
}

const CFG_KEY = 'dy-desk.config.v1';

const DEFAULTS = {
  // 数据层：直接让内容刷不到
  dropAds: true,       // 广告（is_ads / aweme_type 1 / raw_ad_data）
  dropLive: true,      // 直播（aweme_type 101 / cell_room）
  dropShop: true,      // 带货视频（commerce_top_labels 非空）
  dropLife: true,      // 本地生活/团购（is_life_item）
  dropAnchor: false,   // 任何挂载锚点（含影视剧卡片，比较激进）
  minLikes: 0,         // 点赞下限，0=关
  keywords: [],        // 文案/作者/音乐关键词
  blockAuthors: [],    // 拉黑的作者 uid
  blockAwemes: [],     // 标记为广告的 aweme_id
  // DOM 层
  domSkip: true,       // 兜底：页面角标检测后跳过
  hideHeader: true,    // 只隐藏顶部搜索框与右上角消息入口（其余页面样式保持抖音原样）
  autoFullscreen: true, // 启动后自动按 Y 进入网页全屏（只派发键盘事件，不做坐标点击）
  // 行为
  feedUrlPattern: 'aweme/v1/web/tab/feed',
  fabPos: null,        // { right, bottom }，拖动后记住
};

/** 最近一批保留的条目，供面板显示当前视频、拉黑用 */
const RECENT = new Map();

function extractPlayUrl(item) {
  const v = item.video || {};
  const lists = [v.play_addr_h264, v.play_addr, v.download_addr, v.bit_rate?.[0]?.play_addr];
  for (const o of lists) {
    const l = o && o.url_list;
    if (Array.isArray(l) && l.length) return l[0];
  }
  return '';
}

function remember(item) {
  const id = String(item.aweme_id || '');
  if (!id) return;
  RECENT.set(id, {
    id,
    desc: item.desc || '',
    author: (item.author && item.author.nickname) || '',
    authorUid: item.author && item.author.uid ? String(item.author.uid) : '',
    playUrl: extractPlayUrl(item),
    digg: (item.statistics && item.statistics.digg_count) || 0,
  });
  while (RECENT.size > 300) RECENT.delete(RECENT.keys().next().value);
}

function loadConfig() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      // 只接受 DEFAULTS 里存在的键，丢掉旧版本残留（如 hideSidebar / cleanUI）
      const clean = {};
      for (const k of Object.keys(DEFAULTS)) {
        if (Object.prototype.hasOwnProperty.call(saved, k)) clean[k] = saved[k];
      }
      return Object.assign({}, DEFAULTS, clean);
    }
  } catch (e) { /* 损坏就用默认 */ }
  return Object.assign({}, DEFAULTS);
}

function saveConfig(cfg) {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {}
}

const CFG = loadConfig();

const stats = {
  apiSeen: 0,        // 数据层处理过的条目
  apiDropped: 0,     // 数据层删除
  domChecked: 0,     // DOM 层检查
  domSkipped: 0,     // DOM 层跳过
  byReason: {},
};

function bump(reason) {
  stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;
}

const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();

/* =========================================================
   数据层：判定 + 改写响应
   ========================================================= */

/** 该条目是否应当被丢弃，返回原因或 null */
function dropReason(item) {
  if (!item || typeof item !== 'object') return null;

  // 手动拉黑 / 手动标记（优先级最高）
  if (CFG.blockAwemes && CFG.blockAwemes.length) {
    if (CFG.blockAwemes.includes(String(item.aweme_id))) return 'marked';
  }
  if (CFG.blockAuthors && CFG.blockAuthors.length && item.author) {
    const uid = String(item.author.uid || '');
    if (uid && CFG.blockAuthors.includes(uid)) return 'author-blocked';
  }

  // 广告：is_ads 是布尔值（曾有项目在这里踩过 1===true 的坑）
  if (CFG.dropAds) {
    if (item.is_ads === true || item.is_ads === 1) return 'ad';
    if (item.aweme_type === 1 || item.raw_ad_data) return 'ad';
  }

  // 直播
  if (CFG.dropLive) {
    if (item.aweme_type === 101 || item.cell_room) return 'live';
  }

  // 带货视频：实测普通视频该字段为 null
  if (CFG.dropShop) {
    const ctl = item.commerce_top_labels;
    if (ctl && ctl.length) return 'shop';
  }

  // 本地生活 / 团购
  if (CFG.dropLife) {
    if (item.is_life_item === true) return 'life';
  }

  // 任意挂载锚点（影视剧卡片、游戏预约等）
  if (CFG.dropAnchor) {
    const a = item.anchor_info;
    if (a && a.extra && String(a.extra).length > 20) return 'anchor';
  }

  // 低赞
  if (CFG.minLikes > 0) {
    const d = item.statistics && item.statistics.digg_count;
    if (typeof d === 'number' && d < CFG.minLikes) return 'like';
  }

  // 关键词
  if (CFG.keywords && CFG.keywords.length) {
    const hay = [
      item.desc,
      item.author && item.author.nickname,
      item.music && item.music.title,
    ].filter(Boolean).join(' ').toLowerCase();
    for (const kw of CFG.keywords) {
      const k = String(kw || '').toLowerCase();
      if (k && hay.includes(k)) return 'kw:' + kw;
    }
  }

  return null;
}

/** 过滤一个 feed 响应体，返回是否发生了改动 */
function filterBody(json) {
  if (!json || !Array.isArray(json.aweme_list)) return false;
  const list = json.aweme_list;
  stats.apiSeen += list.length;
  // 先全部记下，供面板显示/拉黑（即使这一批没有可剔除的）
  for (const it of list) remember(it);

  const kept = [];
  let dropped = 0;
  for (const item of list) {
    const why = dropReason(item);
    if (why) {
      dropped++;
      stats.apiDropped++;
      bump(why);
    } else {
      kept.push(item);
    }
  }
  if (!dropped) return false;

  // 全被删光时保留原列表，避免抖音因空列表白屏
  if (!kept.length) {
    console.warn('[dy] 本批全部命中过滤，保留原列表避免白屏');
    return false;
  }

  json.aweme_list = kept;
  // 记下保留的条目，供面板显示/拉黑
  for (const it of kept) remember(it);
  // 同步一下分页游标相关字段，尽量让抖音认为这就是服务端给的数据
  if (typeof json.has_more === 'number') json.has_more = json.has_more;
  return true;
}

function isFeedUrl(url) {
  try {
    return String(url || '').includes(CFG.feedUrlPattern);
  } catch (e) {
    return false;
  }
}

/* ---------- XHR ---------- */
function patchXHR() {
  const proto = XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;

  proto.open = function (method, url) {
    try { this.__dyUrl = url; } catch (e) {}
    return origOpen.apply(this, arguments);
  };

  proto.send = function () {
    const xhr = this;
    if (!isFeedUrl(xhr.__dyUrl)) return origSend.apply(this, arguments);

    // 抖音读响应用的不是 onreadystatechange，不能靠事件顺序。
    // 直接在实例上重定义 response / responseText 的 getter：谁读都拿到过滤后的结果。
    try { installReadRewrite(xhr); } catch (e) { console.warn('[dy] hook 失败', e); }

    return origSend.apply(this, arguments);
  };
}

const _dText = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
const _dResp = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');

function installReadRewrite(xhr) {
  const cache = { done: false, text: null, json: null };

  const doFilter = () => {
    if (cache.done) return;
    cache.done = true;
    if (xhr.readyState !== 4) return;
    if (xhr.status < 200 || xhr.status >= 300) return;

    let raw = null;
    try {
      if (xhr.responseType === 'json' && _dResp && _dResp.get) raw = _dResp.get.call(xhr);
      else if (_dText && _dText.get) raw = _dText.get.call(xhr);
    } catch (e) { return; }
    if (!raw) return;

    let json;
    try {
      json = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) { return; }
    if (!filterBody(json)) return;

    cache.json = json;
    cache.text = JSON.stringify(json);
    console.log(`[dy] 数据层剔除，累计 ${stats.apiDropped} 条`);
  };

  if (_dText && _dText.get) {
    Object.defineProperty(xhr, 'responseText', {
      configurable: true,
      get() {
        doFilter();
        return cache.text !== null ? cache.text : _dText.get.call(xhr);
      },
    });
  }
  if (_dResp && _dResp.get) {
    Object.defineProperty(xhr, 'response', {
      configurable: true,
      get() {
        doFilter();
        return cache.json !== null ? cache.json : _dResp.get.call(xhr);
      },
    });
  }
}

/* ---------- fetch ---------- */
function patchFetch() {
  const origFetch = window.fetch;
  if (typeof origFetch !== 'function') return;

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const p = origFetch.apply(this, arguments);
    if (!isFeedUrl(url)) return p;

    return p.then(async (res) => {
      try {
        const text = await res.clone().text();
        const json = JSON.parse(text);
        if (!filterBody(json)) return res;
        const headers = new Headers(res.headers);
        headers.delete('content-length');
        return new Response(JSON.stringify(json), {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      } catch (e) {
        return res;
      }
    });
  };
}

/* =========================================================
   DOM 层：兜底跳过（数据层没标记但页面有角标）
   ========================================================= */

const SELECTORS = {
  cards: '[data-e2e="feed-item"]',
  active: '[data-e2e="feed-active-video"]',
  feed: '[data-e2e="slideList"], #slidelist',
  metadata: '.account, [data-e2e="video-info"]',
  live: '[data-e2e="feed-live"]',
  ad: '[data-e2e="ad-link"], [data-e2e="ad-label"], [data-e2e="ad-tag"]',
  shopping: '.xgplayer-shop-anchor, [data-e2e="product-card"], [data-e2e="goods-card"], ' +
            '[data-e2e="shopping-cart"], [data-e2e="video-product"]',
  next: '[data-e2e="video-switch-next-arrow"], .xgplayer-playswitch-next, ' +
        '[aria-label="下一条"], [aria-label="下一个视频"]',
};

const AD_LABEL = /^(广告|推广|赞助|商业推广|品牌推广|付费推广|广告·.{0,12})$/;
const LIVE_ENTRY = /^(点击)?进入直播间$|^观看直播$/;
const SHOP_ENTRY = /^(立即购买|去购买|点击购买|马上购买|进店|进入店铺|同款商品|小黄车|商品|购物车|橱窗|购物)$/;
const LABEL_NODES = 'span, small, i, label, div, button, a, [aria-label]';

function findLabel(root, pattern) {
  const nodes = root.querySelectorAll(LABEL_NODES);
  for (const el of nodes) {
    if (el.children.length > 2) continue;
    const text = clean(el.textContent);
    if (!text || text.length > 12) continue;
    if (pattern.test(text)) return text;
    const aria = clean(el.getAttribute('aria-label'));
    if (aria && aria.length <= 12 && pattern.test(aria)) return aria;
  }
  return null;
}

function domDetect(root) {
  if (!root) return null;
  if (root.querySelector(SELECTORS.live) || findLabel(root, LIVE_ENTRY)) return 'live';
  if (root.querySelector(SELECTORS.ad)) return 'ad';
  for (const zone of root.querySelectorAll(SELECTORS.metadata)) {
    if (findLabel(zone, AD_LABEL)) return 'ad';
  }
  if (findLabel(root, AD_LABEL)) return 'ad';
  if (root.querySelector(SELECTORS.shopping)) return 'shopping';
  for (const zone of root.querySelectorAll(SELECTORS.metadata)) {
    if (findLabel(zone, SHOP_ENTRY)) return 'shopping';
  }
  if (findLabel(root, SHOP_ENTRY)) return 'shopping';
  return null;
}

let lastSkipAt = 0;
let consecutive = 0;


let lastSeenId = '';

function goNext() {
  const btn = document.querySelector('[data-e2e="video-switch-next-arrow"]');
  if (btn) btn.click();
}

function domTick() {
  if (!document.querySelector(SELECTORS.feed) && !document.querySelector(SELECTORS.cards)) return;

  const card = document.querySelector(SELECTORS.active) || document.querySelector(SELECTORS.cards);
  if (!card) return;

  const id = currentAwemeId();
  if (id && id === lastSeenId) { refreshCurrent(); return; }
  lastSeenId = id;
  refreshCurrent();

  if (!CFG.domSkip) return;

  stats.domChecked++;
  const why = domDetect(card);
  if (!why) { consecutive = 0; updatePanel(); return; }

  const now = Date.now();
  if (now - lastSkipAt < 1200) return;  // 滑动动画约 500-800ms，间隔太短会连点导致 swiper 错位
  if (consecutive >= 30) { consecutive = 0; return; }

  lastSkipAt = now;
  consecutive++;
  stats.domSkipped++;
  bump('dom:' + why);
  console.log(`[dy] DOM 兜底跳过 ${why}`);
  goNext();
  updatePanel();
}

/* =========================================================
   设置面板
   ========================================================= */

/* ---------- 当前视频 ---------- */
function currentAwemeId() {
  const active = document.querySelector('[data-e2e="feed-active-video"]');
  if (!active) return '';
  return String(active.getAttribute('data-e2e-vid') || '');
}

function currentItem() {
  const id = currentAwemeId();
  if (!id) return null;
  return RECENT.get(id) || null;
}


/* ---------- 播放控制 ---------- */
function goPrev() {
  const btn = document.querySelector('[data-e2e="video-switch-prev-arrow"]');
  if (btn) btn.click();
}

function togglePlay() {
  const v = document.querySelector('video');
  if (!v) return;
  if (v.paused) v.play().catch(() => {});
  else v.pause();
}

function changeRate(delta) {
  const v = document.querySelector('video');
  if (!v) return;
  let r = Math.round((v.playbackRate + delta) * 100) / 100;
  r = Math.min(4, Math.max(0.25, r));
  v.playbackRate = r;
  toast(`倍速 ${r}x`);
}

let panel = null;
let hostEl = null;
let refreshTimer = null;

const ROWS = [
  ['dropAds', '广告', '抖音投放的信息流广告，标了「广告」字样'],
  ['dropLive', '直播间', '左上角带 LIVE 标识的实时直播'],
  ['dropShop', '带货视频', '挂购物车、带商品链接的视频'],
  ['dropLife', '团购·本地生活', '推周边餐饮、景点、到店套餐的'],
  ['dropAnchor', '挂载锚点', '影视剧卡片、游戏预约、小程序等外链卡片。较激进，正常视频也可能被拦'],
  ['domSkip', '角标兜底', '数据层漏标记时，按页面角标（广告/进入直播间/立即购买）补刀跳过'],
  ['hideHeader', '精简顶栏', '隐藏顶部搜索框与右上角消息入口，其余界面保持抖音原样'],
  ['autoFullscreen', '启动即全屏', '打开客户端自动进入网页全屏。手动按 Y 同样有效'],
];

function css() {
  return `
  :host { all: initial; }
  .fab {
    width: 44px; height: 44px; border-radius: 50%;
    background: rgba(22,24,30,.94); color: #fff;
    display: flex; align-items: center; justify-content: center;
    font: 600 13px/1 system-ui, sans-serif; cursor: pointer;
    box-shadow: 0 6px 22px rgba(0,0,0,.38), 0 0 0 1px rgba(255,255,255,.14);
    user-select: none; backdrop-filter: blur(10px);
    transition: transform .15s, box-shadow .15s;
  }
  .fab:hover {
    transform: scale(1.08);
    box-shadow: 0 8px 28px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.28);
  }
  .fab:active { transform: scale(.97); }
  .fab.dragging { cursor: grabbing; }
  /* 面板打开时按钮高亮，一眼看出当前状态 */
  .fab.on {
    background: #fe2c55;
    box-shadow: 0 6px 22px rgba(254,44,85,.4), 0 0 0 1px rgba(255,255,255,.2);
  }
  .fab:hover { transform: scale(1.06); }
  .fab { cursor: grab; }
  .fab.dragging { cursor: grabbing; transform: scale(1.1); }
  .current {
    margin-top: 12px; padding: 10px 11px; border-radius: 9px;
    background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.07);
  }
  .current .t { font-size: 11.5px; color: #8b93a5; margin-bottom: 5px; }
  .current .n { color: #e8eaef; font-weight: 500; font-size: 12.5px; }
  .current .d {
    color: #99a1b2; font-size: 11.5px; margin: 3px 0 9px;
    max-height: 32px; overflow: hidden; line-height: 1.4;
  }
  /* ---------- 悬浮层：宿主已是 fixed 铺满视口，这里再叠一层定位基准 ---------- */
  .layer {
    position: fixed; z-index: 2147483647; pointer-events: auto;
    will-change: transform;
    animation: none !important;
    transition: none !important;
  }

  /* ---------- 面板 ---------- */
  .panel {
    width: 434px; max-height: 84vh; overflow-y: auto; overflow-x: hidden;
    background: rgba(20,22,28,.97); color: #e8eaef;
    border: 1px solid rgba(255,255,255,.11); border-radius: 16px;
    box-shadow: 0 24px 64px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.04);
    backdrop-filter: blur(20px);
    font: 13px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    padding: 0; overflow-wrap: break-word;
    scrollbar-width: thin;
    scrollbar-color: rgba(255,255,255,.18) transparent;
  }
  .panel[hidden] { display: none; }
  /* 自定义滚动条：默认的太粗太亮，和深色面板不搭 */
  .panel::-webkit-scrollbar { width: 6px; }
  .panel::-webkit-scrollbar-track { background: transparent; }
  .panel::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,.16); border-radius: 3px;
  }
  .panel::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.28); }

  /* 标题栏：含关闭叉号，滚动时吸顶 */
  .head {
    position: sticky; top: 0; z-index: 2;
    display: flex; align-items: flex-start; gap: 10px;
    padding: 16px 16px 12px;
    background: linear-gradient(180deg, rgba(20,22,28,.99) 72%, rgba(20,22,28,0));
  }
  .head .ttl { flex: 1; min-width: 0; }
  h3 { margin: 0 0 3px; font-size: 15.5px; font-weight: 600; letter-spacing: .3px; }
  .sub { color: #8b93a5; font-size: 11.5px; }
  .x {
    flex: none; width: 26px; height: 26px; border-radius: 8px;
    border: 1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.04);
    color: #aeb4c2; font: 400 17px/1 system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; transition: background .14s, color .14s, border-color .14s;
  }
  .x:hover { background: rgba(254,44,85,.18); color: #ff8fa3; border-color: rgba(254,44,85,.4); }
  .x:active { transform: scale(.92); }

  .body { padding: 0 16px 4px; }
  .foot {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 11px 16px 13px; margin-top: 6px;
    border-top: 1px solid rgba(255,255,255,.07);
    color: #6f7789; font-size: 11px;
    position: sticky; bottom: 0;
    background: linear-gradient(0deg, rgba(20,22,28,.99) 72%, rgba(20,22,28,0));
  }
  .current {
    padding: 11px 12px; border-radius: 11px;
    background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.07);
  }
  .current .t { font-size: 11px; color: #7d8598; margin-bottom: 4px; letter-spacing: .3px; }
  .current .n { color: #e8eaef; font-weight: 500; font-size: 13px; }
  .current .d {
    color: #99a1b2; font-size: 11.5px; margin: 4px 0 10px;
    max-height: 34px; overflow: hidden; line-height: 1.45;
  }
  .acts { display: flex; gap: 7px; }
  .acts .btn { flex: 1; text-align: center; padding: 6px 8px; white-space: nowrap; font-size: 12px; }
  .acts .btn:hover { background: rgba(255,255,255,.16); }
  .acts .btn.danger { color: #ff8fa3; border-color: rgba(254,44,85,.28); }
  .acts .btn.danger:hover { background: rgba(254,44,85,.2); }
  .acts .btn:disabled { opacity: .4; cursor: default; }
  h3 { margin: 0 0 2px; font-size: 15px; font-weight: 600; letter-spacing: .2px; }
  .sub { color: #8b93a5; font-size: 12px; margin-bottom: 14px; }
  .row {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 9px 0; border-top: 1px solid rgba(255,255,255,.06);
  }
  .row:first-of-type { border-top: none; }
  .row label { flex: 1; cursor: pointer; }
  .row b { font-weight: 500; display: block; }
  .row small { color: #8b93a5; font-size: 11.5px; display: block; margin-top: 1px; }
  .sw {
    appearance: none; width: 38px; height: 21px; border-radius: 12px;
    background: #33373f; position: relative; cursor: pointer; flex: none;
    transition: background .18s; margin-top: 2px;
  }
  .sw::after {
    content: ''; position: absolute; top: 2px; left: 2px;
    width: 17px; height: 17px; border-radius: 50%; background: #fff;
    transition: transform .18s;
  }
  .sw:checked { background: #fe2c55; }
  .sw:checked::after { transform: translateX(17px); }
  .field { margin-top: 12px; }
  .field label { display: block; color: #b9c0cf; margin-bottom: 5px; font-size: 12px; }
  /* label 里的 <b> 是补充说明，弱化成灰色，别抢主标题 */
  .field label b { font-weight: 400; color: #6f7789; }
  .field input {
    width: 100%; box-sizing: border-box; padding: 7px 9px;
    background: #0e1014; border: 1px solid rgba(255,255,255,.12);
    border-radius: 8px; color: #fff; font-size: 12.5px; outline: none;
  }
  .field input:focus { border-color: #fe2c55; }
  .stats {
    margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,.08);
    color: #8b93a5; font-size: 12px; line-height: 1.8;
  }
  .stats b { color: #e8eaef; font-weight: 600; }
  .btn {
    padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 12px;
    background: rgba(255,255,255,.08); color: #d8dce6; border: 1px solid rgba(255,255,255,.1);
  }
  .btn:hover { background: rgba(255,255,255,.14); }
  .hint { color: #6d7484; font-size: 11px; }
  `;
}

/* 面板定位：优先放按钮右侧，空间不够翻到左侧；上下夹在视口内。
 * 必须做成全局函数并在视口变化时重算——全屏切换时 innerHeight 会变，
 * 只在点击时算一次的话位置还是按旧视口算的，面板就偏出屏幕。 */
function placePanel() {
  if (!panel || panel.hidden || !hostEl) return;
  const fab = hostEl.shadowRoot && hostEl.shadowRoot.querySelector('.fab');
  if (!fab) return;
  const fr = fab.getBoundingClientRect();
  const pw = 434;
  const gap = 12;
  const ph = Math.min(panel.scrollHeight || 600, window.innerHeight * 0.84);

  // 左右：右侧有空间就用右侧，否则翻到左侧
  let left = fr.right + gap;
  if (left + pw > window.innerWidth - 12) left = fr.left - pw - gap;
  left = Math.min(Math.max(left, 12), Math.max(window.innerWidth - pw - 12, 12));

  // 上下：默认与按钮顶对齐，超出则夹紧
  let top = fr.top - 8;
  top = Math.min(Math.max(top, 12), Math.max(window.innerHeight - ph - 12, 12));

  panel.style.left = Math.round(left) + 'px';
  panel.style.top = Math.round(top) + 'px';
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
}

/* ---------- 保证「净」按钮常显 ----------
 * 网页全屏（Y 键 / 播放器全屏按钮）时，浏览器把 document.fullscreenElement
 * 提到独立合成层，普通兄弟节点无论 z-index 多高都会被压在它下面
 * （z-index:2147483647 / opacity:1 / transform:none 全部无效）。
 * 唯一解法：把宿主搬进全屏元素内部，成为它的子节点。
 */
function keepFabVisible() {
  if (!hostEl) return;
  const restore = () => {
    const fe = document.fullscreenElement || document.webkitFullscreenElement;
    const target = fe || document.body || document.documentElement;
    if (hostEl.parentElement !== target || target.lastElementChild !== hostEl) {
      target.appendChild(hostEl);
    }
    const st = hostEl.style;
    st.setProperty('display', 'block', 'important');
    st.setProperty('visibility', 'visible', 'important');
    st.setProperty('opacity', '1', 'important');
    st.setProperty('position', 'fixed', 'important');
    st.setProperty('left', '0', 'important');
    st.setProperty('top', '0', 'important');
    st.setProperty('right', 'auto', 'important');
    st.setProperty('bottom', 'auto', 'important');
    // 用 innerWidth/Height 而不是 100vw/vh：全屏切换时 vw/vh 可能对不上真实视口
    st.setProperty('width', window.innerWidth + 'px', 'important');
    st.setProperty('height', window.innerHeight + 'px', 'important');
    st.setProperty('z-index', '2147483647', 'important');
    st.setProperty('pointer-events', 'none', 'important');
  };

  // 视口变小（退出全屏）时把按钮夹回可视区，否则会停在屏幕外
  const clampFab = () => {
    const f = hostEl.shadowRoot && hostEl.shadowRoot.querySelector('.fab');
    if (!f) return;
    const right = parseInt(f.style.right, 10);
    const bottom = parseInt(f.style.bottom, 10);
    if (!Number.isFinite(right) || !Number.isFinite(bottom)) return;
    const maxR = Math.max(4, window.innerWidth - 48);
    const maxB = Math.max(4, window.innerHeight - 48);
    const nr = Math.min(Math.max(right, 4), maxR);
    const nb = Math.min(Math.max(bottom, 4), maxB);
    if (nr !== right) f.style.right = nr + 'px';
    if (nb !== bottom) f.style.bottom = nb + 'px';
  };

  const tick = () => { restore(); clampFab(); placePanel(); };
  tick();
  // 防重入：IPC 全屏事件每次进出全屏都会调 keepFabVisible()，
  // 不拦的话 setInterval / 事件监听会无限叠加，越用越卡
  if (keepFabVisible._started) return;
  keepFabVisible._started = true;
  // 100ms：网页全屏时抖音会重建 DOM，慢了会有可见闪烁
  setInterval(tick, 100);
  window.addEventListener('resize', tick);
  document.addEventListener('fullscreenchange', tick);
  document.addEventListener('webkitfullscreenchange', tick);
}

function buildPanel() {
  hostEl = document.createElement('div');
  hostEl.id = 'dy-desk-host';
  /* fixed + 显式 px 尺寸：不用 100vw/100vh（全屏切换瞬间 vw/vh 对不上真实视口），
   * 也不用 position:relative（空 div 高度会塌成 0，fixed 子元素失去参照） */
  hostEl.style.cssText =
    'all:initial;position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647;';
  const sizeHost = () => {
    hostEl.style.setProperty('width', window.innerWidth + 'px', 'important');
    hostEl.style.setProperty('height', window.innerHeight + 'px', 'important');
  };
  sizeHost();
  window.addEventListener('resize', sizeHost);
  const shadow = hostEl.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = css();
  shadow.appendChild(style);

  const fab = document.createElement('div');
  fab.className = 'layer fab';
  fab.textContent = '净';
  fab.title = '过滤设置（Alt+S）｜可拖动';
  fab.addEventListener('click', () => {
    if (fab._dragged) { fab._dragged = false; return; }
    panel.hidden = !panel.hidden;
    fab.classList.toggle('on', !panel.hidden);
    if (!panel.hidden) {
      updatePanel();
      placePanel();
    }
  });

  // 拖动：位置存 localStorage，全屏时也能拖到想放的地方
  if (CFG.fabPos) {
    fab.style.right = CFG.fabPos.right + 'px';
    fab.style.bottom = CFG.fabPos.bottom + 'px';
  }
  let drag = null;
  fab.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    drag = {
      x: e.clientX,
      y: e.clientY,
      right: parseInt(fab.style.right || 18, 10),
      bottom: parseInt(fab.style.bottom || 18, 10),
      moved: false,
    };
    fab.classList.add('dragging');
    e.preventDefault();
    e.stopPropagation();
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = drag.x - e.clientX;
    const dy = drag.y - e.clientY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    const maxR = window.innerWidth - 46;
    const maxB = window.innerHeight - 46;
    const r = Math.min(Math.max(drag.right + dx, 4), maxR);
    const b = Math.min(Math.max(drag.bottom + dy, 4), maxB);
    fab.style.right = r + 'px';
    fab.style.bottom = b + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    fab.classList.remove('dragging');
    if (drag.moved) {
      fab._dragged = true;
      CFG.fabPos = {
        right: parseInt(fab.style.right || 18, 10),
        bottom: parseInt(fab.style.bottom || 18, 10),
      };
      saveConfig(CFG);
    }
    drag = null;
  });

  const p = document.createElement('div');
  p.className = 'layer panel';
  p.hidden = true;

  const swHtml = ROWS.map(
    ([key, title, desc]) =>
      `<div class="row">
         <label for="sw-${key}"><b>${title}</b><small>${desc}</small></label>
         <input class="sw" type="checkbox" id="sw-${key}" data-key="${key}">
       </div>`
  ).join('');

  p.innerHTML = `
    <div class="head">
      <div class="ttl">
        <h3>推荐流过滤</h3>
        <div class="sub">开关即改即生效，配置保存在本机</div>
      </div>
      <button class="x" id="btnClose" title="关闭">×</button>
    </div>
    <div class="body">
      <div class="current">
        <div class="t">当前视频</div>
        <div class="n" id="curName">正在读取…</div>
        <div class="d" id="curDesc"></div>
        <div class="acts">
          <button class="btn danger" id="btnBlock">拉黑此作者</button>
          <button class="btn" id="btnMark">标记本条为广告</button>
        </div>
      </div>
      ${swHtml}
      <div class="field">
        <label>关键词屏蔽 <b>英文逗号分隔，匹配文案 / 作者 / 音乐</b></label>
        <input id="kw" type="text" placeholder="例如：带货, 直播回放, 某某某">
      </div>
      <div class="field">
        <label>点赞数下限 <b>低于此值不展示，0 = 关闭</b></label>
        <input id="minLikes" type="number" min="0" step="100" placeholder="0">
      </div>
      <div class="stats" id="stats"></div>
    </div>
    <div class="foot">
      <span class="hint">Alt+S 开关面板 · 拖动「净」可移位</span>
      <button class="btn" id="reset">恢复默认</button>
    </div>
  `;

  shadow.appendChild(fab);
  shadow.appendChild(p);
  // 必须挂 body：挂在 html 上，窗口全屏时会被 body 的沉浸式合成压住
  (document.body || document.documentElement).appendChild(hostEl);

  panel = p;

  // 叉号：关闭面板
  shadow.getElementById('btnClose').addEventListener('click', (e) => {
    e.stopPropagation();
    panel.hidden = true;
    fab.classList.remove('on');
  });

  for (const [key] of ROWS) {
    const el = shadow.getElementById('sw-' + key);
    el.checked = !!CFG[key];
    el.addEventListener('change', () => {
      CFG[key] = el.checked;
      saveConfig(CFG);
      if (key === 'hideHeader') {
        applyHideHeader();
        if (el.checked) startHideMsgPatch();
        else {
          // 关掉开关：把已隐藏的贴片恢复出来（只恢复文字节点对应的容器，不误伤全屏容器）
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let n;
          const restore = [];
          while ((n = walker.nextNode())) {
            if (!MSG_RE.test((n.nodeValue || '').trim())) continue;
            const el2 = n.parentElement;
            if (el2 && el2.parentElement) restore.push(el2.parentElement);
          }
          for (const t of restore) t.style.removeProperty('display');
        }
      }
      if (key === 'autoFullscreen') {
        if (el.checked) {
          // 手动打开：立刻起探测（start 时的那套已经跑完或不存在的场景）
          autoFs.done = false;
          autoFs.tries = 0;
          clearInterval(autoFs.timer);
          autoFs.timer = setInterval(tryAutoFullscreen, 1500);
          tryAutoFullscreen();
        } else {
          clearInterval(autoFs.timer);
          toast('已关闭自动全屏，不会自动进入');
        }
      }
      updatePanel();
    });
  }

  const kw = shadow.getElementById('kw');
  kw.value = (CFG.keywords || []).join(', ');
  kw.addEventListener('change', () => {
    CFG.keywords = kw.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    saveConfig(CFG);
  });

  const ml = shadow.getElementById('minLikes');
  ml.value = CFG.minLikes || 0;
  ml.addEventListener('change', () => {
    CFG.minLikes = Math.max(0, Number(ml.value) || 0);
    saveConfig(CFG);
  });

  shadow.getElementById('reset').addEventListener('click', () => {
    Object.assign(CFG, DEFAULTS);
    saveConfig(CFG);
    for (const [key] of ROWS) shadow.getElementById('sw-' + key).checked = !!CFG[key];
    kw.value = '';
    ml.value = 0;
    updatePanel();
    toast('已恢复默认设置');
  });

  // 当前视频操作
  shadow.getElementById('btnBlock').addEventListener('click', () => {
    const it = currentItem();
    if (!it || !it.authorUid) { toast('没拿到作者 uid'); return; }
    if (!CFG.blockAuthors.includes(it.authorUid)) CFG.blockAuthors.push(it.authorUid);
    saveConfig(CFG);
    toast(`已拉黑 ${it.author || it.authorUid}`);
    lastSeenId = '';
    goNext();
  });

  shadow.getElementById('btnMark').addEventListener('click', () => {
    const it = currentItem();
    if (!it) { toast('没拿到视频 id'); return; }
    if (!CFG.blockAwemes.includes(it.id)) CFG.blockAwemes.push(it.id);
    saveConfig(CFG);
    toast('已标记，同一条不会再看');
    lastSeenId = '';
    goNext();
  });


  refreshCurrent();
}

/** 刷新面板里的「当前视频」信息 */
function refreshCurrent() {
  const root = hostEl && hostEl.shadowRoot;
  if (!root) return;
  const nameEl = root.getElementById('curName');
  const descEl = root.getElementById('curDesc');
  if (!nameEl) return;
  const it = currentItem();
  const name = it
    ? `${it.author || '未知作者'}${it.digg ? '  ·  ' + it.digg + ' 赞' : ''}`
    : '未识别到当前视频';
  const desc = it ? (it.desc || '(无文案)').slice(0, 80) : '';
  if (nameEl.textContent !== name) nameEl.textContent = name;
  if (descEl.textContent !== desc) descEl.textContent = desc;
}

function updatePanel() {
  if (!panel || panel.hidden) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const box = hostEl && hostEl.shadowRoot && hostEl.shadowRoot.getElementById('stats');
    if (!box) return;
    // 命中原因的英文 key 翻成人话（含角标兜底的 dom: 前缀复合 key）
    const REASON_CN = {
      ad: '广告', live: '直播间', shop: '带货', shopping: '带货', life: '团购',
      anchor: '挂载锚点', likes: '点赞不足', keyword: '关键词',
      author: '拉黑作者', dom: '角标兜底',
      'dom:ad': '角标·广告', 'dom:live': '角标·直播间', 'dom:shopping': '角标·带货',
    };
    const reasons = Object.entries(stats.byReason)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `${REASON_CN[k] || k} ${v}`)
      .join(' · ');
    box.innerHTML =
      `数据层：已检查 <b>${stats.apiSeen}</b> 条，剔除 <b>${stats.apiDropped}</b> 条<br>` +
      `角标兜底：已检查 <b>${stats.domChecked}</b> 条，跳过 <b>${stats.domSkipped}</b> 条` +
      (reasons ? `<br>剔除原因：${reasons}` : '');
  }, 300);
}

/* =========================================================
   快捷键
   ========================================================= */

function bindHotkeys() {
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    /* shadow DOM 里的输入框（面板的关键词/点赞框）冒泡到 window 时
     * target 被 retarget 成 host div，上面的检查拦不住——
     * 用 composedPath 拿真实 target 再查一次，否则在面板里打 f/j 会切全屏/切视频 */
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const real = path[0];
    if (real && real !== t && (real.tagName === 'INPUT' || real.tagName === 'TEXTAREA' || real.isContentEditable)) return;

    if (e.altKey && (e.key === 's' || e.key === 'S')) {
      if (panel) panel.hidden = !panel.hidden;
      if (panel && !panel.hidden) {
        updatePanel();
        placePanel();
      }
      // 按钮高亮与面板状态同步
      const fab = hostEl && hostEl.shadowRoot && hostEl.shadowRoot.querySelector('.fab');
      if (fab) fab.classList.toggle('on', panel ? !panel.hidden : false);
      e.preventDefault();
      return;
    }
    if (e.key === 'f' || e.key === 'F') {
      // 真窗口全屏（等价 F11）。渲染层 requestFullscreen 只是把 html 撑满窗口，
      // 不去标题栏、不盖任务栏，不是 F11 —— 必须走主进程 setFullScreen
      if (window.__dyMain && window.__dyMain.toggleFullScreen) {
        window.__dyMain.toggleFullScreen();
      } else if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        document.documentElement.requestFullscreen();
      }
      e.preventDefault();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;

    // J/K 上下切换（也兼容方向键）
    if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown') {
      goNext();
      e.preventDefault();
      return;
    }
    if (e.key === 'k' || e.key === 'K' || e.key === 'ArrowUp') {
      goPrev();
      e.preventDefault();
      return;
    }
    // 空格暂停
    if (e.key === ' ') {
      togglePlay();
      e.preventDefault();
      return;
    }
    // [ ] 调速
    if (e.key === '[') { changeRate(-0.25); e.preventDefault(); return; }
    if (e.key === ']') { changeRate(0.25); e.preventDefault(); return; }
    // 0 恢复 1x
    if (e.key === '0') {
      const v = document.querySelector('video');
      if (v) { v.playbackRate = 1; toast('倍速 1x'); }
      e.preventDefault();
    }
  }, true);
}

/* =========================================================
   启动
   ========================================================= */

/* ---------- 纯净模式：去掉全屏下的残留 UI ---------- */
let headerStyle = null;

function applyHideHeader() {
  if (!headerStyle) {
    headerStyle = document.createElement('style');
    document.head.appendChild(headerStyle);
  }
  const on = !!CFG.hideHeader;
  document.documentElement.dataset.hideheader = on ? '1' : '0';
  headerStyle.textContent = `
    /* 搜索框容器：用精确层级匹配第 4 层 div 父级（含左上角关闭按钮）。
       不能去掉层级限制——否则会匹配到 body 下所有祖先，整页消失 */
    html[data-hideheader="1"] div:has(> div > div > div > div > [data-e2e="searchbar-input"]) { display: none !important; }
    /* 右上角消息入口 */
    html[data-hideheader="1"] li:has([data-e2e="im-entry"]) { display: none !important; }
    html[data-hideheader="1"] [data-e2e="im-entry"] { display: none !important; }
  `;
}

/* ---------- 隐藏「消息 (N)」私信引导贴片 ----------
 * 全屏时每个视频自带一个「∇ 消息 (N)」贴片，没有稳定选择器（类名是随机 hash），
 * 只能按文字定位后设 inline style（试过加 class + CSS 规则，不生效）。
 * 结构：SPAN(文字) → DIV(贴片容器，约 107x40) → 全屏容器。
 * 往上只找一层，再多找会撞上全屏容器反而藏不掉。
 * 用 MutationObserver + 兜底轮询：swiper 会复用 DOM 节点，贴片常是
 * 「先插入 DOM、后填充文字」，单靠 childList 监听会漏。
 */
const MSG_RE = /^消息 \(\d+\)$/;

function hideMsgPatch(root) {
  if (!CFG.hideHeader || !root || !root.querySelectorAll) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const t = (node.nodeValue || '').trim();
    if (!MSG_RE.test(t)) continue;
    const el = node.parentElement;
    if (!el || el.offsetWidth === 0) continue;
    const target = el.parentElement;   // SPAN 的父 DIV 才是贴片容器
    if (!target || target.style.display === 'none') continue;
    target.style.setProperty('display', 'none', 'important');
  }
}

let msgPatchStarted = false;

function startHideMsgPatch() {
  if (msgPatchStarted) return;   // 防止重复注册 observer / interval
  msgPatchStarted = true;
  hideMsgPatch(document);
  // DOM 增删 + 文字变化都听：贴片常是先插入容器、后填充文字
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) hideMsgPatch(n);
      }
      if (m.type === 'characterData' && m.target.parentElement) {
        hideMsgPatch(m.target.parentElement);
      }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  // 兜底：swiper 复用节点时文字变化不一定触发观察器
  setInterval(() => hideMsgPatch(document), 2500);
}

/* ---------- 自动网页全屏 ----------
 * 只派发 Y 键的键盘事件（抖音网页版原生全屏快捷键）。
 * 不用坐标点击、不用 CSS 兜底 —— 之前两种都出过问题：
 *   坐标点击会误触旁边的广告链接，弹 bitbrowser:// 系统对话框；
 *   CSS 铺满会破坏 swiper / xgplayer 的内部布局。
 * 用就绪检测 + 效果验证 + 有限重试，避免页面没加载完就白发一次。
 */
const autoFs = { done: false, tries: 0, timer: null };

function isFullscreen() {
  const p = document.querySelector('.xgplayer');
  if (!p) return false;
  return p.offsetWidth > window.innerWidth * 0.92;
}

function pressY() {
  const opts = { key: 'y', code: 'KeyY', keyCode: 89, which: 89, bubbles: true, cancelable: true };
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', opts)), 50);
  } catch (e) { /* 忽略 */ }
}

function tryAutoFullscreen() {
  if (autoFs.done || !CFG.autoFullscreen) return;

  // 已经全屏了就收工（可能用户自己按了 Y）
  if (isFullscreen()) {
    autoFs.done = true;
    clearInterval(autoFs.timer);
    console.log('[dy] 已是网页全屏，跳过自动触发');
    return;
  }

  // 推荐流还没渲染出来，抖音收不到 Y，等下一轮
  if (!document.querySelector('[data-e2e="feed-active-video"]')) return;

  if (autoFs.tries >= 5) {
    clearInterval(autoFs.timer);
    console.warn('[dy] 自动网页全屏未生效（已试 5 次），手动按 Y 即可');
    return;
  }

  autoFs.tries++;
  pressY();
  console.log(`[dy] 触发网页全屏 Y 键（第 ${autoFs.tries} 次）`);

  // 1.2 秒后检查效果
  setTimeout(() => {
    if (isFullscreen()) {
      autoFs.done = true;
      clearInterval(autoFs.timer);
      console.log('[dy] 自动网页全屏成功');
    }
  }, 1200);
}

/* ---------- 播放状态自愈 ----------
 * 偶发：切换几次后播放中的 video 跑到视口外（有声音没画面）。
 * 每 3 秒检测一次：播放中的有媒体 video 不在视口内，就把播放切给视口内的那个。
 * 只改播放状态，不碰任何页面样式。
 */
function playStateHeal() {
  const vs = [...document.querySelectorAll('video')];
  const playing = vs.find((v) => !v.paused && v.videoWidth > 0);
  if (!playing) return;
  const r = playing.getBoundingClientRect();
  if (r.top >= -10 && r.bottom <= innerHeight + 10) return;
  const inView = vs.find((v) => {
    if (v === playing || v.videoWidth === 0) return false;
    const vr = v.getBoundingClientRect();
    return vr.top >= -10 && vr.bottom <= innerHeight + 10;
  });
  if (!inView) return;
  try {
    playing.pause();
    inView.play().catch(() => {});
    console.log('[dy] 自愈：播放状态与视口错位，已切换');
  } catch (e) {}
}

/* ---------- Service Worker 兜底 ----------
 * 抖音有 Service Worker，部分 feed 响应直接从 SW 缓存返回，不过 XHR/fetch，
 * 那样数据层拦截会漏掉。这里监听 SW 发出的消息做二次过滤。
 */
function patchServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    // 常见形态：{ type: 'feed', body: {...} } 或直接带 aweme_list
    const body = data.body || data.payload || data;
    if (body && Array.isArray(body.aweme_list)) {
      if (filterBody(body)) {
        try { navigator.serviceWorker.controller.postMessage({ type: 'dy-filtered', body }); } catch (e) {}
      }
    }
  });
}

function start() {
  applyHideHeader();
  if (CFG.hideHeader) startHideMsgPatch();
  setInterval(playStateHeal, 3000);
  patchXHR();
  patchFetch();
  patchServiceWorker();
  bindHotkeys();
  buildPanel();
  keepFabVisible();
  setInterval(domTick, 400);

  // 自动网页全屏：2 秒后开始探测，每 1.5 秒试一次，最多 5 次
  if (CFG.autoFullscreen) {
    setTimeout(() => {
      autoFs.timer = setInterval(tryAutoFullscreen, 1500);
      tryAutoFullscreen();
    }, 2000);
  }

  console.log(
    `[dy] 已启动 | 数据层剔除: ${CFG.dropAds ? '广告 ' : ''}${CFG.dropLive ? '直播 ' : ''}` +
    `${CFG.dropShop ? '带货 ' : ''}${CFG.dropLife ? '团购 ' : ''}` +
    `${CFG.autoFullscreen ? ' | 自动全屏开' : ''} | Alt+S 打开设置`
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}

// 调试出口
window.__dy = { CFG, stats, dropReason, filterBody, domDetect, domTick, updatePanel, currentItem, RECENT };
