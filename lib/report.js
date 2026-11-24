// 日報データの組み立てと Markdown 出力
import { getDay, hostOf, fmtTime, fmtDuration, weekday } from './common.js';

export async function buildReportData(date) {
  const day = await getDay(date);
  const pages = Object.values(day.pages).sort((a, b) => a.first - b.first);
  const archived = [...(day.archivedItems || [])].sort((a, b) => a.archivedAt - b.archivedAt);

  const siteMap = new Map();
  for (const p of pages) {
    const h = hostOf(p.url);
    const s = siteMap.get(h) || { host: h, count: 0, pages: 0 };
    s.count += p.count;
    s.pages += 1;
    siteMap.set(h, s);
  }
  const sites = [...siteMap.values()].sort((a, b) => b.count - a.count);
  const totalViews = pages.reduce((sum, p) => sum + p.count, 0);
  return { date, pages, archived, sites, totalViews };
}

const escText = (s) => String(s || '').replace(/[\r\n]+/g, ' ').replace(/([\\[\]|*_`<>])/g, '\\$1');
const escUrl = (u) => String(u).replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
const link = (title, url) => `[${escText(title || url)}](${escUrl(url)})`;

const title = (date) => `# タブ日報 ${date}（${weekday(date)}）`;

/** 1 台の PC の記録（「## PC名」から始まるセクション） */
export function deviceSection(d, deviceName) {
  const lines = [];
  lines.push(`## 🖥 ${escText(deviceName)}`, '');
  lines.push('| 項目 | 値 |', '| --- | --- |');
  lines.push(`| 閲覧ページ数 | ${d.pages.length} |`);
  lines.push(`| 総閲覧回数 | ${d.totalViews} |`);
  lines.push(`| 閲覧サイト数 | ${d.sites.length} |`);
  lines.push(`| アーカイブしたタブ | ${d.archived.length} |`, '');

  if (d.sites.length) {
    lines.push('### よく見たサイト', '');
    d.sites.slice(0, 10).forEach((s, i) => {
      lines.push(`${i + 1}. ${s.host} — ${s.count}回（${s.pages}ページ）`);
    });
    lines.push('');
  }

  lines.push('### 閲覧したページ（時系列）', '');
  if (!d.pages.length) lines.push('_記録なし_');
  for (const p of d.pages) {
    const extra = p.count > 1 ? ` ×${p.count}` : '';
    lines.push(`- ${fmtTime(p.first)} ${link(p.title, p.url)}${extra}`);
  }
  lines.push('');

  lines.push('### アーカイブしたタブ', '');
  if (!d.archived.length) lines.push('_なし_');
  for (const a of d.archived) {
    const how = a.reason === 'auto' ? '自動' : '手動';
    const idle = a.lastActive ? `・放置 ${fmtDuration(a.archivedAt - a.lastActive)}` : '';
    lines.push(`- ${fmtTime(a.archivedAt)} ${link(a.title, a.url)}（${how}${idle}）`);
  }
  lines.push('', `_最終更新: ${new Date().toLocaleString('ja-JP')}_`);
  return lines.join('\n');
}

/** この PC だけの日報（コピー・ダウンロード用） */
export function toMarkdown(d, deviceName) {
  return `${title(d.date)}\n\n${deviceSection(d, deviceName)}\n`;
}

// ---- 複数 PC の統合 ----
// Drive 上のファイルは PC ごとに次の目印で区切る:
//   <!-- device:ID:start --> … <!-- device:ID:end -->
const START = (id) => `<!-- device:${id}:start -->`;
const END = (id) => `<!-- device:${id}:end -->`;
const SECTION_RE = /<!-- device:([\w-]+):start -->\r?\n?([\s\S]*?)\r?\n?<!-- device:\1:end -->/g;

export function parseSections(markdown) {
  return [...String(markdown || '').matchAll(SECTION_RE)].map((m) => ({ id: m[1], body: m[2].trim() }));
}

/**
 * 既存ファイルの内容のうち、この PC のセクションだけを差し替える（なければ末尾に追加）。
 * 他の PC のセクションはそのまま残す。目印のない古い形式の内容は、この PC の旧データとして置き換える。
 */
export function mergeDeviceSection(existing, date, deviceId, section) {
  const sections = parseSections(existing);
  const mine = { id: deviceId, body: section.trim() };
  const i = sections.findIndex((s) => s.id === deviceId);
  if (i >= 0) sections[i] = mine;
  else sections.push(mine);

  const note = sections.length > 1
    ? `> ${sections.length} 台の PC の記録をまとめています。各 PC のセクションは、その PC から自動で更新されます。`
    : '> 各 PC のセクションは、その PC から自動で更新されます。';
  const body = sections.map((s) => `${START(s.id)}\n${s.body}\n${END(s.id)}`).join('\n\n---\n\n');
  return `${title(date)}\n\n${note}\n\n${body}\n`;
}
