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
  icon: `<svg viewBox="0 0 28 28" fill="none"><rect width="28" height="28" rx="8" fill="#C9A08C"/><g transform="translate(2,2) scale(1)"><path fill="#fff" opacity=".5" d="M15.612 2.03826C14.59 2 13.3988 2 12 2C7.28595 2 4.92893 2 3.46447 3.46447C2 4.92893 2 7.28595 2 12C2 16.714 2 19.0711 3.46447 20.5355C4.92893 22 7.28595 22 12 22C16.714 22 19.0711 22 20.5355 20.5355C22 19.0711 22 16.714 22 12C22 10.6012 22 9.41 21.9617 8.38802C21.1703 9.08042 20.1342 9.5 19 9.5C16.5147 9.5 14.5 7.48528 14.5 5C14.5 3.86584 14.9196 2.82967 15.612 2.03826Z"/><path fill="#fff" d="M5.16016 13C6.06527 13 6.5182 12.9997 6.91602 13.1826C7.3138 13.3656 7.60834 13.7094 8.19727 14.3965L8.80273 15.1035C9.39166 15.7906 9.68627 16.1344 10.084 16.3174C10.4818 16.5003 10.9348 16.5 11.8398 16.5H12.1602C13.0651 16.5 13.5182 16.5002 13.916 16.3174C14.3138 16.1344 14.6084 15.7905 15.1973 15.1035L15.8027 14.3965C16.3918 13.7092 16.6871 13.3656 17.085 13.1826C17.4826 12.9999 17.9352 13 18.8398 13H22C21.9927 17.0548 21.893 19.1781 20.5361 20.5352C19.0716 21.9996 16.7142 22 12 22C7.28601 22 4.92932 21.9996 3.46484 20.5352C2.10779 19.1781 2.0073 17.055 2 13H5.16016Z"/><path fill="#fff" d="M19 2C20.6569 2 22 3.34315 22 5C22 6.65685 20.6569 8 19 8C17.3431 8 16 6.65685 16 5C16 3.34315 17.3431 2 19 2Z"/></g></svg>`,
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
