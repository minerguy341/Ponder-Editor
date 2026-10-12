import { defineConfig } from 'vitest/config';

// Agent worktrees live under .claude/worktrees; never collect their (possibly stale) copies of the tests.
export default defineConfig({
  test: { exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'] },
});
