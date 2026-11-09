// The production cutover lives in a remote plain_text var, not in [vars].
// `wrangler deploy` deletes plain_text bindings that are absent from the
// config unless keep_vars is set. This locks that switch so the next
// GitHub Actions deploy does not drop TASKS_SCHEMA.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const lines = toml.split('\n').filter((line) => !/^\s*#/.test(line));

describe('wrangler deploy keeps the remote tasks gate', () => {
  it('sets keep_vars and does not assign TASKS_SCHEMA', () => {
    expect(lines.some((line) => /^\s*keep_vars\s*=\s*true\s*$/.test(line))).toBe(true);
    expect(lines.some((line) => /^\s*TASKS_SCHEMA\s*=/.test(line))).toBe(false);
    expect(lines.some((line) => /^\s*FEISHU_BASE_TOKEN\s*=/.test(line))).toBe(true);
    expect(lines.some((line) => /^\s*FEISHU_TABLE_ID\s*=/.test(line))).toBe(true);
  });
});
