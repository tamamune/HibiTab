// Service Worker: タブの最終利用時刻の記録 / 放置タブの自動アーカイブ / 日報データ記録 / Drive 同期
import {
  getSettings, dateKey, isTrackable, normalizeUrl, uid, getDay, listDays, protectionReason, isVivaldiPanel, getDevice,
} from './lib/common.js';
import { buildReportData, deviceSection, mergeDeviceSection } from './lib/report.js';
import {
  connectDrive,
  disconnectDrive,
  uploadReport,
  uploadConfigBackup,
  listConfigBackups,
  restoreConfigBackup,
} from './lib/drive.js';

// ストレージの読み書きを直列化して取りこぼしを防ぐ
const queue = (() => {
  let p = Promise.resolve();
  return (fn) => {
    const r = p.then(fn);
    p = r.catch((e) => console.warn(e));
    return r;
  };
})();

const sessionGet = async (key, def) => (await chrome.storage.session.get(key))[key] ?? def;

// ---------------- 初期化 ----------------

async function setup({ resetTimes }) {
  await getDevice(); // この PC の ID を用意
  const s = await getSettings();
  await chrome.alarms.create('idleCheck', { periodInMinutes: 5 });
  await chrome.alarms.create('driveSync', { periodInMinutes: Math.max(15, s.syncIntervalMinutes), delayInMinutes: 2 });
  await chrome.alarms.create('cleanup', { periodInMinutes: 360, delayInMinutes: 1 });

  const tabs = await chrome.tabs.query({});
  await queue(async () => {
    const la = resetTimes ? {} : await sessionGet('lastActive', {});
    const now = Date.now();
    for (const t of tabs) {
      // ブラウザ起動直後は復元されたタブを即座に閉じないよう「今」を基準にする
      if (la[t.id] == null) la[t.id] = resetTimes ? now : t.lastAccessed || now;
    }
    await chrome.storage.session.set({ lastActive: la });
  });
}

chrome.runtime.onInstalled.addListener(() => setup({ resetTimes: false }));
chrome.runtime.onStartup.addListener(() => setup({ resetTimes: true }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const o = changes.settings.oldValue || {};
  const n = changes.settings.newValue || {};
  if (o.syncIntervalMinutes !== n.syncIntervalMinutes) {
    chrome.alarms.create('driveSync', { periodInMinutes: Math.max(15, n.syncIntervalMinutes || 60) });
  }
  // PC 名を変えたら、Drive 上の見出しも直すため同期済みの記録をリセット（次回の同期で再アップロード）
  if ((o.deviceName || '') !== (n.deviceName || '') && n.driveEnabled) {
    chrome.storage.local.remove('syncMeta').then(() => syncDrive().catch((e) => console.warn(e)));
  }
});

// ---------------- 最終利用時刻 ----------------

function touch(tabIds) {
  const ids = [].concat(tabIds).filter((id) => id != null && id >= 0);
  if (!ids.length) return;
  return queue(async () => {
    const la = await sessionGet('lastActive', {});
    const now = Date.now();
    for (const id of ids) la[id] = now;
    await chrome.storage.session.set({ lastActive: la });
  });
}

chrome.tabs.onCreated.addListener((tab) => touch(tab.id));

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  touch(tabId);
  try {
    recordVisit(await chrome.tabs.get(tabId));
  } catch {}
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete') {
    if (tab.active) touch(tabId);
    recordVisit(tab);
  } else if (info.title) {
    recordVisit(tab, { count: false });
  }
});

// フォーカスが移ったとき、離れたウィンドウの表示中タブは「今まで使っていた」ので時刻を更新
let focusedWindowId = null;
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const ids = [];
  for (const w of new Set([focusedWindowId, windowId])) {
    if (w == null || w === chrome.windows.WINDOW_ID_NONE) continue;
    const [t] = await chrome.tabs.query({ active: true, windowId: w }).catch(() => []);
    if (t) ids.push(t.id);
  }
  if (windowId === chrome.windows.WINDOW_ID_NONE && focusedWindowId == null) {
    const w = await chrome.windows.getLastFocused().catch(() => null);
    const [t] = w ? await chrome.tabs.query({ active: true, windowId: w.id }) : [];
    if (t) ids.push(t.id);
  }
  focusedWindowId = windowId === chrome.windows.WINDOW_ID_NONE ? null : windowId;
  touch(ids);
});

// PC を離れた（無操作・ロック）瞬間まで使っていた表示中タブの時刻を更新
chrome.idle.setDetectionInterval(300);
chrome.idle.onStateChanged.addListener(async (state) => {
  if (state === 'active') return;
  const w = await chrome.windows.getLastFocused().catch(() => null);
  if (!w?.focused) return;
  const [t] = await chrome.tabs.query({ active: true, windowId: w.id });
  if (t) touch(t.id);
});

/** 実際に使われている表示中タブ（PC を操作中で、フォーカスのあるウィンドウの表示中タブ） */
async function tabsInUse(tabs) {
  const state = await chrome.idle.queryState(300).catch(() => 'active');
  if (state !== 'active') return [];
  const w = await chrome.windows.getLastFocused().catch(() => null);
  if (!w?.focused) return [];
  return tabs.filter((t) => t.active && t.windowId === w.id).map((t) => t.id);
}

chrome.tabs.onRemoved.addListener((tabId) =>
  queue(async () => {
    const la = await sessionGet('lastActive', {});
    const prot = await sessionGet('protectedTabs', []);
    delete la[tabId];
    await chrome.storage.session.set({ lastActive: la, protectedTabs: prot.filter((id) => id !== tabId) });
  }),
);

chrome.windows.onRemoved.addListener((windowId) =>
  queue(async () => {
    const pw = await sessionGet('protectedWindows', []);
    if (pw.includes(windowId)) await chrome.storage.session.set({ protectedWindows: pw.filter((id) => id !== windowId) });
  }),
);

// ---------------- 閲覧記録（日報用） ----------------

function recordVisit(tab, { count = true } = {}) {
  const url = tab.url;
  if (!isTrackable(url) || isVivaldiPanel(tab)) return;
  const key = normalizeUrl(url);
  return queue(async () => {
    const now = Date.now();
    const date = dateKey(now);
    const day = await getDay(date);
    let e = day.pages[key];
    if (!e) {
      if (!count) return;
      e = day.pages[key] = { url: key, title: key, first: now, last: now, count: 0, counted: 0 };
    }
    let changed = false;
    if (count) {
      // 30秒以内の重複イベントは 1 回として数える
      if (now - (e.counted || 0) > 30_000) {
        e.count++;
        e.counted = now;
      }
      e.last = now;
      changed = true;
    }
    if (tab.title && tab.title !== url && tab.title !== e.title) {
      e.title = tab.title;
      changed = true;
    }
    if (!changed) return;
    day.changedAt = now;
    await chrome.storage.local.set({ ['day:' + date]: day });
  });
}

// ---------------- 放置タブのアーカイブ ----------------

async function archiveTabs(tabs, reason) {
  if (!tabs.length) return 0;
  const la = await sessionGet('lastActive', {});
  await queue(async () => {
    const now = Date.now();
    const date = dateKey(now);
    const { archive = [] } = await chrome.storage.local.get('archive');
    const day = await getDay(date);
    for (const t of tabs) {
      const item = {
        id: uid(),
        url: t.url || t.pendingUrl,
        title: t.title || t.url,
        archivedAt: now,
        lastActive: la[t.id] ?? t.lastAccessed ?? null,
        reason,
      };
      archive.unshift(item);
      day.archivedItems.push({ url: item.url, title: item.title, archivedAt: now, lastActive: item.lastActive, reason });
    }
    day.changedAt = now;
    await chrome.storage.local.set({ archive, ['day:' + date]: day });
  });
  await chrome.tabs.remove(tabs.map((t) => t.id)).catch(() => {});
  return tabs.length;
}

async function idleCheck(force = false) {
  const s = await getSettings();
  const tabs = await chrome.tabs.query({});
  // 使用中のタブは「今も使っている」扱い（切り替え直後に閉じられないように）。
  // closeActiveTabs がオフなら全ウィンドウの表示中タブを、オンなら実際に操作中のタブだけを更新する
  await touch(s.closeActiveTabs ? await tabsInUse(tabs) : tabs.filter((t) => t.active).map((t) => t.id));
  if (!force && !s.autoClose) return 0;

  const [la, protectedTabs, protectedWindows, { favorites = [] }] = await Promise.all([
    sessionGet('lastActive', {}),
    sessionGet('protectedTabs', []),
    sessionGet('protectedWindows', []),
    chrome.storage.local.get('favorites'),
  ]);
  const ctx = { settings: s, favSet: new Set(favorites.map((f) => normalizeUrl(f.url))), protectedTabs, protectedWindows };
  const now = Date.now();
  const threshold = s.idleMinutes * 60_000;
  const self = chrome.runtime.getURL('');
  const targets = tabs.filter((t) => {
    if ((t.url || '').startsWith(self)) return false;
    if (protectionReason(t, ctx)) return false;
    const last = la[t.id] ?? t.lastAccessed ?? now;
    return now - last >= threshold;
  });
  return archiveTabs(targets, 'auto');
}

// ---------------- 掃除 ----------------

async function cleanup() {
  const s = await getSettings();
  const now = Date.now();
  await queue(async () => {
    if (s.archiveRetentionDays > 0) {
      const { archive = [] } = await chrome.storage.local.get('archive');
      const cut = now - s.archiveRetentionDays * 86_400_000;
      const kept = archive.filter((a) => a.archivedAt >= cut);
      if (kept.length !== archive.length) await chrome.storage.local.set({ archive: kept });
    }
    if (s.historyRetentionDays > 0) {
      const cut = dateKey(now - s.historyRetentionDays * 86_400_000);
      const old = (await listDays()).filter((d) => d < cut);
      if (old.length) await chrome.storage.local.remove(old.map((d) => 'day:' + d));
    }
    const ids = new Set((await chrome.tabs.query({})).map((t) => t.id));
    const la = await sessionGet('lastActive', {});
    for (const k of Object.keys(la)) if (!ids.has(Number(k))) delete la[k];
    await chrome.storage.session.set({ lastActive: la });
  });
}

// ---------------- Google Drive 同期 ----------------

let syncing = null;
function syncDrive(opts = {}) {
  if (!syncing) syncing = doSync(opts).finally(() => (syncing = null));
  return syncing;
}

async function doSync({ interactive = false, dates = null } = {}) {
  const s = await getSettings();
  if (!s.driveEnabled) throw new Error('Google ドライブが未接続です');
  const { syncMeta = {} } = await chrome.storage.local.get('syncMeta');
  const device = await getDevice();
  let targets = dates;
  if (!targets) {
    targets = [];
    for (const d of (await listDays()).slice(0, 30)) {
      const day = await getDay(d);
      const m = syncMeta[d];
      if (!m || day.changedAt > m.syncedAt) targets.push(d);
    }
  }
  let count = 0;
  try {
    for (const d of targets) {
      const startedAt = Date.now();
      const section = deviceSection(await buildReportData(d), device.name);
      const fileId = await uploadReport(d, (current) => mergeDeviceSection(current, d, device.id, section), syncMeta[d]?.fileId, interactive);
      syncMeta[d] = { syncedAt: startedAt, fileId };
      count++;
    }
    // 設定とお気に入りのバックアップもアップロード
    try {
      await uploadConfigBackup(device, interactive);
    } catch (e) {
      console.warn('設定バックアップのアップロードに失敗:', e);
    }
    await chrome.storage.local.set({ syncMeta, lastSync: { at: Date.now(), ok: true, count } });
    return { count };
  } catch (e) {
    await chrome.storage.local.set({ syncMeta, lastSync: { at: Date.now(), ok: false, count, error: e.message } });
    throw e;
  }
}

// ---------------- アラーム ----------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    if (alarm.name === 'idleCheck') await idleCheck();
    else if (alarm.name === 'cleanup') await cleanup();
    else if (alarm.name === 'driveSync') {
      const s = await getSettings();
      if (s.driveEnabled) await syncDrive();
    }
  } catch (e) {
    console.warn(alarm.name, e);
  }
});

// ---------------- 管理画面からのメッセージ ----------------

async function handle(msg) {
  switch (msg.type) {
    case 'runIdleCheck':
      return { count: await idleCheck(true) };
    case 'archiveTabs': {
      const tabs = await Promise.all(msg.tabIds.map((id) => chrome.tabs.get(id).catch(() => null)));
      return { count: await archiveTabs(tabs.filter(Boolean), 'manual') };
    }
    case 'restoreArchive':
    case 'deleteArchive': {
      const ids = new Set(msg.ids);
      let picked = [];
      await queue(async () => {
        const { archive = [] } = await chrome.storage.local.get('archive');
        picked = archive.filter((a) => ids.has(a.id));
        await chrome.storage.local.set({ archive: archive.filter((a) => !ids.has(a.id)) });
      });
      if (msg.type === 'restoreArchive') {
        for (const a of picked.reverse()) await chrome.tabs.create({ url: a.url, active: false });
      }
      return { count: picked.length };
    }
    case 'clearArchive':
      await queue(() => chrome.storage.local.set({ archive: [] }));
      return {};
    case 'driveConnect':
      await connectDrive();
      return await syncDrive({ interactive: true });
    case 'driveDisconnect':
      await disconnectDrive();
      return {};
    case 'syncNow':
      return await syncDrive({ interactive: true, dates: msg.dates || null });
    case 'backupConfig':
      return { fileId: await uploadConfigBackup(await getDevice(), true) };
    case 'listConfigBackups':
      return { backups: await listConfigBackups(true) };
    case 'restoreConfig':
      return await restoreConfigBackup(msg.fileId, true);
    default:
      throw new Error('unknown message: ' + msg.type);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(
    (r) => sendResponse({ ok: true, ...(r || {}) }),
    (e) => sendResponse({ ok: false, error: e?.message || String(e) }),
  );
  return true;
});
