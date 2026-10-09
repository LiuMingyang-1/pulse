// Shared HTML helpers for widget renderers. Class names live in global.css.

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

export const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const empty = (text: string) => `<div class="w-empty">${esc(text)}</div>`;

/** Big headline number with a small caption above it. */
export const stat = (label: string, value: string, tone = '') =>
  `<div class="w-stat"><span class="w-label">${esc(label)}</span><span class="w-big ${tone}">${value}</span></div>`;

/** Rows separated by hairlines; each row is [left, right] pre-escaped HTML. */
export const rows = (items: [string, string][]) =>
  `<ul class="w-rows">${items
    .map(([l, r]) => `<li><div class="w-row-main">${l}</div><div class="w-row-side">${r}</div></li>`)
    .join('')}</ul>`;

/** List split into pages of `size` with a ‹ 1/N › pager; index.astro wires the
 *  buttons (delegated click on [data-pager]) and keeps the page across polls. */
export function paged(items: string[], cls: string, size = 4): string {
  if (items.length <= size) return `<ul class="${cls}">${items.join('')}</ul>`;
  const pages: string[] = [];
  for (let i = 0; i < items.length; i += size) {
    const n = pages.length;
    pages.push(`<ul class="${cls}" data-page="${n}"${n ? ' hidden' : ''}>${items.slice(i, i + size).join('')}</ul>`);
  }
  return (
    pages.join('') +
    `<div class="w-pager"><button type="button" data-pager="-1" aria-label="上一页">‹</button>` +
    `<span data-role="page-num">1 / ${pages.length}</span>` +
    `<button type="button" data-pager="1" aria-label="下一页">›</button></div>`
  );
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff) || diff < 60_000) return '刚刚';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
