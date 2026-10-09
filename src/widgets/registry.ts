import type { WidgetDef } from './types';
import { schedule } from './schedule';
import { todo } from './todo';
import { reminder } from './reminder';
import { stocks } from './stocks';

// Display order on the home page. Widgets from the API that aren't listed here
// still render (generic fallback), appended after these.
export const registry: WidgetDef[] = [schedule, todo, reminder, stocks];
