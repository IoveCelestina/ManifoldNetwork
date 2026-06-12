/* Manifold · 对话与生图 demo
 *
 * 所有请求同源：/api/v1/* → sub2api 用户接口（JWT），/v1/* → sub2api 网关（API Key）。
 * 会话存 IndexedDB（base64 图片太大，localStorage 放不下）。
 */
'use strict';

const $ = (id) => document.getElementById(id);
const UPSTREAM = (window.__CHAT_CONFIG__ && window.__CHAT_CONFIG__.upstream) || '(未配置)';

const LS_AUTH = 'mfchat_auth';
const LS_KEY = 'mfchat_key';
const LS_MODEL = 'mfchat_model';

const IMAGE_MODEL_PREFIX = 'gpt-image';
const FALLBACK_IMAGE_MODEL = 'gpt-image-2';
const MAX_ATTACH = 4;
const ATTACH_MAX_EDGE = 1568;

/* ───────────────────────── 状态 ───────────────────────── */

const state = {
  auth: loadJSON(LS_AUTH),          // {access_token, refresh_token, expires_at, user}
  apiKey: loadJSON(LS_KEY),         // {key, label}
  convs: [],                        // 会话元数据+消息（内存镜像，源在 IndexedDB）
  currentId: null,
  models: [],
  attachments: [],                  // [{dataUrl}]
  streaming: null,                  // AbortController | null
  keysCache: null,                  // 账户 key 列表缓存
};

function loadJSON(k) {
  try { return JSON.parse(localStorage.getItem(k)); } catch { return null; }
}
function saveJSON(k, v) {
  if (v === null || v === undefined) localStorage.removeItem(k);
  else localStorage.setItem(k, JSON.stringify(v));
}

/* ───────────────────────── IndexedDB ───────────────────────── */

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('manifold-chat', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('conv', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
async function idbAll() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction('conv').objectStore('conv').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(conv) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('conv', 'readwrite');
    tx.objectStore('conv').put(conv);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 写入事务被中止'));
  });
}
async function idbDel(id) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('conv', 'readwrite');
    tx.objectStore('conv').delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 删除事务被中止'));
  });
}
async function idbClear() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('conv', 'readwrite');
    tx.objectStore('conv').clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 清空事务被中止'));
  });
}

/* ───────────────────── 会话存储抽象（登录→后端同步 / 否则→本地 IndexedDB） ───────────────────── */

// 账号密码登录 → 走后端 /store/*；keyonly 或未登录 → 走本地 IndexedDB（离线/免登录不受影响）。
function useServer() { return !!state.auth?.access_token; }

// 只把要持久化的字段发后端，剔除 _loading 等运行时标记
function serializeConv(conv) {
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messages: Array.isArray(conv.messages) ? conv.messages : [],
  };
}

// 调本服务的 /store/*：带 sub2api token；401 时复用 tryRefresh 刷新后重试一次
async function storeFetch(path, opts = {}, retried = false) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (state.auth?.access_token) headers['Authorization'] = `Bearer ${state.auth.access_token}`;
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (res.status === 401 && state.auth?.refresh_token && !retried) {
    if (!refreshPromise) refreshPromise = tryRefresh().finally(() => { refreshPromise = null; });
    if (await refreshPromise) return storeFetch(path, opts, true);
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j?.error?.message || j?.message || msg; } catch { /* 非 JSON */ }
    throw new Error(msg);
  }
  try { return await res.json(); } catch { return null; }
}

const store = {
  async list() {
    if (useServer()) {
      const data = await storeFetch('/store/conversations');
      // 列表仅元数据；messages 置 null 标记「未加载」，打开会话时再拉
      return (data?.conversations || []).map((c) => ({ ...c, messages: null }));
    }
    return await idbAll();
  },
  async get(id) {
    if (useServer()) return await storeFetch(`/store/conversations/${encodeURIComponent(id)}`);
    return state.convs.find((c) => c.id === id) || null;
  },
  async put(conv) {
    if (useServer()) {
      await storeFetch(`/store/conversations/${encodeURIComponent(conv.id)}`, {
        method: 'PUT', body: JSON.stringify(serializeConv(conv)),
      });
      return;
    }
    await idbPut(conv);
  },
  async del(id) {
    if (useServer()) { await storeFetch(`/store/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }); return; }
    await idbDel(id);
  },
};

// 按需加载：把某会话 messages 从后端补全（本地模式或已加载则直接返回）
async function ensureMessages(conv) {
  if (!conv || Array.isArray(conv.messages)) return;
  if (!useServer()) { conv.messages = []; return; }
  try {
    const full = await store.get(conv.id);
    conv.messages = (full && full.messages) || [];
  } catch (e) {
    conv.messages = [];
    console.warn('加载会话正文失败', e);
  }
}

// 切到某会话并确保正文已加载（流式中不切，避免写串）
async function openConv(id) {
  if (state.streaming) return;
  state.currentId = id;
  renderConvList();
  renderMessages();                       // 立即反馈（messages 为 null 时显示「载入中」）
  const conv = currentConv();
  if (conv && !Array.isArray(conv.messages)) {
    await ensureMessages(conv);
    if (state.currentId === id) renderMessages();
  }
}

// 统一加载会话列表（按 useServer 选后端/本地），并设好 currentId
async function loadConversations() {
  try {
    const all = await store.list();
    state.convs = all.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (e) {
    console.warn('加载会话列表失败', e);
    state.convs = [];
  }
  state.currentId = state.convs[0]?.id || null;
}

// 老数据迁移：首次进入 server 模式时，若本机 IndexedDB 还存着对话，问一次是否导入到账号
let migrating = false;
async function maybeMigrateLocal() {
  if (migrating || !useServer()) return;
  if (localStorage.getItem('mfchat_migrated')) return;
  let local = [];
  try { local = await idbAll(); } catch { return; }
  localStorage.setItem('mfchat_migrated', '1');   // 标记一次，避免反复打扰（即便用户拒绝）
  if (!local.length) return;
  if (!confirm(`检测到本机有 ${local.length} 个本地对话，导入到当前账号并云端同步？\n（导入后会从本机移除本地副本）`)) return;
  migrating = true;
  let done = 0;
  for (const conv of local) {
    try { await store.put(conv); done++; } catch (e) { console.warn('迁移失败', conv.id, e); }
  }
  try { await idbClear(); } catch { /* 清本地失败不致命 */ }
  await loadConversations();
  migrating = false;
  if (state.currentId) openConv(state.currentId); else { renderConvList(); renderMessages(); }
  alert(`已导入 ${done}/${local.length} 个对话。`);
}

/* ───────────────────────── sub2api 用户接口（JWT + envelope） ───────────────────────── */

function unwrap(json) {
  // sub2api 业务接口返回 {code, message, data}；也兼容直接裸返回
  if (json && typeof json === 'object' && 'code' in json) {
    const ok = json.code === 0 || json.code === 200 || json.success === true;
    if (!ok) throw new Error(json.message || `接口错误 code=${json.code}`);
    return json.data;
  }
  return json;
}

async function apiFetch(path, opts = {}, retried = false) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (state.auth?.access_token) headers['Authorization'] = `Bearer ${state.auth.access_token}`;
  const res = await fetch(path, Object.assign({}, opts, { headers }));

  if (res.status === 401 && state.auth?.refresh_token && !retried) {
    // 并发 401 共享同一次刷新，避免刷新风暴（refresh_token 可能轮换，二连发会互相打废）
    if (!refreshPromise) {
      refreshPromise = tryRefresh().finally(() => { refreshPromise = null; });
    }
    const ok = await refreshPromise;
    if (ok) return apiFetch(path, opts, true);
    setAuth(null);
    setApiKey(null);                 // 换账号重登前清掉上一个账号的 key，避免跨账号误用其额度
    state.convs = [];
    state.currentId = null;
    idbClear().catch(() => {});
    showLogin('登录已过期，请重新登录');
    throw new Error('登录已过期');
  }

  let json = null;
  try { json = await res.json(); } catch { /* 空 body */ }
  if (!res.ok) {
    const msg = json?.message || json?.error?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return unwrap(json);
}

let refreshPromise = null;

async function tryRefresh() {
  // 入口处快照：刷新期间用户可能登出把 state.auth 清掉
  const auth = state.auth;
  if (!auth?.refresh_token) return false;
  try {
    const res = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: auth.refresh_token }),
    });
    if (!res.ok) return false;
    const data = unwrap(await res.json());
    if (!data?.access_token) return false;
    if (state.auth !== auth) return false; // 中途已登出，丢弃刷新结果
    setAuth(Object.assign({}, auth, {
      access_token: data.access_token,
      refresh_token: data.refresh_token || auth.refresh_token,
    }));
    return true;
  } catch { return false; }
}

function setAuth(auth) {
  state.auth = auth;
  saveJSON(LS_AUTH, auth);
}
function setApiKey(key, label) {
  state.apiKey = key ? { key, label: label || maskKey(key) } : null;
  saveJSON(LS_KEY, state.apiKey);
  renderKeyChip();
}
function maskKey(k) {
  if (!k) return '';
  return k.length <= 12 ? k : `${k.slice(0, 7)}…${k.slice(-4)}`;
}

/* ───────────────────────── 登录视图 ───────────────────────── */

function showLogin(err) {
  $('view-login').classList.remove('hidden');
  $('view-app').classList.add('hidden');
  loginError(err || null);
  $('login-form').classList.remove('hidden');
  $('totp-form').classList.add('hidden');
}
function showApp() {
  $('view-login').classList.add('hidden');
  $('view-app').classList.remove('hidden');
  renderMe();
  renderKeyChip();
  loadModels();
  if (!state.currentId) state.currentId = state.convs[0]?.id || null;
  if (state.currentId) {
    openConv(state.currentId);            // 渲染 + 按需加载正文
  } else {
    renderConvList();
    renderMessages();
  }
  if (state.auth) loadAccountKeys().catch(() => {});
}
function loginError(msg) {
  const el = $('login-error');
  if (!msg) { el.classList.add('hidden'); return; }
  el.textContent = msg;
  el.classList.remove('hidden');
}

let pendingTempToken = null;

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError(null);
  const btn = $('login-submit');
  btn.disabled = true; btn.textContent = '登录中…';
  try {
    const data = await apiFetch('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('login-email').value.trim(), password: $('login-password').value }),
    });
    if (data?.temp_token && !data?.access_token) {
      pendingTempToken = data.temp_token;
      $('login-form').classList.add('hidden');
      $('totp-form').classList.remove('hidden');
      $('totp-code').focus();
    } else {
      await finishLogin(data);
    }
  } catch (err) {
    loginError(err.message);
  } finally {
    btn.disabled = false; btn.textContent = '登 录';
  }
});

$('totp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError(null);
  try {
    const data = await apiFetch('/api/v1/auth/login/2fa', {
      method: 'POST',
      body: JSON.stringify({ temp_token: pendingTempToken, totp_code: $('totp-code').value.trim() }),
    });
    await finishLogin(data);
  } catch (err) {
    loginError(err.message);
  }
});

$('totp-back').addEventListener('click', () => {
  pendingTempToken = null;
  $('totp-form').classList.add('hidden');
  $('login-form').classList.remove('hidden');
});

async function finishLogin(data) {
  if (!data?.access_token) throw new Error('登录响应里没有 access_token');
  setAuth({
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    user: data.user || null,
  });
  await loadConversations();               // 切到该账号的服务端对话
  // 登录成功 → 自动拉账户下的 key；有且只有一个时直接用
  try {
    const keys = await loadAccountKeys();
    const usable = keys.filter((k) => k.key);
    if (!state.apiKey && usable.length === 1) setApiKey(usable[0].key, usable[0].name);
  } catch { /* key 拉取失败不阻塞进入 */ }
  showApp();
  maybeMigrateLocal();
  if (!state.apiKey) openSettings();
}

$('keyonly-toggle').addEventListener('click', () => {
  $('keyonly-form').classList.toggle('hidden');
  $('keyonly-input').focus();
});
$('keyonly-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const k = $('keyonly-input').value.trim();
  if (!k) return;
  setApiKey(k);
  await loadConversations();
  showApp();
});

$('btn-logout').addEventListener('click', () => {
  if (state.streaming) {
    state.streaming.abort();
    state.streaming = null;
  }
  if (state.auth?.refresh_token) {
    fetch('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.auth.access_token}` },
      body: JSON.stringify({ refresh_token: state.auth.refresh_token }),
    }).catch(() => {});
  }
  setAuth(null);
  setApiKey(null);
  state.keysCache = null;
  state.convs = [];
  state.currentId = null;
  idbClear().catch(() => {});      // 清本地缓存的会话，避免共享设备泄露（账号数据在服务端，不受影响）
  showLogin();
});

/* ───────────────────────── 账户 key 管理 ───────────────────────── */

async function loadAccountKeys() {
  if (!state.auth) return [];
  const [keysData, groupsData] = await Promise.all([
    apiFetch('/api/v1/keys?page=1&page_size=100'),
    apiFetch('/api/v1/groups/available').catch(() => null),
  ]);
  const arr = Array.isArray(keysData) ? keysData
    : keysData?.items || keysData?.list || keysData?.keys || [];
  const groups = Array.isArray(groupsData) ? groupsData
    : groupsData?.items || groupsData?.list || groupsData?.groups || [];
  const platformByGroup = {};
  for (const g of groups) {
    if (g && g.id !== undefined) platformByGroup[g.id] = g.platform || '';
  }
  const keys = arr.map((k) => ({
    id: k.id,
    key: k.key || '',
    name: k.name || `key-${k.id}`,
    platform: platformByGroup[k.group_id] || k.platform || k.group?.platform || '',
    status: k.status,
  }));
  // openai 平台的排前面（聊天+识图+生图一个 key 全搞定）
  keys.sort((a, b) => (b.platform === 'openai') - (a.platform === 'openai'));
  state.keysCache = keys;
  renderKeyList();
  return keys;
}

const SVG_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const SVG_PENCIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';

function makeKeyRow(k, active) {
  const plat = (k.platform || '').toLowerCase();
  const known = plat === 'openai' || plat === 'anthropic' || plat === 'gemini';
  const row = document.createElement('button');
  row.className = 'sx-key is-' + (known ? plat : 'other') + (k.key && k.key === active ? ' selected' : '');
  row.innerHTML =
    '<span class="sx-key-dot"></span>' +
    '<span class="sx-key-main"><span class="sx-key-name"></span><span class="sx-key-id"></span></span>' +
    '<span class="sx-plat' + (known ? ' ' + plat : '') + '"></span>' +
    '<span class="sx-key-check">' + SVG_CHECK + '</span>';
  row.querySelector('.sx-key-name').textContent = k.name;
  row.querySelector('.sx-key-id').textContent = maskKey(k.key);
  row.querySelector('.sx-plat').textContent = plat || '?';
  row.addEventListener('click', () => {
    if (!k.key) return;
    setApiKey(k.key, k.name);
    renderKeyList();
    loadModels();
  });
  return row;
}

function makeManualRow(activeKey) {
  const row = document.createElement('div');
  row.className = 'sx-key is-manual selected';
  row.innerHTML =
    '<span class="sx-key-dot"></span>' +
    '<span class="sx-key-main"><span class="sx-key-name">手动 Key</span><span class="sx-key-id"></span></span>' +
    '<span class="sx-plat manual">' + SVG_PENCIL + '手动</span>' +
    '<span class="sx-key-check">' + SVG_CHECK + '</span>';
  row.querySelector('.sx-key-id').textContent = maskKey(activeKey);
  return row;
}

// 当前生效的 key 永远显示为选中行；来源是手动粘贴（不在账户列表）时，顶部补一行“手动”。
function renderKeyList() {
  const list = $('key-list');
  if (!list) return;
  const hint = $('key-hint');
  const refreshBtn = $('btn-refresh-keys');
  const loggedIn = !!state.auth;

  // 仅 key 模式（未登录）：隐藏账户专属的“刷新”和提示
  if (refreshBtn) refreshBtn.classList.toggle('hidden', !loggedIn);
  if (hint) hint.classList.toggle('hidden', !loggedIn);

  list.innerHTML = '';
  const keys = loggedIn ? (state.keysCache || []) : [];
  const active = state.apiKey?.key || null;
  const activeInList = !!active && keys.some((k) => k.key === active);

  if (active && !activeInList) list.appendChild(makeManualRow(active));

  if (loggedIn && !keys.length) {
    const p = document.createElement('p');
    p.className = 'sx-empty';
    p.textContent = '账户下没有可用的 key，去 sub2api 控制台创建一个。';
    list.appendChild(p);
  }
  for (const k of keys) list.appendChild(makeKeyRow(k, active));

  if (!list.children.length) {
    const p = document.createElement('p');
    p.className = 'sx-empty';
    p.textContent = '还没有设置 key —— 在下方粘贴一个开始。';
    list.appendChild(p);
  }
}

$('btn-refresh-keys').addEventListener('click', () => loadAccountKeys().catch((e) => alert(e.message)));
$('btn-use-key').addEventListener('click', () => {
  const k = $('settings-key-input').value.trim();
  if (!k) return;
  setApiKey(k);
  $('settings-key-input').value = '';
  renderKeyList();
  loadModels();
});

function renderKeyChip() {
  const chip = $('key-chip');
  if (!chip) return;
  if (state.apiKey) {
    chip.textContent = state.apiKey.label || maskKey(state.apiKey.key);
    chip.classList.remove('unset');
  } else {
    chip.textContent = '未设置 Key';
    chip.classList.add('unset');
  }
}

function renderMe() {
  $('me-label').textContent = state.auth?.user?.email || (state.apiKey ? '仅 Key 模式' : '未登录');
}

/* ───────────────────────── 设置弹层 ───────────────────────── */

function openSettings() {
  $('settings-upstream').textContent = UPSTREAM;
  renderKeyList();
  $('settings-mask').classList.remove('hidden');
}
$('key-chip').addEventListener('click', openSettings);
function closeSettings() { $('settings-mask').classList.add('hidden'); }
$('btn-close-settings').addEventListener('click', closeSettings);
$('btn-close-settings-x').addEventListener('click', closeSettings);
$('btn-confirm-settings').addEventListener('click', closeSettings);
$('settings-mask').addEventListener('click', (e) => {
  if (e.target === $('settings-mask')) closeSettings();
});

/* ───────────────────────── 模型 ───────────────────────── */

async function loadModels() {
  const sel = $('model-select');
  if (!state.apiKey) {
    sel.innerHTML = `<option value="${FALLBACK_IMAGE_MODEL}">${FALLBACK_IMAGE_MODEL}</option>`;
    syncComposerMode();
    return;
  }
  let ids = [];
  try {
    const res = await fetch('/v1/models', { headers: { 'Authorization': `Bearer ${state.apiKey.key}` } });
    const json = await res.json();
    if (res.ok) ids = (json.data || []).map((m) => m.id).filter(Boolean).sort();
  } catch { /* 拉不到就用兜底列表 */ }
  if (!ids.includes(FALLBACK_IMAGE_MODEL)) ids.push(FALLBACK_IMAGE_MODEL);
  state.models = ids;

  const saved = localStorage.getItem(LS_MODEL);
  sel.innerHTML = '';
  for (const id of ids) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id.startsWith(IMAGE_MODEL_PREFIX) ? `${id} ✦图` : id;
    sel.appendChild(opt);
  }
  sel.value = saved && ids.includes(saved) ? saved : ids[0];
  syncComposerMode();
}

$('model-select').addEventListener('change', () => {
  localStorage.setItem(LS_MODEL, $('model-select').value);
  syncComposerMode();
});

function currentModel() { return $('model-select').value; }
function isImageMode() { return (currentModel() || '').startsWith(IMAGE_MODEL_PREFIX); }

function syncComposerMode() {
  const img = isImageMode();
  $('composer').classList.toggle('mode-image', img);
  $('imagegen-controls').classList.toggle('hidden', !img);
  $('input-box').placeholder = img ? '描述你想生成的画面…（可附参考图改图）' : '输入消息…';
  if (!state.streaming) $('btn-send').textContent = img ? '生成' : '发送';
  $('composer-hint').textContent = img
    ? '生图模式 · 直接描述 = 文生图 · 附图 = 按参考图改图'
    : 'Enter 发送 · Shift+Enter 换行';
  syncSizeOptions();
}

// 高分尺寸（自定义分辨率）只有文生图 /generations 支持；改图 /edits 接口只认 auto 和三个原生预设。
// 因此带了参考图（改图模式）时禁用所有高分档，只留 auto + 三个原生预设，并把已选高分退回合法尺寸。
const NATIVE_SIZES = new Set(['auto', '1024x1024', '1536x1024', '1024x1536']);
function syncSizeOptions() {
  const sel = $('size-select');
  const editMode = state.attachments.length > 0;
  for (const opt of sel.options) opt.disabled = editMode && !NATIVE_SIZES.has(opt.value);
  if (editMode && !NATIVE_SIZES.has(sel.value)) sel.value = '1024x1024';
}

/* ───────────────────────── 会话 ───────────────────────── */

function newConv() {
  const conv = {
    id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: '新对话',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  state.convs.unshift(conv);
  state.currentId = conv.id;
  renderConvList();
  renderMessages();
  return conv;
}

function currentConv() {
  return state.convs.find((c) => c.id === state.currentId) || null;
}

let quotaWarned = false;
let persistWarned = false;

async function persistConv(conv) {
  conv.updatedAt = Date.now();
  let ok = true;
  try {
    await store.put(conv);
  } catch (e) {
    ok = false;
    console.warn('persist failed', e);
    if (e?.name === 'QuotaExceededError') {
      if (!quotaWarned) {
        quotaWarned = true;
        alert('浏览器存储空间已满，本次对话无法持久保存。\n建议删掉旧对话（特别是含生成图片的），或把重要图片先下载下来。');
      }
    } else if (!persistWarned) {
      // 其它写入失败（后端不可达、事务被中止、隐私模式禁 IndexedDB 等）：本次仍能用，但得让用户知道
      persistWarned = true;
      const where = useServer() ? '未能同步到服务器' : '刷新页面后可能丢失';
      alert(`对话保存失败：${e?.message || e}\n当前对话本次仍可继续，但${where}。`);
    }
  }
  renderConvList();
  return ok;
}

function renderConvList() {
  const nav = $('conv-list');
  nav.innerHTML = '';
  for (const conv of state.convs) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (conv.id === state.currentId ? ' active' : '');
    const title = document.createElement('span');
    title.className = 'conv-item-title';
    title.textContent = conv.title;
    const del = document.createElement('button');
    del.className = 'conv-item-del';
    del.title = '删除对话';
    del.textContent = '×';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (state.streaming) return;    // 流式中不删，避免流结束时 persist 把已删会话写回（复活）
      state.convs = state.convs.filter((c) => c.id !== conv.id);
      await store.del(conv.id).catch(() => {});
      if (state.currentId === conv.id) {
        state.currentId = state.convs[0]?.id || null;
        renderMessages();
      }
      renderConvList();
    });
    item.appendChild(title);
    item.appendChild(del);
    item.addEventListener('click', () => {
      openConv(conv.id);           // 切换 + 按需加载（内部已挡流式）
    });
    nav.appendChild(item);
  }
}

$('btn-new-chat').addEventListener('click', () => {
  if (state.streaming) return;
  newConv();
  $('input-box').focus();
});

/* ───────────────────────── 消息渲染 ───────────────────────── */

function mdRender(text) {
  const raw = marked.parse(text || '', { breaks: true });
  return DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] });
}

function renderMessages() {
  const wrap = $('messages');
  wrap.innerHTML = '';
  const conv = currentConv();
  $('header-title').textContent = conv?.title || '新对话';
  if (conv && !Array.isArray(conv.messages)) {   // 后端正文按需加载中
    wrap.appendChild(buildLoadingState());
    return;
  }
  if (!conv || !conv.messages.length) {
    wrap.appendChild(buildEmptyState());
    return;
  }
  for (const m of conv.messages) wrap.appendChild(buildMsgEl(m));
  scrollToBottom(true);
}

function buildLoadingState() {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.innerHTML = '<p class="empty-title">载入对话中…</p>';
  return div;
}

function buildEmptyState() {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.innerHTML = `
    <svg class="empty-glyph" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="19" fill="none"/>
      <ellipse cx="24" cy="24" rx="19" ry="11" fill="none"/>
      <ellipse cx="24" cy="24" rx="19" ry="4.5" fill="none"/>
    </svg>
    <p class="empty-title">开始一段对话</p>
    <p class="empty-hint">上传图片让模型识图，或在模型选择器里切到
      <button class="inline-link mono">${FALLBACK_IMAGE_MODEL}</button> 描述你想生成的画面</p>`;
  div.querySelector('.inline-link').addEventListener('click', () => {
    const sel = $('model-select');
    const target = state.models.find((m) => m.startsWith(IMAGE_MODEL_PREFIX)) || FALLBACK_IMAGE_MODEL;
    sel.value = target;
    sel.dispatchEvent(new Event('change'));
    $('input-box').focus();
  });
  return div;
}

function buildMsgEl(m) {
  const div = document.createElement('div');
  if (m.role === 'user') {
    div.className = 'msg msg-user';
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = m.text || '';
    if (m.images?.length) body.appendChild(buildImages(m.images, false));
    div.appendChild(body);
  } else if (m.kind === 'error') {
    div.className = 'msg msg-error';
    div.innerHTML = `<div class="msg-role"><span class="msg-role-glyph">✕</span><span class="msg-role-name">错误</span></div>`;
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = m.text || '';
    div.appendChild(body);
  } else {
    div.className = 'msg msg-assistant' + (m.kind === 'image' ? ' is-image' : '');
    div.innerHTML = `<div class="msg-role">
        <span class="msg-role-glyph">${m.kind === 'image' ? '✦' : '∴'}</span>
        <span class="msg-role-name"></span>
      </div>`;
    // 模型名来自 /v1/models 响应，必须走 textContent 防注入
    div.querySelector('.msg-role-name').textContent = m.model || 'assistant';
    const body = document.createElement('div');
    body.className = 'msg-body md';
    body.innerHTML = mdRender(m.text || '');
    if (m.images?.length) body.appendChild(buildImages(m.images, true));
    div.appendChild(body);
  }
  return div;
}

function buildImages(urls, downloadable) {
  const box = document.createElement('div');
  box.className = 'msg-images';
  urls.forEach((u, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'msg-img-wrap';
    const img = document.createElement('img');
    img.src = u;
    img.alt = `图片 ${i + 1}`;
    img.addEventListener('click', () => openLightbox(u));
    wrap.appendChild(img);
    if (downloadable) {
      const a = document.createElement('a');
      a.className = 'img-download';
      a.textContent = '下载';
      a.href = u;
      a.download = `manifold-${Date.now()}-${i + 1}.png`;
      wrap.appendChild(a);
    }
    box.appendChild(wrap);
  });
  return box;
}

function openLightbox(url) {
  document.querySelector('.lightbox')?.remove();
  const box = document.createElement('div');
  box.className = 'lightbox';
  const img = document.createElement('img');
  img.src = url;
  box.appendChild(img);
  box.addEventListener('click', () => box.remove());
  document.body.appendChild(box);
}

function scrollToBottom(force) {
  const sc = $('messages-scroll');
  const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160;
  if (force || nearBottom) sc.scrollTop = sc.scrollHeight;
}

/* ───────────────────────── 附件（识图上传） ───────────────────────── */

$('btn-attach').addEventListener('click', () => $('file-input').click());

$('file-input').addEventListener('change', async (e) => {
  for (const file of e.target.files) {
    if (state.attachments.length >= MAX_ATTACH) break;
    try {
      const dataUrl = await fileToDataUrl(file);
      state.attachments.push({ dataUrl });
    } catch (err) {
      alert(`读取图片失败：${err.message}`);
    }
  }
  e.target.value = '';
  renderAttachments();
});

async function fileToDataUrl(file) {
  const raw = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  // 大图压一轮：最长边 ATTACH_MAX_EDGE，JPEG 0.88，省 token 也防超限
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('不是有效图片'));
    i.src = raw;
  });
  if (Math.max(img.width, img.height) <= ATTACH_MAX_EDGE && raw.length < 2.5 * 1024 * 1024) return raw;
  const scale = Math.min(1, ATTACH_MAX_EDGE / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  try {
    return canvas.toDataURL('image/jpeg', 0.88);
  } catch {
    return raw; // 个别浏览器隐私模式禁 canvas 导出，退回原图
  }
}

function renderAttachments() {
  const box = $('attach-previews');
  box.innerHTML = '';
  box.classList.toggle('hidden', !state.attachments.length);
  state.attachments.forEach((att, idx) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    const img = document.createElement('img');
    img.src = att.dataUrl;
    const del = document.createElement('button');
    del.textContent = '×';
    del.addEventListener('click', () => {
      state.attachments.splice(idx, 1);
      renderAttachments();
    });
    chip.appendChild(img);
    chip.appendChild(del);
    box.appendChild(chip);
  });
  syncSizeOptions();
}

/* ───────────────────────── 发送 ───────────────────────── */

const inputBox = $('input-box');

inputBox.addEventListener('input', () => {
  inputBox.style.height = 'auto';
  inputBox.style.height = Math.min(inputBox.scrollHeight, 220) + 'px';
});
inputBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    onSend();
  }
});
$('btn-send').addEventListener('click', onSend);

function onSend() {
  if (state.streaming) {
    state.streaming.abort();
    return;
  }
  const text = inputBox.value.trim();
  if (!text && !state.attachments.length) return;
  if (!state.apiKey) { openSettings(); return; }
  if (isImageMode() && !text) return; // 生图必须有描述，光有参考图不行

  // 立刻占位：sendChat/sendImageGen 要在 await persistConv 之后才设真正的 AbortController，
  // 这中间的异步窗口里若再次点击/回车会发出并发请求。先占位堵住，内部会用真 controller 覆盖。
  state.streaming = new AbortController();
  if (isImageMode()) sendImageGen(text);
  else sendChat(text);
}

function setSending(on) {
  const btn = $('btn-send');
  if (on) {
    btn.textContent = '停止';
    btn.classList.add('stop');
  } else {
    btn.classList.remove('stop');
    btn.textContent = isImageMode() ? '生成' : '发送';
    state.streaming = null;
  }
}

function pushUserMessage(conv, text) {
  const images = state.attachments.map((a) => a.dataUrl);
  const msg = { role: 'user', text, images, kind: 'chat' };
  conv.messages.push(msg);
  if (conv.title === '新对话' && text) conv.title = text.slice(0, 24);
  state.attachments = [];
  renderAttachments();
  inputBox.value = '';
  inputBox.style.height = 'auto';
  // 增量挂 DOM（首条消息时先清空空态）
  if (conv.messages.length === 1) $('messages').innerHTML = '';
  $('messages').appendChild(buildMsgEl(msg));
  $('header-title').textContent = conv.title;
  scrollToBottom(true);
  return msg;
}

function pushErrorMessage(conv, text) {
  const msg = { role: 'assistant', kind: 'error', text };
  conv.messages.push(msg);
  $('messages').appendChild(buildMsgEl(msg));
  scrollToBottom(true);
  persistConv(conv);
}

/* —— 聊天（含识图） —— */

// Codex 后端默认一副「代码工作区」腔调，会跟用户扯查项目结构/生成文件；用系统提示掰回闲聊场景
const CHAT_SYSTEM_PROMPT =
  '你是一个友好的 AI 助手，在网页聊天界面中与用户对话，用用户的语言回复。' +
  '你没有文件系统、代码工作区或运行环境，不能创建/保存/输出文件；' +
  '所有内容都直接以文字和 Markdown 在对话里呈现。' +
  '你自己不能生成图片：用户想要生成或修改图片时，告诉他把右上角模型切换到 gpt-image-2 后直接描述画面（可附参考图）。';

function buildApiMessages(conv) {
  const out = [{ role: 'system', content: CHAT_SYSTEM_PROMPT }];
  for (const m of conv.messages) {
    if (m.kind === 'error') continue;
    if (m.role === 'user') {
      if (m.images?.length) {
        const parts = [];
        if (m.text) parts.push({ type: 'text', text: m.text });
        for (const u of m.images) parts.push({ type: 'image_url', image_url: { url: u } });
        out.push({ role: 'user', content: parts });
      } else {
        out.push({ role: 'user', content: m.text || '' });
      }
    } else {
      // 助手消息只回传文本；生成的图不回灌（多数后端不收 assistant 图片 part）
      if (m.text) out.push({ role: 'assistant', content: m.text });
    }
  }
  return out;
}

async function sendChat(text) {
  const conv = currentConv() || newConv();
  await ensureMessages(conv);              // 后端会话可能正文未加载，先补全再 push
  const model = currentModel();
  pushUserMessage(conv, text);
  await persistConv(conv);

  const aMsg = { role: 'assistant', text: '', kind: 'chat', model };
  conv.messages.push(aMsg);
  const aEl = buildMsgEl(aMsg);
  const aBody = aEl.querySelector('.msg-body');
  aBody.innerHTML = '<span class="stream-caret"></span>';
  $('messages').appendChild(aEl);
  scrollToBottom(true);

  const ctrl = new AbortController();
  state.streaming = ctrl;
  setSending(true);

  let lastRender = 0;
  const renderStream = (final) => {
    const now = Date.now();
    if (!final && now - lastRender < 90) return;
    lastRender = now;
    aBody.innerHTML = mdRender(aMsg.text) + (final ? '' : '<span class="stream-caret"></span>');
    scrollToBottom(false);
  };

  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.apiKey.key}`,
      },
      body: JSON.stringify({ model, messages: buildApiMessages(conv), stream: true }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(formatApiError(res.status, errText));
    }

    const handleSseLine = (line) => {
      const t = line.trim();
      if (!t.startsWith('data:')) return;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') return;
      let j;
      try { j = JSON.parse(payload); } catch { return; }
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      const delta = j.choices?.[0]?.delta;
      if (delta?.content) {
        aMsg.text += delta.content;
        renderStream(false);
      }
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // 末尾可能是半行，留到下一轮
      for (const line of lines) handleSseLine(line);
    }
    buf += decoder.decode(); // flush 解码器残留
    // 流结束时缓冲里可能压着不止一行（上游不以 [DONE] 收尾时），逐行处理，别丢掉末尾内容
    for (const line of buf.split('\n')) if (line.trim()) handleSseLine(line);
    if (!aMsg.text) aMsg.text = '（空响应）';
    renderStream(true);
  } catch (err) {
    conv.messages.pop(); // 撤掉占位的助手消息
    aEl.remove();
    if (err.name !== 'AbortError') {
      pushErrorMessage(conv, err.message);
    } else if (aMsg.text) {
      // 手动停止但已有内容 → 保留
      conv.messages.push(aMsg);
      aMsg.text += '\n\n*（已手动停止）*';
      aEl.querySelector('.msg-body').innerHTML = mdRender(aMsg.text);
      $('messages').appendChild(aEl);
    }
  } finally {
    setSending(false);
    await persistConv(conv);
  }
}

/* —— 生图 —— */

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = (head.match(/^data:(.*?)[;,]/) || [])[1] || 'image/png';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/** 宽容地解析流式生图 SSE：兼容官方 image_generation.partial_image / image_edit.* 事件，
 *  也接住各种代理自创的 {b64_json} / {data:[{b64_json|url}]} 形态。 */
async function readImageSse(res, pendingEl) {
  let lastB64 = null;
  let finalB64 = null;
  let finalUrl = null;
  let revised = '';
  let mime = 'image/png';

  const previewWrap = pendingEl.querySelector('.msg-body');
  let previewImg = null;
  const showPartial = (dataUri) => {
    if (!previewImg) {
      previewImg = document.createElement('img');
      previewImg.className = 'gen-partial';
      previewWrap.appendChild(previewImg);
      const txt = pendingEl.querySelector('.gen-pending-text');
      if (txt) txt.firstChild.textContent = '逐步成形中 ';
    }
    previewImg.src = dataUri;
    scrollToBottom(false);
  };

  const handleEvent = (j) => {
    if (!j || typeof j !== 'object') return;
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    if (j.output_format) mime = `image/${j.output_format}`;
    if (j.revised_prompt) revised = j.revised_prompt;

    const type = j.type || '';
    if (typeof j.b64_json === 'string' && j.b64_json) {
      lastB64 = j.b64_json;
      if (type.includes('partial')) showPartial(`data:${mime};base64,${j.b64_json}`);
      else if (type.includes('completed') || !type) finalB64 = j.b64_json;
    } else if (typeof j.url === 'string' && j.url) {
      // response_format=url 时图片在 url 字段（sub2api 给的是 data:image/...;base64 形态，可直接显示）
      if (type.includes('partial')) showPartial(j.url);
      else finalUrl = j.url;
    }
    // 非官方形态兜底：整包 data 数组当最终结果
    if (Array.isArray(j.data) && j.data.length) {
      const d = j.data[0];
      if (d.b64_json) finalB64 = d.b64_json;
      else if (d.url) finalUrl = d.url;
      if (d.revised_prompt) revised = d.revised_prompt;
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const handleLine = (line) => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let j;
    try { j = JSON.parse(payload); } catch { return; }
    handleEvent(j);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) handleLine(line);
  }
  buf += decoder.decode();
  for (const line of buf.split('\n')) if (line.trim()) handleLine(line);

  const b64 = finalB64 || lastB64; // 没收到 completed 事件就拿最后一张 partial 兜底
  const images = [];
  if (b64) images.push(`data:${mime};base64,${b64}`);
  else if (finalUrl) images.push(finalUrl);
  if (!images.length) throw new Error('流式响应结束但没有收到图片数据');
  return { images, revised };
}

async function sendImageGen(prompt) {
  if (!prompt) return;
  const conv = currentConv() || newConv();
  await ensureMessages(conv);              // 同上：先确保正文已加载
  const model = currentModel();
  let size = $('size-select').value;
  const quality = $('quality-select').value;
  const userMsg = pushUserMessage(conv, prompt);
  const refImages = userMsg.images || []; // 附了参考图 → 走 edits 按图改图
  if (refImages.length && !NATIVE_SIZES.has(size)) size = '1024x1024'; // edits 不支持高分自定义尺寸，退回合法尺寸
  await persistConv(conv);

  // 等待画面：脉冲环 + 计时器
  const pendingEl = document.createElement('div');
  pendingEl.className = 'msg msg-assistant is-image';
  pendingEl.innerHTML = `
    <div class="msg-role"><span class="msg-role-glyph">✦</span><span class="msg-role-name"></span></div>
    <div class="msg-body">
      <div class="gen-pending">
        <div class="gen-rings"><span></span><span></span><span></span></div>
        <div class="gen-pending-text">正在生成 <span class="mono"></span> · <span class="gen-pending-timer">0s</span></div>
      </div>
    </div>`;
  pendingEl.querySelector('.msg-role-name').textContent = model;
  pendingEl.querySelector('.gen-pending-text .mono').textContent =
    refImages.length ? `${size} · 按图改图` : size;
  $('messages').appendChild(pendingEl);
  scrollToBottom(true);

  const t0 = Date.now();
  const timerEl = pendingEl.querySelector('.gen-pending-timer');
  const timer = setInterval(() => { timerEl.textContent = `${Math.round((Date.now() - t0) / 1000)}s`; }, 1000);

  const ctrl = new AbortController();
  state.streaming = ctrl;
  setSending(true);

  // 流式生图：让源站尽早吐字节，绕开 Cloudflare 100 秒首字节超时；
  // 上游不认 stream 参数时自动回退非流式（那种情况只能赌 100 秒内出图）。
  const doRequest = (stream) => {
    if (refImages.length) {
      // 带参考图：multipart 走 /v1/images/edits（FormData 不能手动设 Content-Type，浏览器要填 boundary）
      const fd = new FormData();
      fd.append('model', model);
      fd.append('prompt', prompt);
      fd.append('size', size);
      fd.append('n', '1');
      if (quality !== 'auto') fd.append('quality', quality);
      if (stream) {
        fd.append('stream', 'true');
        fd.append('partial_images', '2');
      }
      if (refImages.length === 1) {
        fd.append('image', dataUrlToBlob(refImages[0]), 'ref-1.png');
      } else {
        refImages.forEach((u, i) => fd.append('image[]', dataUrlToBlob(u), `ref-${i + 1}.png`));
      }
      return fetch('/v1/images/edits', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${state.apiKey.key}` },
        body: fd,
        signal: ctrl.signal,
      });
    }
    const payload = { model, prompt, size, n: 1 };
    if (quality !== 'auto') payload.quality = quality;
    if (stream) {
      payload.stream = true;
      payload.partial_images = 2;
    }
    return fetch('/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.apiKey.key}`,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  };

  try {
    let res = await doRequest(true);
    if (!res.ok) {
      const errText = await res.text();
      // 只有当报错明确是冲着 stream/partial_images 参数来的才回退重试，内容审核类 400 不重试
      if ((res.status === 400 || res.status === 422) && /stream|partial/i.test(errText)) {
        res = await doRequest(false);
        if (!res.ok) throw new Error(formatApiError(res.status, await res.text()));
      } else {
        throw new Error(formatApiError(res.status, errText));
      }
    }

    let images = [];
    let revised = '';
    const ctype = res.headers.get('content-type') || '';

    if (ctype.includes('event-stream')) {
      const got = await readImageSse(res, pendingEl);
      images = got.images;
      revised = got.revised;
    } else {
      const bodyText = await res.text();
      let json;
      try {
        json = JSON.parse(bodyText);
      } catch {
        // 头部正常但解析失败 ≈ 响应被截断或混入多段数据，尾部最能说明问题
        throw new Error(
          `响应 JSON 解析失败（共 ${bodyText.length} 字符，疑似被截断）\n` +
          `头部：${bodyText.slice(0, 160)}\n…\n尾部：${bodyText.slice(-160)}`
        );
      }
      const items = json.data || [];
      images = items
        .map((d) => d.b64_json ? `data:image/png;base64,${d.b64_json}` : d.url)
        .filter(Boolean);
      revised = items[0]?.revised_prompt || '';
      if (!images.length) throw new Error(`响应里没有图片：${bodyText.slice(0, 300)}`);
    }

    const secs = Math.round((Date.now() - t0) / 1000);
    const msg = {
      role: 'assistant', kind: 'image', model,
      text: revised ? `*${revised}*` : '',
      images,
      meta: `${size} · ${secs}s`,
    };
    conv.messages.push(msg);
    pendingEl.remove();
    $('messages').appendChild(buildMsgEl(msg));
    scrollToBottom(true);
  } catch (err) {
    pendingEl.remove();
    if (err.name !== 'AbortError') pushErrorMessage(conv, err.message);
  } finally {
    clearInterval(timer);
    setSending(false);
    await persistConv(conv);
  }
}

function formatApiError(status, bodyText) {
  let msg = bodyText;
  try {
    const j = JSON.parse(bodyText);
    msg = j.error?.message || j.message || bodyText;
  } catch {
    // 不是 JSON 多半是 Cloudflare / 网关吐的 HTML 错误页，整页贴出来没法看
    if (/<!DOCTYPE|<html/i.test(bodyText)) {
      const title = (bodyText.match(/<title>([^<]*)<\/title>/i) || [])[1];
      msg = title ? `（HTML 错误页）${title.trim()}` : '（HTML 错误页，内容略）';
    }
  }
  const hint =
    status === 401 ? '（Key 无效或已禁用）'
    : status === 403 ? '（无权限 / 被风控拦截）'
    : status === 404 ? '（端点不存在：这把 key 所在分组的平台可能不是 openai，或上游 sub2api 版本不支持）'
    : status === 429 ? '（限流，稍后再试）'
    : status === 524 ? '（Cloudflare 100 秒超时：图还在源站生成，但 CF 先掐了连接——试试降低质量档位，或等流式生图修复上线）'
    : '';
  return `HTTP ${status} ${hint}\n${String(msg).slice(0, 600)}`;
}

/* ───────────────────────── 启动 ───────────────────────── */

(async function init() {
  document.querySelectorAll('#login-upstream-host, #settings-upstream').forEach((el) => {
    el.textContent = UPSTREAM;
  });

  await loadConversations();

  if (state.auth || state.apiKey) {
    showApp();
    maybeMigrateLocal();
  } else {
    showLogin();
  }
})();
