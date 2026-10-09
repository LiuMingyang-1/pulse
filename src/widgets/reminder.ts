import type { WidgetDef } from './types';
import { empty, esc, paged } from './ui';

const WINDOW_MS = 3 * 86_400_000;

// "已过期" / "今天 HH:MM" / "明天" / "N 天后" — counted in calendar days.
function fmtLeft(d: Date, now: Date): string {
  if (d.getTime() < now.getTime()) return '已过期';
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(now)) / 86_400_000);
  if (days === 0) return `今天 ${d.toTimeString().slice(0, 5)}`;
  if (days === 1) return '明天';
  return `${days} 天后`;
}

// data = { items: [{ title, due (ISO) }] } — all pending reminders; only those
// due within the next 3 days (or already overdue) are shown.
export const reminder: WidgetDef = {
  id: 'reminder',
  title: 'Reminder',
  icon: `<svg viewBox="0 0 28 28" fill="none"><defs><linearGradient id="bellG" x1="0" y1="0" x2="28" y2="28" gradientUnits="userSpaceOnUse"><stop stop-color="#FFB340"/><stop offset="1" stop-color="#FF8E0A"/></linearGradient></defs><rect width="28" height="28" rx="8" fill="url(#bellG)"/><path d="M14 6.5c-2.8 0-4.8 2.1-4.8 4.8v2.6l-1.4 2.1c-.3.4.1 1 .6 1h11.2c.5 0 .9-.6.6-1l-1.4-2.1v-2.6c0-2.7-2-4.8-4.8-4.8z" fill="#fff"/><path d="M12.3 19a1.8 1.8 0 0 0 3.4 0" fill="#fff"/></svg>`,
  render(data) {
    const now = new Date();
    const items = (Array.isArray(data?.items) ? data.items : [])
      .map((it: any) => ({ title: it.title, d: new Date(it.due) }))
      .filter((it: any) => !Number.isNaN(it.d.getTime()) && it.d.getTime() - now.getTime() <= WINDOW_MS);
    if (items.length === 0) return empty('近 3 天没有到期的提醒');
    const list = items.map((it: any) => {
      const left = fmtLeft(it.d, now);
      const urgent = it.d.getTime() - now.getTime() < 86_400_000;
      return `<li class="w-todo"><span class="w-bell"></span><div class="w-todo-main"><span class="w-todo-title">${esc(it.title)}</span><span class="w-todo-due">${esc(`${it.d.getMonth() + 1}月${it.d.getDate()}日`)}</span></div><span class="w-pill${urgent ? ' w-p0' : ' w-p1'}">${esc(left)}</span></li>`;
    });
    return paged(list, 'w-todos');
  },
};
