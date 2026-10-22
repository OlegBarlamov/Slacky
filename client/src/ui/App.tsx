import { useEffect } from 'react';
import { href, replaceRoute, useHistoryNav, useRoute, type Route } from '../state/route';
import { loadBootstrap, useStore } from '../state/store';
import { ActivityFeed } from './ActivityFeed';
import { ConversationView } from './ConversationView';
import { Login } from './Login';
import { SearchBox } from './SearchBox';
import { SearchView } from './SearchView';
import { Sidebar } from './Sidebar';
import { ThreadPane } from './ThreadPane';
import { ThreadsView } from './ThreadsView';

export function App() {
  const status = useStore((s) => s.status);
  useEffect(() => {
    void loadBootstrap();
  }, []);
  if (status === 'loading') return <div className="grid h-screen place-items-center text-gray-400">Loading…</div>;
  if (status === 'anon') return <Login />;
  return <Shell />;
}

function Shell() {
  const route = useRoute();
  const convs = useStore((s) => s.convs);

  useEffect(() => {
    if (route.name !== 'home') return;
    const general = Object.values(convs).find((v) => v.conversation.name === 'general') ?? Object.values(convs)[0];
    if (general) replaceRoute(href.conv(general.conversation.id)); // replace, so Back doesn't bounce here
  }, [route.name, convs]);

  return (
    <div className="flex h-screen flex-col text-gray-900">
      <TopBar route={route} />
      <div className="flex min-h-0 flex-1">
        <Sidebar route={route} />
        <main className="flex min-w-0 flex-1">
          {route.name === 'activity' && <ActivityFeed filter={route.filter} unreadOnly={route.unreadOnly} />}
          {route.name === 'threads' && <ThreadsView key={String(route.unreadOnly)} unreadOnly={route.unreadOnly} />}
          {route.name === 'search' && <SearchView q={route.q} />}
          {route.name === 'conv' && (
            <>
              <ConversationView key={route.convId} convId={route.convId} msgId={route.msgId} threadOpen={!!route.threadId} />
              {route.threadId && <ThreadPane key={route.threadId} convId={route.convId} rootId={route.threadId} msgId={route.msgId} />}
            </>
          )}
        </main>
      </div>
      <Toast />
    </div>
  );
}

function TopBar({ route }: { route: Route }) {
  const conn = useStore((s) => s.conn);
  const { canGoBack, canGoForward } = useHistoryNav();
  const navButton = 'grid h-7 w-7 place-items-center rounded text-white/80 hover:bg-white/15 disabled:opacity-30 disabled:hover:bg-transparent';
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 bg-[#350d36] px-3">
      <div className="flex shrink-0 gap-1">
        <button className={navButton} disabled={!canGoBack} onClick={() => history.back()} title="Back" aria-label="Back">
          ←
        </button>
        <button className={navButton} disabled={!canGoForward} onClick={() => history.forward()} title="Forward" aria-label="Forward">
          →
        </button>
      </div>
      <SearchBox initial={route.name === 'search' ? route.q : ''} />
      {conn !== 'open' && <span className="shrink-0 rounded bg-amber-400 px-2 py-0.5 text-xs font-semibold text-amber-950">{conn === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span>}
    </div>
  );
}

function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  return <div className="fixed bottom-14 left-1/2 z-50 -translate-x-1/2 rounded-md bg-gray-900 px-4 py-2 text-sm text-white shadow-lg">{toast}</div>;
}
