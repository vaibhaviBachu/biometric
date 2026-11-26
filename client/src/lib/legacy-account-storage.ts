/**
 * PINIT Hub is released for Personal accounts only. There is no account type to choose and no workspace to switch, so the browser
 * keys the old picker, the Business shell and the workspace switcher used to keep are dead weight. They are removed once on load so
 * an existing user's browser does not carry a stale choice (for example a remembered Business view) anywhere.
 *
 * Not touched: `pinit_last_account` (the Pinit ID remembered to prefill sign-in; not an account selection).
 */
const LOCAL_PREFIXES = [
  'pinit_account_type_done_',
  'pinit_chosen_account_type_',
  'pinit_business_setup_done_',
  'pinit_account_view:',
  'pinit_active_workspace:',
  'pinit_pending_team_invite',
  'pinit_selected_account',
  'pinit_active_account',
  'selectedAccount',
  'activeAccount',
  'activeWorkspace',
];
const SESSION_PREFIXES = [
  'pinit_pre_register_account_type',
  'pinit_account_view',
  'pinit_pending_team_invite',
  'selectedAccount',
  'activeAccount',
  'activeWorkspace',
];

function purge(store: Storage, prefixes: string[]): void {
  const doomed: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key && prefixes.some((p) => key.startsWith(p))) doomed.push(key);
  }
  doomed.forEach((key) => store.removeItem(key));
}

export function purgeLegacyAccountStorage(): void {
  try { purge(localStorage, LOCAL_PREFIXES); } catch { /* privacy mode */ }
  try { purge(sessionStorage, SESSION_PREFIXES); } catch { /* privacy mode */ }
}
