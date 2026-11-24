// Google Drive 連携（drive.file スコープ = このアプリが作ったファイルだけにアクセス）
import { getSettings, saveSettings } from './common.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

function manifestClientId() {
  const id = chrome.runtime.getManifest().oauth2?.client_id;
  return id && !id.startsWith('YOUR_') ? id : null;
}

/** 'chrome' = manifest の oauth2 を使う getAuthToken / 'web' = 設定画面のクライアントIDで launchWebAuthFlow */
export function authMode() {
  return manifestClientId() ? 'chrome' : 'web';
}

// 認証フローは同時に 1 つしか開けないので、進行中のものを共有する
let pendingAuth = null;
export function getToken(interactive = false) {
  if (!pendingAuth) pendingAuth = fetchToken(interactive).finally(() => (pendingAuth = null));
  return pendingAuth;
}

async function fetchToken(interactive) {
  if (manifestClientId()) {
    const r = await chrome.identity.getAuthToken({ interactive, scopes: [SCOPE] });
    const token = typeof r === 'string' ? r : r?.token;
    if (!token) throw new Error('認証トークンを取得できませんでした');
    return token;
  }

  const { driveToken } = await chrome.storage.session.get('driveToken');
  if (driveToken && driveToken.expiresAt > Date.now() + 60_000) return driveToken.token;

  const s = await getSettings();
  if (!s.driveClientId) throw new Error('Google OAuth クライアントIDが未設定です（設定タブ）');

  const p = new URLSearchParams({
    client_id: s.driveClientId.trim(),
    response_type: 'token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: SCOPE,
    include_granted_scopes: 'true',
  });
  if (!interactive) p.set('prompt', 'none');

  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({
      url: 'https://accounts.google.com/o/oauth2/v2/auth?' + p,
      interactive,
      abortOnLoadForNonInteractive: false,
      timeoutMsForNonInteractive: 15_000,
    });
  } catch (e) {
    if (/only one web auth flow/i.test(e.message)) {
      throw new Error('前回の Google ログイン画面が開いたままです。そのウィンドウを閉じてから、もう一度お試しください');
    }
    if (/did not approve|user cancel/i.test(e.message)) throw new Error('認証がキャンセルされました');
    throw new Error(interactive ? `認証に失敗しました: ${e.message}` : 'Google への再接続が必要です（設定タブ →「Google ドライブに接続」）');
  }
  const frag = new URLSearchParams(new URL(redirect).hash.slice(1));
  if (frag.get('error')) throw new Error('認証エラー: ' + frag.get('error'));
  const token = frag.get('access_token');
  if (!token) throw new Error('アクセストークンが返されませんでした');
  const expiresIn = Number(frag.get('expires_in') || 3600);
  await chrome.storage.session.set({ driveToken: { token, expiresAt: Date.now() + expiresIn * 1000 } });
  return token;
}

async function invalidate(token) {
  if (manifestClientId()) await chrome.identity.removeCachedAuthToken({ token });
  else await chrome.storage.session.remove('driveToken');
}

async function api(url, init = {}, interactive = false, retry = true) {
  const token = await getToken(interactive);
  const res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + token } });
  if (res.status === 401 && retry) {
    await invalidate(token);
    return api(url, init, interactive, false);
  }
  return res;
}

async function json(res) {
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Drive API ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export async function ensureFolder(interactive = false) {
  const { driveFolderName: name } = await getSettings();
  const { driveFolder } = await chrome.storage.local.get('driveFolder');
  if (driveFolder?.id && driveFolder.name === name) {
    const r = await api(`${API}/files/${driveFolder.id}?fields=id,trashed`, {}, interactive);
    if (r.ok) {
      const f = await r.json();
      if (!f.trashed) return f.id;
    }
  }
  const query = `name='${q(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const list = await json(await api(`${API}/files?q=${encodeURIComponent(query)}&fields=files(id)&spaces=drive`, {}, interactive));
  let id = list.files?.[0]?.id;
  if (!id) {
    const f = await json(
      await api(
        `${API}/files?fields=id`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
        },
        interactive,
      ),
    );
    id = f.id;
  }
  await chrome.storage.local.set({ driveFolder: { id, name } });
  return id;
}

async function patchFile(id, content, interactive) {
  const r = await api(
    `${UPLOAD}/files/${id}?uploadType=media&fields=id,trashed`,
    { method: 'PATCH', headers: { 'Content-Type': 'text/markdown; charset=UTF-8' }, body: content },
    interactive,
  );
  if (r.status === 404) return false;
  const f = await json(r);
  return !f.trashed;
}

/** ファイルが存在し、ゴミ箱に入っておらず、指定フォルダにあるか */
async function isAlive(id, folderId, interactive) {
  const r = await api(`${API}/files/${id}?fields=id,trashed,parents`, {}, interactive);
  if (r.status === 404) return false;
  const f = await json(r);
  return !f.trashed && (f.parents || []).includes(folderId);
}

async function readFile(id, interactive) {
  const r = await api(`${API}/files/${id}?alt=media`, {}, interactive);
  if (!r.ok) {
    await json(r);
  }
  return r.text();
}

/**
 * 日報を「フォルダ/YYYY-MM-DD.md」に保存する。fileId を返す。
 * render(既存の内容) → 新しい内容。既存ファイルを読み込んでから書くので、他の PC の記録を消さない。
 */
export async function uploadReport(date, render, knownId, interactive = false) {
  const folderId = await ensureFolder(interactive);
  const name = `${date}.md`;

  let id = knownId && (await isAlive(knownId, folderId, interactive)) ? knownId : null;
  if (!id) {
    const query = `name='${q(name)}' and '${folderId}' in parents and trashed=false`;
    const list = await json(await api(`${API}/files?q=${encodeURIComponent(query)}&fields=files(id)&orderBy=createdTime`, {}, interactive));
    id = list.files?.[0]?.id || null;
  }
  if (id) {
    const current = await readFile(id, interactive);
    if (await patchFile(id, render(current), interactive)) return id;
  }

  const content = render('');
  const boundary = 'tabdiary' + Date.now();
  const meta = { name, parents: [folderId], mimeType: 'text/markdown' };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const f = await json(
    await api(
      `${UPLOAD}/files?uploadType=multipart&fields=id`,
      { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body },
      interactive,
    ),
  );
  return f.id;
}

export async function connectDrive() {
  await getToken(true);
  await ensureFolder(true);
  await saveSettings({ driveEnabled: true, driveConnected: true });
}

export async function disconnectDrive() {
  try {
    let token = null;
    if (manifestClientId()) {
      token = await getToken(false).catch(() => null);
      if (token) await chrome.identity.removeCachedAuthToken({ token });
    } else {
      token = (await chrome.storage.session.get('driveToken')).driveToken?.token;
    }
    if (token) await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token), { method: 'POST' }).catch(() => {});
  } finally {
    await chrome.storage.session.remove('driveToken');
    await chrome.storage.local.remove(['driveFolder', 'syncMeta', 'lastSync']);
    await saveSettings({ driveEnabled: false, driveConnected: false });
  }
}
