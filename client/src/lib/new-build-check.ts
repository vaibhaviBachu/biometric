/**
 * Keeps an open tab on the newest deploy. A page loaded before a deploy keeps running the old code until it is reloaded,
 * so people kept testing screens that had already been replaced. This checks the deployed entry file every few minutes
 * and when the tab comes back into view. When it has changed, the page reloads at a safe moment: when the tab is shown
 * again or on the next page change, never in the middle of what someone is doing on the current page.
 */
interface RouterLike {
  state: { location: { pathname: string } };
  subscribe(fn: (state: { location: { pathname: string } }) => void): unknown;
}

const ENTRY = /\/static\/index-[A-Za-z0-9_-]+\.js/;
const CHECK_EVERY_MS = 5 * 60_000;

function runningEntry(): string | null {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/static/index-"]');
  const match = script?.src.match(ENTRY);
  return match ? match[0] : null;
}

export function watchForNewBuild(router: RouterLike): void {
  const running = runningEntry();
  if (!running || import.meta.env.DEV) return;
  let newBuild = false;

  const check = async () => {
    if (newBuild) return;
    try {
      const res = await fetch(`/?build-check=${Date.now()}`, { cache: 'no-store' });
      const deployed = (await res.text()).match(ENTRY)?.[0];
      if (deployed && deployed !== running) newBuild = true;
    } catch { /* offline: try again later */ }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (newBuild) window.location.reload();
    else void check();
  });
  let lastPath = router.state.location.pathname;
  router.subscribe((state) => {
    const path = state.location.pathname;
    if (path === lastPath) return;
    lastPath = path;
    if (newBuild) window.location.reload();
  });
  window.setInterval(() => { void check(); }, CHECK_EVERY_MS);
}
