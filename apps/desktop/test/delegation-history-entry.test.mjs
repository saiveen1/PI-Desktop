import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('global delegations entry is permanent and independent of active session', async () => {
  const topbar = await readFile(new URL('../src/components/ConversationTopbar.tsx', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/features/app/AppShell.tsx', import.meta.url), 'utf8');
  assert.match(topbar, /onOpenDelegations/);
  assert.match(shell, /<DelegationHistoryDialog/);
});
