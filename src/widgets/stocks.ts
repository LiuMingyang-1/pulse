import type { WidgetDef } from './types';
import { esc, num, rows, stat } from './ui';

const money = (n: number) =>
  `${n >= 0 ? '+' : '−'}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tone = (n: number) => (n >= 0 ? 'up' : 'down');

// data = { total_pnl: number, currency: 'USD', positions: [{ symbol, shares, pnl, pct }] }
export const stocks: WidgetDef = {
  id: 'stocks',
  title: '美股持仓',
  icon: `<svg viewBox="0 0 28 28" fill="none"><defs><linearGradient id="stockG" x1="0" y1="0" x2="28" y2="28" gradientUnits="userSpaceOnUse"><stop stop-color="#A78BFA"/><stop offset="1" stop-color="#7C3AED"/></linearGradient></defs><rect width="28" height="28" rx="8" fill="url(#stockG)"/><path d="M7.5 18.5l3.8-4.2 2.8 2.3 4.8-6.2" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M16.2 10.2h2.6v2.6" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  render(data) {
    const total = num(data?.total_pnl);
    const positions = Array.isArray(data?.positions) ? data.positions : [];
    return (
      stat('总浮动盈亏', money(total), tone(total)) +
      (positions.length
        ? rows(
            positions.map((p: any): [string, string] => {
              const pnl = num(p.pnl);
              const pct = num(p.pct);
              return [
                `<span class="w-sym">${esc(p.symbol)}</span><span class="w-sub">${esc(num(p.shares))} 股</span>`,
                `<span class="w-chg ${tone(pct)}">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span><span class="w-sub ${tone(pnl)}">${money(pnl)}</span>`,
              ];
            }),
          )
        : '')
    );
  },
};
