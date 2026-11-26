// 共通ユーティリティ（バックグラウンドと管理画面の両方から使う）

let OAUTH_SECRETS = {};
try {
  const mod = await import('./secrets.js');
  OAUTH_SECRETS = mod.OAUTH_SECRETS || {};
} catch {}

export const DEFAULT_SETTINGS = {
  autoClose: true,          // 放置タブの自動アーカイブ
  idleMinutes: 180,         // 何分触っていなければ放置とみなすか
  closeActiveTabs: true,    // 表示中のタブも、使われていなければ閉じる
  protectPinned: true,      // 固定タブは閉じない
  protectAudible: true,     // 音が出ているタブは閉じない
  protectFavorites: true,   // お気に入りのタブは閉じない
  protectedDomains: [],     // 閉じないドメイン
  archiveRetentionDays: 90, // アーカイブ保存期間（0 = 無期限）
  historyRetentionDays: 365,// 日報データ保存期間（0 = 無期限）
  driveEnabled: false,
  driveConnected: false,
  driveClientId: OAUTH_SECRETS?.clientId || '',
  driveClientSecret: OAUTH_SECRETS?.clientSecret || '',
  driveFolderName: 'タブ日報',
  deviceName: '',           // この PC の名前（日報のセクション見出し）。空なら自動
  syncIntervalMinutes: 60,
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const res = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  if (DEFAULT_SETTINGS.driveClientId) {
    res.driveClientId = DEFAULT_SETTINGS.driveClientId;
  }
  if (DEFAULT_SETTINGS.driveClientSecret) {
    res.driveClientSecret = DEFAULT_SETTINGS.driveClientSecret;
  }
  return res;
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

const pad = (n) => String(n).padStart(2, '0');

/** ローカル時刻の YYYY-MM-DD */
export function dateKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDuration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}時間${m % 60}分` : `${h}時間`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}日${h % 24}時間` : `${d}日`;
}

export function fmtAgo(ms) {
  return ms < 60000 ? 'たった今' : `${fmtDuration(ms)}前`;
}

const WD = '日月火水木金土';
export function fmtDate(date) {
  const d = new Date(`${date}T00:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()} (${WD[d.getDay()]})`;
}
export function weekday(date) {
  return WD[new Date(`${date}T00:00:00`).getDay()];
}

export function isTrackable(url) {
  return /^https?:\/\//i.test(url || '');
}

/** ハッシュを除いた URL（同じページの判定用） */
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return url || '';
  }
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** この PC（このブラウザのインストール）を表す ID と表示名 */
export async function getDevice() {
  let { deviceId } = await chrome.storage.local.get('deviceId');
  if (!deviceId) {
    deviceId = uid();
    await chrome.storage.local.set({ deviceId });
  }
  const s = await getSettings();
  return { id: deviceId, name: s.deviceName?.trim() || `PC-${deviceId.slice(-4).toUpperCase()}` };
}

export function isProtectedDomain(url, domains) {
  const host = hostOf(url);
  if (!host) return false;
  return (domains || []).some((d) => {
    d = d.trim().toLowerCase();
    return d && (host === d || host.endsWith('.' + d));
  });
}

/** Vivaldi 固有のタブ情報（他のブラウザでは空オブジェクト） */
export function vivaldiData(tab) {
  if (!tab?.vivExtData) return {};
  try {
    return JSON.parse(tab.vivExtData) || {};
  } catch {
    return {};
  }
}

/** Vivaldi の Web パネル（サイドパネル内のページ）。通常のタブではないので一覧・自動整理・記録から除外 */
export function isVivaldiPanel(tab) {
  return !!vivaldiData(tab).panelId;
}

/** タブが自動アーカイブの対象外である理由（対象なら null） */
export function protectionReason(tab, { settings, favSet, protectedTabs, protectedWindows = [] }) {
  const url = tab.url || tab.pendingUrl || '';
  if (isVivaldiPanel(tab)) return 'Vivaldiパネル';
  if (tab.active && !settings.closeActiveTabs) return '表示中';
  if (protectedWindows.includes(tab.windowId)) return 'ウィンドウ保護';
  if (settings.protectPinned && tab.pinned) return '固定タブ';
  if (settings.protectAudible && tab.audible) return '再生中';
  if (protectedTabs.includes(tab.id)) return '手動保護';
  if (!isTrackable(url)) return 'Webページ以外';
  if (settings.protectFavorites && favSet.has(normalizeUrl(url))) return 'お気に入り';
  if (isProtectedDomain(url, settings.protectedDomains)) return '保護ドメイン';
  return null;
}

// ---- 日ごとの閲覧データ（キー: "day:YYYY-MM-DD"） ----

export function emptyDay() {
  return { pages: {}, archivedItems: [], changedAt: 0 };
}

export async function getDay(date) {
  const key = 'day:' + date;
  const r = await chrome.storage.local.get(key);
  return { ...emptyDay(), ...(r[key] || {}) };
}

/** 記録がある日付（新しい順） */
export async function listDays() {
  const keys = chrome.storage.local.getKeys
    ? await chrome.storage.local.getKeys()
    : Object.keys(await chrome.storage.local.get(null));
  return keys
    .filter((k) => k.startsWith('day:'))
    .map((k) => k.slice(4))
    .sort()
    .reverse();
}

export function favicon(url, size = 32) {
  return `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(url)}&size=${size}`;
}
