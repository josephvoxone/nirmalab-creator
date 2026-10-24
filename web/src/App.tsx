import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BrowserRouter, MemoryRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams, type Location } from 'react-router-dom';
import { authApi, type FetchLike, type User } from './lib/api.js';
import { SessionContext, type Session } from './lib/session.js';
import { LoginPage } from './features/auth/LoginPage.js';
import { JoinPage } from './features/auth/JoinPage.js';
import { Layout } from './shell/Layout.js';
import { HistoryProvider } from './shell/history.js';
import { applyDensity } from './lib/prefs.js';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadingState } from './ui/states.js';
import { StoriesPage } from './features/stories/StoriesPage.js';

const StudioScreen = lazy(() => import('./features/studio/StudioScreen.js'));
const GeneratePage = lazy(() => import('./features/generate/GeneratePage.js'));
const PublishPage = lazy(() => import('./features/publish/PublishPage.js'));
const SettingsDialog = lazy(() => import('./features/settings/SettingsDialog.js'));
const ProjectPage = lazy(() => import('./features/project/ProjectPage.js').then(m => ({ default: m.ProjectPage })));
const HomePage = lazy(() => import('./features/home/HomePage.js'));
const TemplatesPage = lazy(() => import('./features/templates/TemplatesPage.js'));

/** Content skeleton for the main area (session check and lazy routes); the sidebar stays. */
function Loading() {
  return (
    <LoadingState label="Memuat halaman" className="mx-auto flex w-full max-w-[1100px] flex-col gap-3 px-4 pt-3 md:px-6">
      <Skeleton className="h-4 w-2/5" />
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-40 rounded-lg" />)}
      </div>
      <Skeleton className="h-24 rounded-lg" />
    </LoadingState>
  );
}

function JoinRoute(props: { fetchImpl: FetchLike; onSignedIn: (u: User) => void }) {
  const { token = '' } = useParams();
  return <JoinPage token={token} fetchImpl={props.fetchImpl} onSignedIn={props.onSignedIn} />;
}

const TITLES: Array<[RegExp, string]> = [
  [/^\/template/, 'Template'], [/^\/cerita\/./, 'Proyek'], [/^\/cerita/, 'Proyek'], [/^\/studio/, 'Studio'], [/^\/generate/, 'Naskah & suara'], [/^\/publish/, 'Publish']
];

const titleFor = (path: string) => TITLES.find(([re]) => re.test(path))?.[1] ?? '';

/** One shell for every signed-in page, so the sidebar keeps its state while you move around. */
function Shell(props: { fetchImpl: FetchLike; pending?: boolean }) {
  const location = useLocation();
  const background = (location.state as { background?: Location } | null)?.background;
  const settings = location.pathname.startsWith('/pengaturan');
  const main = background ?? location;
  const title = titleFor(main.pathname);
  return (
    <HistoryProvider>
      <Layout title={title} bare={!title} pending={props.pending}>
        {props.pending ? <Loading /> : <Suspense fallback={<Loading />}>
          <Routes location={main}>
            <Route path="/" element={<HomePage />} />
            <Route path="/template" element={<TemplatesPage />} />
            <Route path="/cerita" element={<StoriesPage />} />
            <Route path="/cerita/:id" element={<ProjectPage />} />
            <Route path="/studio" element={<StudioScreen baseUrl="" fetchImpl={props.fetchImpl} />} />
            <Route path="/generate" element={<GeneratePage />} />
            <Route path="/publish" element={<PublishPage />} />
            <Route path="/pengaturan/*" element={<HomePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>}
      </Layout>
      {settings && !props.pending && (
        <Suspense fallback={null}>
          <Routes>
            <Route path="/pengaturan" element={<SettingsDialog />} />
            <Route path="/pengaturan/:tab" element={<SettingsDialog />} />
          </Routes>
        </Suspense>
      )}
    </HistoryProvider>
  );
}

function Routed(props: { fetchImpl: FetchLike }) {
  const { fetchImpl } = props;
  const navigate = useNavigate();
  const location = useLocation();
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    authApi(fetchImpl).me().then(r => alive && setUser(r.user), () => alive && setUser(null));
    return () => { alive = false; };
  }, [fetchImpl]);

  const signedIn = useCallback((u: User) => { setUser(u); navigate('/', { replace: true }); }, [navigate]);
  const session = useMemo<Session | null>(() => (user ? {
    user,
    fetchImpl,
    signOut: async () => { await authApi(fetchImpl).logout().catch(() => undefined); setUser(null); navigate('/', { replace: true }); }
  } : null), [user, fetchImpl, navigate]);

  useEffect(() => applyDensity(), []);
  // The invite page has no sidebar: a plain skeleton while the session check runs.
  if (user === undefined && location.pathname.startsWith('/join/')) return <Loading />;

  // Hard refresh: the real shell renders at once (sidebar, nav, skeletons) while /api/auth/me
  // is pending, and stays mounted when the session arrives (same element, `pending` flips).
  return (
    <Routes>
      <Route path="/join/:token" element={<JoinRoute fetchImpl={fetchImpl} onSignedIn={signedIn} />} />
      {user === null ? (
        <Route path="*" element={<LoginPage fetchImpl={fetchImpl} onSignedIn={signedIn} />} />
      ) : (
        <Route path="*" element={
          <SessionContext.Provider value={session}>
            <Shell fetchImpl={fetchImpl} pending={!session} />
          </SessionContext.Provider>
        } />
      )}
    </Routes>
  );
}

export function App(props: { fetchImpl?: FetchLike; initialPath?: string }) {
  const fetchImpl = useMemo<FetchLike>(() => props.fetchImpl ?? ((url, init) => fetch(url, init)), [props.fetchImpl]);
  if (props.initialPath !== undefined) {
    return <MemoryRouter initialEntries={[props.initialPath]}><Routed fetchImpl={fetchImpl} /></MemoryRouter>;
  }
  return <BrowserRouter><Routed fetchImpl={fetchImpl} /></BrowserRouter>;
}
