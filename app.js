import {
  getSettings, saveSettings, dateKey, normalizeUrl, hostOf, uid, listDays, protectionReason, isVivaldiPanel, getDevice,
  fmtDuration, fmtAgo, fmtTime, fmtDate, favicon,
} from './lib/common.js';
import { buildReportData, toMarkdown } from './lib/report.js';
import { authMode } from './lib/drive.js';

const params = new URLSearchParams(location.search);
const isPopup = params.has('popup');
document.body.classList.toggle('popup', isPopup);

const VIEWS = ['open', 'favorites', 'frequent', 'archive', 'report', 'settings'];
let view = params.get('view') || localStorage.getItem('view') || 'open';
if (!VIEWS.includes(view)) view = 'open';
let query = '';
const state = {
  openSort: localStorage.getItem('openSort') || 'window',
  freqPeriod: Number(localStorage.getItem('freqPeriod') || 7),
  freqUnit: localStorage.getItem('freqUnit') || 'page',
  archLimit: 200,
  reportDate: dateKey(),
};

const main = document.getElementById('main');
const scroller = () => (isPopup ? main : document.scrollingElement);

// ---------------- 小物 ----------------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const btn = (label, title, fn, cls = '') =>
  h('button', { class: 'icon ' + cls, title, onclick: (e) => { e.stopPropagation(); fn(e); } }, label);

const shieldIcon = (on) => {
  const t = document.createElement('template');
  t.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 2.5 4.5 5.5v5.7c0 4.6 3.1 8.6 7.5 10.3 4.4-1.7 7.5-5.7 7.5-10.3V5.5L12 2.5z" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>${on ? '<path d="m8.5 12 2.4 2.4 4.6-4.8" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' : ''}</svg>`;
  return t.content.firstChild;
};

let toastTimer;
function toast(text, isErr = false) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), isErr ? 5000 : 2200);
}

async function send(msg) {
  const r = await chrome.runtime.sendMessage(msg);
  if (!r?.ok) throw new Error(r?.error || '不明なエラー');
  return r;
}
const run = (fn) => async (...a) => {
  try { await fn(...a); } catch (e) { toast(e.message, true); }
};

const matches = (...fields) => !query || fields.some((f) => (f || '').toLowerCase().includes(query));

function row({ url, title, meta = [], cls = '', lead = null, actions = [], onClick, extra = null }) {
  return h('div', { class: 'row ' + cls },
    lead,
    h('img', { class: 'fav', src: favicon(url), alt: '' }),
    h('div', { class: 'info', title: url, onclick: onClick },
      h('div', { class: 'title' }, title || url),
      h('div', { class: 'meta' }, meta),
      extra),
    h('div', { class: 'acts' }, actions));
}

function download(name, text, type = 'text/markdown') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------- タブ操作 ----------------

async function getFavorites() {
  return (await chrome.storage.local.get('favorites')).favorites || [];
}

async function toggleFavorite(url, title) {
  const favs = await getFavorites();
  const n = normalizeUrl(url);
  const i = favs.findIndex((f) => normalizeUrl(f.url) === n);
  if (i >= 0) favs.splice(i, 1);
  else favs.unshift({ id: uid(), url, title: title || url, addedAt: Date.now() });
  await chrome.storage.local.set({ favorites: favs });
  toast(i >= 0 ? 'お気に入りから外しました' : '★ お気に入りに追加しました');
}

async function toggleProtect(tabId) {
  const { protectedTabs = [] } = await chrome.storage.session.get('protectedTabs');
  const on = !protectedTabs.includes(tabId);
  await chrome.storage.session.set({ protectedTabs: on ? [...protectedTabs, tabId] : protectedTabs.filter((id) => id !== tabId) });
  toast(on ? '🛡 このタブは自動で閉じません' : '保護を解除しました');
}

async function toggleProtectWindow(windowId) {
  const { protectedWindows = [] } = await chrome.storage.session.get('protectedWindows');
  const on = !protectedWindows.includes(windowId);
  await chrome.storage.session.set({
    protectedWindows: on ? [...protectedWindows, windowId] : protectedWindows.filter((id) => id !== windowId),
  });
  toast(on ? '🛡 このウィンドウのタブは自動で閉じません' : 'ウィンドウの保護を解除しました');
}

async function focusTab(t) {
  await chrome.tabs.update(t.id, { active: true });
  await chrome.windows.update(t.windowId, { focused: true });
  if (isPopup) window.close();
}

async function openUrl(url) {
  const tabs = await chrome.tabs.query({});
  const n = normalizeUrl(url);
  const t = tabs.find((x) => normalizeUrl(x.url || '') === n);
  if (t) return focusTab(t);
  await chrome.tabs.create({ url });
  if (isPopup) window.close();
}

// ---------------- 開いているタブ ----------------

async function renderOpen() {
  const [tabs, s, favs, sess, cur] = await Promise.all([
    chrome.tabs.query({}),
    getSettings(),
    getFavorites(),
    chrome.storage.session.get(['lastActive', 'protectedTabs', 'protectedWindows']),
    chrome.windows.getCurrent(),
  ]);
  const lastActive = sess.lastActive || {};
  const protectedTabs = sess.protectedTabs || [];
  const protectedWindows = sess.protectedWindows || [];
  const favSet = new Set(favs.map((f) => normalizeUrl(f.url)));
  const ctx = { settings: s, favSet, protectedTabs, protectedWindows };
  const now = Date.now();
  const thr = s.idleMinutes * 60_000;
  const self = chrome.runtime.getURL('');

  const items = tabs
    .filter((t) => !(t.url || '').startsWith(self) && !isVivaldiPanel(t))
    .map((t) => {
      const idle = t.active && !s.closeActiveTabs ? 0 : Math.max(0, now - (lastActive[t.id] ?? t.lastAccessed ?? now));
      const reason = protectionReason(t, ctx);
      return { t, idle, reason, due: !reason && idle >= thr };
    });
  const due = items.filter((i) => i.due);
  const shown = items.filter((i) => matches(i.t.title, i.t.url));

  const root = h('div', null,
    h('div', { class: 'toolbar' },
      h('span', { class: 'summary' }, `${items.length} タブ`,
        h('span', { class: 'muted' }, s.autoClose ? ` ・ ${fmtDuration(thr)}放置で自動アーカイブ` : ' ・ 自動アーカイブ オフ')),
      h('span', { class: 'spacer' }),
      h('select', {
        onchange: (e) => { state.openSort = e.target.value; localStorage.setItem('openSort', state.openSort); render(); },
      },
        h('option', { value: 'window', selected: state.openSort === 'window' }, 'ウィンドウ順'),
        h('option', { value: 'idle', selected: state.openSort === 'idle' }, '放置が長い順')),
      h('button', {
        class: 'primary', disabled: !due.length,
        title: '放置時間が設定値を超えたタブをアーカイブして閉じます',
        onclick: run(async () => {
          const r = await send({ type: 'runIdleCheck' });
          toast(`${r.count} 件のタブをアーカイブしました`);
        }),
      }, `放置タブを整理 (${due.length})`)));

  const tabRow = ({ t, idle, reason, due }) => {
    const url = t.url || t.pendingUrl || '';
    const isFav = favSet.has(normalizeUrl(url));
    const isProt = protectedTabs.includes(t.id);
    let status;
    if (reason === '表示中') status = h('span', { class: 'pill ok' }, '表示中');
    else if (reason) status = h('span', { class: 'pill' }, `保護: ${reason}`);
    else if (due) status = h('span', { class: 'pill warn' }, '整理対象');
    else status = h('span', { class: 'pill acc' }, `あと ${fmtDuration(thr - idle)}`);
    const showActive = t.active && reason !== '表示中';
    return row({
      url, title: t.title, cls: due ? 'is-due' : '',
      meta: [
        showActive && h('span', { class: 'pill ok' }, '表示中'),
        status, t.pinned && '📌', t.audible && '🔊',
        idle > 0 && h('span', null, fmtAgo(idle)),
        h('span', { class: 'host' }, hostOf(url)),
      ],
      onClick: run(() => focusTab(t)),
      actions: [
        btn(isFav ? '★' : '☆', isFav ? 'お気に入りから外す' : 'お気に入りに追加', run(() => toggleFavorite(url, t.title)), isFav ? 'on' : ''),
        btn(shieldIcon(isProt), isProt ? '保護を解除' : '自動で閉じないよう保護', run(() => toggleProtect(t.id)), isProt ? 'prot-on' : 'prot'),
        btn('📦', 'アーカイブして閉じる', run(async () => { await send({ type: 'archiveTabs', tabIds: [t.id] }); toast('アーカイブしました'); })),
        btn('✕', '閉じる（アーカイブしない）', run(() => chrome.tabs.remove(t.id))),
      ],
    });
  };

  if (!shown.length) root.append(h('div', { class: 'empty' }, '該当するタブはありません'));
  else if (state.openSort === 'idle') {
    root.append(h('div', { class: 'group' }, shown.sort((a, b) => b.idle - a.idle).map(tabRow)));
  } else {
    const wins = [...new Set(shown.map((i) => i.t.windowId))].sort((a, b) => (a === cur.id ? -1 : b === cur.id ? 1 : a - b));
    wins.forEach((w, n) => {
      const list = shown.filter((i) => i.t.windowId === w).sort((a, b) => a.t.index - b.t.index);
      const prot = protectedWindows.includes(w);
      root.append(h('div', { class: 'group' + (prot ? ' win-protected' : '') },
        h('div', { class: 'group-head' },
          w === cur.id ? 'このウィンドウ' : `ウィンドウ ${n + 1}`,
          h('span', { class: 'muted' }, `${list.length}`),
          prot && h('span', { class: 'pill ok' }, '🛡 自動で閉じない'),
          h('span', { class: 'spacer' }),
          h('button', {
            class: prot ? 'prot-on' : '',
            title: prot ? 'このウィンドウの保護を解除' : 'このウィンドウのタブを自動アーカイブの対象外にする',
            onclick: run(() => toggleProtectWindow(w)),
          }, prot ? '🛡 保護を解除' : '🛡 このウィンドウを保護')),
        list.map(tabRow)));
    });
  }
  return root;
}

// ---------------- お気に入り ----------------

async function renderFavorites() {
  const [favs, tabs] = await Promise.all([getFavorites(), chrome.tabs.query({})]);
  const openSet = new Set(tabs.map((t) => normalizeUrl(t.url || '')));
  const shown = favs.filter((f) => matches(f.title, f.url));

  const save = (list) => chrome.storage.local.set({ favorites: list });
  const urlInput = h('input', { type: 'url', placeholder: 'https://… を追加', style: 'flex:1;min-width:140px' });
  const addUrl = run(async () => {
    let url = urlInput.value.trim();
    if (!url) return;
    if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
    new URL(url);
    const list = await getFavorites();
    if (list.some((f) => normalizeUrl(f.url) === normalizeUrl(url))) return toast('すでに登録されています');
    list.unshift({ id: uid(), url, title: url, addedAt: Date.now() });
    await save(list);
    toast('★ 追加しました');
  });
  urlInput.addEventListener('keydown', (e) => e.key === 'Enter' && addUrl());

  const root = h('div', null,
    h('div', { class: 'toolbar' },
      h('span', { class: 'summary' }, `お気に入り ${favs.length}`),
      h('span', { class: 'spacer' }),
      isPopup && h('button', {
        onclick: run(async () => {
          const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!t?.url) return;
          const list = await getFavorites();
          if (list.some((f) => normalizeUrl(f.url) === normalizeUrl(t.url))) return toast('すでに登録されています');
          await toggleFavorite(t.url, t.title);
        }),
      }, '＋ このタブ'),
      h('button', {
        disabled: !shown.length,
        onclick: run(async () => {
          if (shown.length > 10 && !confirm(`${shown.length} 件のタブを開きます。よろしいですか？`)) return;
          for (const f of shown) if (!openSet.has(normalizeUrl(f.url))) await chrome.tabs.create({ url: f.url, active: false });
        }),
      }, 'すべて開く')),
    h('div', { class: 'toolbar', style: 'padding-top:0' }, urlInput, h('button', { onclick: addUrl }, '追加')));

  if (!shown.length) {
    root.append(h('div', { class: 'empty' }, favs.length ? '該当なし' : '☆ ボタンでタブをお気に入りに登録できます。\nお気に入りのタブは自動アーカイブの対象外になります（設定で変更可）。'));
    return root;
  }
  root.append(h('div', { class: 'group' }, shown.map((f) => {
    const isOpen = openSet.has(normalizeUrl(f.url));
    return row({
      url: f.url, title: f.title,
      meta: [isOpen && h('span', { class: 'pill ok' }, '開いている'), h('span', { class: 'host' }, hostOf(f.url)), h('span', null, `${fmtDate(dateKey(f.addedAt))} 追加`)],
      onClick: run(() => openUrl(f.url)),
      actions: [
        btn('↑', '上へ', run(async () => {
          const list = await getFavorites();
          const i = list.findIndex((x) => x.id === f.id);
          if (i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; await save(list); }
        })),
        btn('✎', '名前を変更', run(async () => {
          const name = prompt('表示名', f.title);
          if (name == null) return;
          const list = await getFavorites();
          const x = list.find((y) => y.id === f.id);
          if (x) { x.title = name.trim() || x.url; await save(list); }
        })),
        btn('✕', 'お気に入りから削除', run(async () => save((await getFavorites()).filter((x) => x.id !== f.id)))),
      ],
    });
  })));
  return root;
}

// ---------------- よく見る ----------------

async function renderFrequent() {
  const now = Date.now();
  const days = await listDays();
  const from = state.freqPeriod ? dateKey(now - (state.freqPeriod - 1) * 86_400_000) : '';
  const keys = days.filter((d) => d >= from).map((d) => 'day:' + d);
  const [data, favs, { hiddenFrequent = [] }, tabs] = await Promise.all([
    keys.length ? chrome.storage.local.get(keys) : {},
    getFavorites(),
    chrome.storage.local.get('hiddenFrequent'),
    chrome.tabs.query({}),
  ]);
  const site = state.freqUnit === 'site';
  const hidden = new Set(hiddenFrequent);
  const favSet = new Set(favs.map((f) => normalizeUrl(f.url)));
  const openSet = new Set(tabs.map((t) => normalizeUrl(t.url || '')));

  const agg = new Map();
  for (const [k, day] of Object.entries(data)) {
    for (const p of Object.values(day.pages || {})) {
      const host = hostOf(p.url);
      const key = site ? host : p.url;
      const a = agg.get(key) || { key, url: site ? `https://${host}/` : p.url, title: site ? host : p.title, count: 0, days: new Set(), pages: new Set(), last: 0 };
      a.count += p.count;
      a.days.add(k);
      a.pages.add(p.url);
      if (p.last > a.last) { a.last = p.last; if (!site) a.title = p.title; }
      agg.set(key, a);
    }
  }
  const list = [...agg.values()]
    .filter((a) => !hidden.has(a.key) && matches(a.title, a.url))
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .slice(0, 50);
  const max = list[0]?.count || 1;

  const sel = (value, opts, onchange) =>
    h('select', { onchange: (e) => onchange(e.target.value) }, opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));

  const root = h('div', null,
    h('div', { class: 'toolbar' },
      h('span', { class: 'summary' }, 'よく見るタブ'),
      h('span', { class: 'spacer' }),
      sel(state.freqPeriod, [[1, '今日'], [7, '7日間'], [30, '30日間'], [90, '90日間'], [0, '全期間']], (v) => {
        state.freqPeriod = Number(v); localStorage.setItem('freqPeriod', v); render();
      }),
      sel(state.freqUnit, [['page', 'ページ単位'], ['site', 'サイト単位']], (v) => {
        state.freqUnit = v; localStorage.setItem('freqUnit', v); render();
      }),
      hidden.size > 0 && h('button', {
        title: '非表示にした項目を元に戻す',
        onclick: run(() => chrome.storage.local.set({ hiddenFrequent: [] })),
      }, `非表示を解除 (${hidden.size})`)));

  if (!list.length) {
    root.append(h('div', { class: 'empty' }, 'まだ閲覧記録がありません。ブラウジングすると自動で集計されます。'));
    return root;
  }
  root.append(h('div', { class: 'group' }, list.map((a, i) => {
    const isFav = favSet.has(normalizeUrl(a.url));
    return row({
      url: a.url, title: a.title,
      lead: h('span', { class: 'rank' }, i + 1),
      meta: [
        h('span', { class: 'pill acc' }, `${a.count}回`),
        !site && openSet.has(normalizeUrl(a.url)) && h('span', { class: 'pill ok' }, '開いている'),
        h('span', null, `${a.days.size}日`),
        site && h('span', null, `${a.pages.size}ページ`),
        h('span', null, `最終 ${fmtAgo(now - a.last)}`),
        !site && h('span', { class: 'host' }, hostOf(a.url)),
      ],
      extra: h('div', { class: 'bar', style: `width:${Math.max(3, (a.count / max) * 100)}%` }),
      onClick: run(() => openUrl(a.url)),
      actions: [
        btn(isFav ? '★' : '☆', 'お気に入り', run(() => toggleFavorite(a.url, a.title)), isFav ? 'on' : ''),
        btn('🚫', 'この一覧から非表示', run(async () => {
          const { hiddenFrequent: hf = [] } = await chrome.storage.local.get('hiddenFrequent');
          await chrome.storage.local.set({ hiddenFrequent: [...hf, a.key] });
        })),
      ],
    });
  })));
  return root;
}

// ---------------- アーカイブ ----------------

async function renderArchive() {
  const [{ archive = [] }, s] = await Promise.all([chrome.storage.local.get('archive'), getSettings()]);
  const shown = archive.filter((a) => matches(a.title, a.url));
  const limited = shown.slice(0, state.archLimit);

  const root = h('div', null,
    h('div', { class: 'toolbar' },
      h('span', { class: 'summary' }, `アーカイブ ${archive.length}`,
        h('span', { class: 'muted' }, s.archiveRetentionDays ? ` ・ ${s.archiveRetentionDays}日間保存` : ' ・ 無期限保存')),
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'danger', disabled: !archive.length,
        onclick: run(async () => {
          if (!confirm('アーカイブをすべて削除します（日報の記録は残ります）。よろしいですか？')) return;
          await send({ type: 'clearArchive' });
        }),
      }, 'すべて削除')));

  if (!limited.length) {
    root.append(h('div', { class: 'empty' }, archive.length ? '該当なし' : '放置されて自動で閉じたタブや、📦 で閉じたタブがここに保存されます。'));
    return root;
  }

  const groups = new Map();
  for (const a of limited) {
    const d = dateKey(a.archivedAt);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(a);
  }
  for (const [d, items] of groups) {
    const ids = items.map((a) => a.id);
    root.append(h('div', { class: 'group' },
      h('div', { class: 'group-head' },
        d === dateKey() ? `今日 ${fmtDate(d)}` : fmtDate(d),
        h('span', { class: 'muted' }, `${items.length}`),
        h('span', { class: 'spacer' }),
        h('button', { onclick: run(async () => { const r = await send({ type: 'restoreArchive', ids }); toast(`${r.count} 件を復元しました`); }) }, 'すべて復元'),
        h('button', { class: 'danger', onclick: run(() => send({ type: 'deleteArchive', ids })) }, '削除')),
      items.map((a) => row({
        url: a.url, title: a.title,
        meta: [
          h('span', null, fmtTime(a.archivedAt)),
          h('span', { class: a.reason === 'auto' ? 'pill warn' : 'pill' }, a.reason === 'auto' ? '自動' : '手動'),
          a.lastActive && h('span', null, `放置 ${fmtDuration(a.archivedAt - a.lastActive)}`),
          h('span', { class: 'host' }, hostOf(a.url)),
        ],
        onClick: run(async () => { await send({ type: 'restoreArchive', ids: [a.id] }); toast('復元しました（バックグラウンドで開きました）'); }),
        actions: [
          btn('↺', '復元（開いてアーカイブから外す）', run(() => send({ type: 'restoreArchive', ids: [a.id] }))),
          btn('☆', 'お気に入りに追加', run(() => toggleFavorite(a.url, a.title))),
          btn('✕', '削除', run(() => send({ type: 'deleteArchive', ids: [a.id] }))),
        ],
      }))));
  }
  if (shown.length > limited.length) {
    root.append(h('div', { class: 'toolbar' }, h('button', {
      style: 'margin:auto',
      onclick: () => { state.archLimit += 300; render(); },
    }, `もっと見る（残り ${shown.length - limited.length} 件）`)));
  }
  return root;
}

// ---------------- 日報 ----------------

async function renderReport() {
  const days = await listDays();
  const today = dateKey();
  if (!days.includes(today)) days.unshift(today);
  if (!days.includes(state.reportDate)) state.reportDate = today;
  const date = state.reportDate;
  const [d, s, { syncMeta = {}, lastSync, driveFolder }, device] = await Promise.all([
    buildReportData(date), getSettings(), chrome.storage.local.get(['syncMeta', 'lastSync', 'driveFolder']), getDevice(),
  ]);
  const idx = days.indexOf(date);
  const go = (i) => { state.reportDate = days[i]; render(); };
  const meta = syncMeta[date];

  const root = h('div', null,
    h('div', { class: 'toolbar' },
      h('button', { disabled: idx >= days.length - 1, title: '前の日', onclick: () => go(idx + 1) }, '◀'),
      h('select', { onchange: (e) => { state.reportDate = e.target.value; render(); } },
        days.map((x) => h('option', { value: x, selected: x === date }, `${x}（${fmtDate(x).split(' ')[1].slice(1, 2)}）`))),
      h('button', { disabled: idx <= 0, title: '次の日', onclick: () => go(idx - 1) }, '▶'),
      h('span', { class: 'spacer' }),
      h('button', { title: 'クリップボードにコピー', onclick: run(async () => { await navigator.clipboard.writeText(toMarkdown(d, device.name)); toast('Markdown をコピーしました'); }) }, 'コピー'),
      h('button', { onclick: () => download(`タブ日報_${date}.md`, toMarkdown(d, device.name)) }, '⬇ .md'),
      s.driveEnabled
        ? h('button', { class: 'primary', onclick: run(async () => { toast('同期中…'); await send({ type: 'syncNow', dates: [date] }); toast('Google ドライブに保存しました'); }) }, 'Drive に保存')
        : h('button', { onclick: () => setView('settings') }, 'Drive 連携を設定')),
    s.driveEnabled && h('div', { class: 'toolbar note', style: 'padding-top:0' },
      meta ? `☁ ${new Date(meta.syncedAt).toLocaleString('ja-JP')} に同期済み` : '☁ この日はまだ同期されていません',
      lastSync && !lastSync.ok && h('span', { class: 'status-ng' }, ` ・ 前回の自動同期エラー: ${lastSync.error}`),
      driveFolder?.id && h('a', { href: `https://drive.google.com/drive/folders/${driveFolder.id}`, target: '_blank' }, ` ・ フォルダを開く`)),
    h('div', { class: 'cards' },
      [[d.pages.length, '閲覧ページ'], [d.totalViews, '閲覧回数'], [d.sites.length, 'サイト'], [d.archived.length, 'アーカイブ']]
        .map(([n, l]) => h('div', { class: 'card' }, h('div', { class: 'num' }, n), h('div', { class: 'lbl' }, l)))));

  if (d.sites.length) {
    const max = d.sites[0].count;
    root.append(h('div', { class: 'group' },
      h('div', { class: 'group-head' }, 'よく見たサイト'),
      d.sites.slice(0, 5).map((x, i) => row({
        url: `https://${x.host}/`, title: x.host, lead: h('span', { class: 'rank' }, i + 1),
        meta: [h('span', null, `${x.count}回・${x.pages}ページ`)],
        extra: h('div', { class: 'bar', style: `width:${Math.max(3, (x.count / max) * 100)}%` }),
        onClick: run(() => openUrl(`https://${x.host}/`)),
      }))));
  }

  const pages = d.pages.filter((p) => matches(p.title, p.url));
  root.append(h('div', { class: 'group' },
    h('div', { class: 'group-head' }, '閲覧したページ（時系列）', h('span', { class: 'muted' }, pages.length)),
    pages.length ? pages.map((p) => row({
      url: p.url, title: p.title,
      meta: [h('span', null, fmtTime(p.first)), p.count > 1 && h('span', { class: 'pill acc' }, `×${p.count}`), h('span', { class: 'host' }, hostOf(p.url))],
      onClick: run(() => openUrl(p.url)),
      actions: [btn('☆', 'お気に入りに追加', run(() => toggleFavorite(p.url, p.title)))],
    })) : h('div', { class: 'empty' }, '記録なし')));

  if (d.archived.length) {
    root.append(h('div', { class: 'group' },
      h('div', { class: 'group-head' }, 'アーカイブしたタブ', h('span', { class: 'muted' }, d.archived.length)),
      d.archived.filter((a) => matches(a.title, a.url)).map((a) => row({
        url: a.url, title: a.title,
        meta: [h('span', null, fmtTime(a.archivedAt)), h('span', { class: 'pill' }, a.reason === 'auto' ? '自動' : '手動'), h('span', { class: 'host' }, hostOf(a.url))],
        onClick: run(() => openUrl(a.url)),
      }))));
  }
  return root;
}

// ---------------- 設定 ----------------

async function renderSettings() {
  const s = await getSettings();
  const device = await getDevice();
  const { lastSync, driveFolder } = await chrome.storage.local.get(['lastSync', 'driveFolder']);
  const mode = authMode();
  const el = {};
  const inp = (key, attrs) => (el[key] = h('input', { ...attrs, value: attrs.type === 'checkbox' ? undefined : String(s[key] ?? ''), checked: attrs.type === 'checkbox' && s[key] }));
  const field = (label, input, help) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), input, help && h('small', null, help));
  const check = (key, label) => h('label', { class: 'check' }, inp(key, { type: 'checkbox' }), label);
  el.protectedDomains = h('textarea', { rows: 3, placeholder: 'mail.google.com\ncalendar.google.com', value: s.protectedDomains.join('\n') });

  const collect = () => ({
    autoClose: el.autoClose.checked,
    idleMinutes: Math.max(5, Number(el.idleMinutes.value) || 180),
    closeActiveTabs: el.closeActiveTabs.checked,
    protectPinned: el.protectPinned.checked,
    protectAudible: el.protectAudible.checked,
    protectFavorites: el.protectFavorites.checked,
    protectedDomains: el.protectedDomains.value.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean),
    archiveRetentionDays: Math.max(0, Number(el.archiveRetentionDays.value) || 0),
    historyRetentionDays: Math.max(0, Number(el.historyRetentionDays.value) || 0),
    driveFolderName: el.driveFolderName.value.trim() || 'タブ日報',
    deviceName: el.deviceName.value.trim(),
    driveClientId: el.driveClientId ? el.driveClientId.value.trim() : s.driveClientId,
    syncIntervalMinutes: Math.max(15, Number(el.syncIntervalMinutes.value) || 60),
  });
  const saveAll = run(async () => { await saveSettings(collect()); toast('設定を保存しました'); });

  const root = h('div', null,
    h('div', { class: 'section' },
      h('h3', null, '放置タブの自動アーカイブ'),
      check('autoClose', '一定時間触っていないタブを自動でアーカイブして閉じる'),
      field('放置とみなす時間（分）', inp('idleMinutes', { type: 'number', min: 5, step: 5, style: 'width:120px' }), '例: 180 = 3時間。5分ごとにチェックします。'),
      check('closeActiveTabs', '表示中のタブも、使われていなければアーカイブして閉じる'),
      h('small', { class: 'note', style: 'display:block;margin:-4px 0 8px 22px' },
        '前面のウィンドウで操作している間は閉じません。ウィンドウが裏にあるとき・PC を 5 分以上操作していないときに放置時間が進みます。ウィンドウのタブがすべて対象になると、ウィンドウごと閉じます。'),
      check('protectPinned', '固定（ピン留め）タブは閉じない'),
      check('protectAudible', '音声を再生中のタブは閉じない'),
      check('protectFavorites', 'お気に入りに登録したページは閉じない'),
      field('閉じないドメイン（1行に1つ）', el.protectedDomains, 'サブドメインも含みます。各タブの 🛡 ボタンで個別に保護することもできます。')),
    h('div', { class: 'section' },
      h('h3', null, '保存期間'),
      h('div', { class: 'inline' },
        field('アーカイブ（日）', inp('archiveRetentionDays', { type: 'number', min: 0, style: 'width:100px' })),
        field('日報データ（日）', inp('historyRetentionDays', { type: 'number', min: 0, style: 'width:100px' }))),
      h('small', { class: 'note' }, '0 = 無期限')),
    h('div', { class: 'section' },
      h('h3', null, 'Google ドライブ連携（日報の保存）'),
      h('p', null, '状態: ', s.driveEnabled ? h('span', { class: 'status-ok' }, '接続済み') : h('span', { class: 'status-ng' }, '未接続'),
        driveFolder?.id && h('a', { href: `https://drive.google.com/drive/folders/${driveFolder.id}`, target: '_blank', style: 'margin-left:8px' }, 'フォルダを開く')),
      lastSync && h('p', { class: 'note' }, `前回の同期: ${new Date(lastSync.at).toLocaleString('ja-JP')} `,
        lastSync.ok ? `（${lastSync.count} 日分を保存）` : h('span', { class: 'status-ng' }, `失敗: ${lastSync.error}`)),
      mode === 'web'
        ? [
          field('OAuth クライアントID（種類: ウェブアプリケーション）', el.driveClientId = h('input', { type: 'text', placeholder: 'xxxxxxxx.apps.googleusercontent.com', value: s.driveClientId }), null),
          h('div', { class: 'field' }, h('span', { class: 'lbl' }, '承認済みのリダイレクトURI に登録する値'), h('div', { class: 'code' }, chrome.identity.getRedirectURL())),
        ]
        : h('p', { class: 'note' }, 'manifest.json の oauth2.client_id（Chrome 拡張機能タイプ）で認証します。拡張機能ID: ', h('span', { class: 'code' }, chrome.runtime.id)),
      field('保存先フォルダ名', inp('driveFolderName', { type: 'text' }), 'マイドライブ直下に作成され、日ごとに「YYYY-MM-DD.md」が保存されます。'),
      field('この PC の名前', inp('deviceName', { type: 'text', placeholder: device.name, style: 'width:220px' }),
        '複数の PC で使うと、同じ日の .md に PC ごとの見出し（例: 自宅 / 会社）で記録がまとまります。他の PC でも同じクライアントIDを使い、その PC のリダイレクトURIもクライアントに追加してください。'),
      field('自動同期の間隔（分）', inp('syncIntervalMinutes', { type: 'number', min: 15, step: 15, style: 'width:120px' }), '変更があった日の日報だけをアップロードします。'),
      h('div', { class: 'inline' },
        h('button', {
          class: 'primary',
          onclick: run(async () => {
            await saveSettings(collect());
            toast('Google の認証画面を開きます…');
            const r = await send({ type: 'driveConnect' });
            toast(`接続しました（${r.count} 日分を保存）`);
          }),
        }, s.driveEnabled ? '再接続' : 'Google ドライブに接続'),
        s.driveEnabled && h('button', { onclick: run(async () => { toast('同期中…'); const r = await send({ type: 'syncNow' }); toast(`${r.count} 日分を保存しました`); }) }, '今すぐ同期'),
        s.driveEnabled && h('button', { class: 'danger', onclick: run(async () => { if (confirm('Google ドライブとの接続を解除しますか？（ドライブ上のファイルは残ります）')) await send({ type: 'driveDisconnect' }); }) }, '接続解除'))),
    h('div', { class: 'section' },
      h('h3', null, 'データ'),
      h('div', { class: 'inline' },
        h('button', {
          onclick: run(async () => {
            const all = await chrome.storage.local.get(null);
            download(`tab-diary-backup_${dateKey()}.json`, JSON.stringify(all, null, 2), 'application/json');
          }),
        }, 'すべてのデータを書き出す (JSON)'))),
    h('div', { class: 'toolbar', style: 'justify-content:flex-end;padding:0 10px 16px' }, h('button', { class: 'primary', onclick: saveAll }, '設定を保存')));
  return root;
}

// ---------------- 描画 ----------------

const renderers = { open: renderOpen, favorites: renderFavorites, frequent: renderFrequent, archive: renderArchive, report: renderReport, settings: renderSettings };
let seq = 0;

async function render() {
  const my = ++seq;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.getElementById('search').style.visibility = view === 'settings' ? 'hidden' : '';
  const y = scroller().scrollTop;
  let node;
  try {
    node = await renderers[view]();
  } catch (e) {
    console.error(e);
    node = h('div', { class: 'empty' }, 'エラー: ' + e.message);
  }
  if (my !== seq) return;
  main.replaceChildren(node);
  scroller().scrollTop = y;
}

function setView(v) {
  view = v;
  localStorage.setItem('view', v);
  state.archLimit = 200;
  scroller().scrollTop = 0;
  render();
}

let timer;
const scheduleRender = () => { clearTimeout(timer); timer = setTimeout(render, 250); };

document.getElementById('nav').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.view;
  if (v) setView(v);
});
document.getElementById('search').addEventListener('input', (e) => {
  query = e.target.value.trim().toLowerCase();
  scheduleRender();
});
document.getElementById('openFull').addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL(`app.html?view=${view}`) });
  window.close();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (view === 'settings') {
    // 入力中のフォームを壊さないよう、接続状態などの変化だけ反映
    if (area === 'local' && (changes.lastSync || changes.driveFolder || (changes.settings && changes.settings.oldValue?.driveEnabled !== changes.settings.newValue?.driveEnabled))) scheduleRender();
    return;
  }
  if (area === 'session' && view !== 'open') return;
  scheduleRender();
});
for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onAttached', 'onActivated']) {
  chrome.tabs[ev].addListener(() => view === 'open' && scheduleRender());
}
setInterval(() => (view === 'open' || view === 'report') && render(), 30_000);

render();
