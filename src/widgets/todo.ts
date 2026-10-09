import type { WidgetDef } from './types';
import { empty, esc, num, paged } from './ui';

function fmtDue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const hm = d.toTimeString().slice(0, 5);
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const tomorrow = new Date(now.getTime() + 86_400_000);
  if (d.toDateString() === tomorrow.toDateString()) return `明天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// data = { pending_count: number, items: [{ title, due (ISO), priority: 'P0'|'P1'|'P2' }] }
export const todo: WidgetDef = {
  id: 'todo',
  title: '飞书待办',
  icon: `<img src="data:image/png;base64,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" width="22" height="22" style="border-radius:6px;display:block" alt="" />`,
  render(data) {
    const count = num(data?.pending_count);
    const items = Array.isArray(data?.items) ? data.items : [];
    if (count === 0 && items.length === 0) return empty('全部完成，干得漂亮');
    const lead = `<p class="w-lead">还有 <b>${count}</b> 项待办未完成。</p>`;
    const list = items.map((it: any) => {
      const p = String(it.priority ?? '');
      return `<li class="w-todo"><span class="w-check"></span><div class="w-todo-main"><span class="w-todo-title">${esc(it.title)}</span><span class="w-todo-due">${esc(fmtDue(it.due))}</span></div>${p ? `<span class="w-pill w-${esc(p.toLowerCase())}">${esc(p)}</span>` : ''}</li>`;
    });
    return lead + (items.length ? paged(list, 'w-todos') : '');
  },
};
