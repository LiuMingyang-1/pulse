import type { WidgetDef } from './types';
import { empty, esc, rows, stat } from './ui';

// Fallback for any widget id without a dedicated def, so an agent can create a
// new card with zero frontend work. Recognised data fields (all optional):
//   { text: string,
//     stat: { label: string, value: string|number },
//     items: [{ title: string, subtitle?: string, value?: string }] }
export const generic: Omit<WidgetDef, 'id' | 'title'> = {
  icon: `<svg viewBox="0 0 28 28" fill="none"><defs><linearGradient id="genG" x1="0" y1="0" x2="28" y2="28" gradientUnits="userSpaceOnUse"><stop stop-color="#94A3B8"/><stop offset="1" stop-color="#64748B"/></linearGradient></defs><rect width="28" height="28" rx="8" fill="url(#genG)"/><rect x="7.5" y="7.5" width="5.5" height="5.5" rx="1.6" fill="#fff"/><rect x="15" y="7.5" width="5.5" height="5.5" rx="1.6" fill="#fff" opacity=".65"/><rect x="7.5" y="15" width="5.5" height="5.5" rx="1.6" fill="#fff" opacity=".65"/><rect x="15" y="15" width="5.5" height="5.5" rx="1.6" fill="#fff"/></svg>`,
  render(data) {
    if (data == null) return empty('暂无数据');
    if (typeof data !== 'object') return `<p class="w-lead">${esc(data)}</p>`;
    let html = '';
    if (data.stat) html += stat(String(data.stat.label ?? ''), esc(data.stat.value));
    if (data.text) html += `<p class="w-lead">${esc(data.text)}</p>`;
    if (Array.isArray(data.items) && data.items.length) {
      html += rows(
        data.items.map((it: any): [string, string] => [
          `<span class="w-sym">${esc(it.title)}</span>${it.subtitle ? `<span class="w-sub">${esc(it.subtitle)}</span>` : ''}`,
          it.value != null ? `<span class="w-chg">${esc(it.value)}</span>` : '',
        ]),
      );
    }
    return html || `<pre class="w-raw">${esc(JSON.stringify(data, null, 2))}</pre>`;
  },
};
