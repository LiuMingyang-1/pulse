import type { WidgetDef } from './types';
import { empty, esc } from './ui';

const hm = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 5);
};

// data = { events: [{ title, start (ISO), end (ISO) }] }
// Rows are sorted at push time; rendering just marks past / live / upcoming so
// the card reads as a real timeline between syncs.
export const schedule: WidgetDef = {
  id: 'schedule',
  title: '今日安排',
  icon: `<svg viewBox="0 0 28 28" fill="none"><rect width="28" height="28" rx="8" fill="#3B82F6"/><rect x="6.5" y="7" width="15" height="14" rx="2" fill="#fff"/><path d="M6.5 10.5h15" stroke="#3B82F6" stroke-width="1.4"/><path d="M10.5 5v3M17.5 5v3" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><circle cx="11" cy="14.5" r="1.3" fill="#3B82F6"/><circle cx="14" cy="14.5" r="1.3" fill="#3B82F6" opacity=".55"/><circle cx="17" cy="14.5" r="1.3" fill="#3B82F6" opacity=".3"/></svg>`,
  render(data) {
    const events = Array.isArray(data?.events) ? data.events : [];
    if (events.length === 0) return empty('今天没有日程，享受空白时间');
    const now = Date.now();
    const items = events.map((e: any) => {
      const s = new Date(e.start).getTime();
      const en = new Date(e.end).getTime();
      const live = s <= now && now < en;
      const past = en <= now;
      const cls = live ? ' is-live' : past ? ' is-past' : '';
      return `<li class="w-slot${cls}"><span class="w-time">${esc(hm(e.start))}–${esc(hm(e.end))}</span><span class="w-dot"></span><span class="w-ev">${esc(e.title)}</span></li>`;
    });
    return `<ol class="w-timeline">${items.join('')}</ol>`;
  },
};
