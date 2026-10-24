import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BrowserRouter, MemoryRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams, type Location } from 'react-router-dom';
import { authApi, type FetchLike, type User } from './lib/api.js';
import { SessionContext, type Session } from './lib/session.js';
import { LoginPage } from './features/auth/LoginPage.js';
import { JoinPage } from './features/auth/JoinPage.js';
import { Layout } from './shell/Layout.js';
import { HistoryProvider } from './shell/history.js';
import { applyDensity } from './lib/prefs.js';
import { LoadingState, Skel } from './ui/states.js';
import { StoriesPage } from './features/stories/StoriesPage.js';

const StudioScreen = lazy(() => import('./features/studio/StudioScreen.js'));
const GeneratePage = lazy(() => import('./features/generate/GeneratePage.js'));
const PublishPage = lazy(() => import('./features/publish/PublishPage.js'));
const SettingsDialog = lazy(() => import('./features/settings/SettingsDialog.js'));
const ProjectPage = lazy(() => import('./features/project/ProjectPage.js').then(m => ({ default: m.ProjectPage })));
const HomePage = lazy(() => import('./features/home/HomePage.js'));
const TemplatesPage = lazy(() => import('./features/templates/TemplatesPage.js'));

function Loading() {
  return <LoadingState label="Memuat halaman" className="page-skeleton"><Skel w="30%" h={24} /><Skel h={160} /><Skel h={160} /></LoadingState>;
}

function JoinRoute(props: { fetchImpl: FetchLike; onSignedIn: (u: User) => void }) {
  const { token = '' } = useParams();
  return <JoinPage token={token} fetchImpl={props.fetchImpl} onSignedIn={props.onSignedIn} />;
}

const TITLES: Array<[RegExp, string]> = [
  [/^\/template/, 'Template'], [/^\/cerita\/./, 'Proyek'], [/^\/cerita/, 'Proyek'], [/^\/studio/, 'Studio'], [/^\/generate/, 'Naskah & suara'], [/^\/publish/, 'Publish']
];

/** One shell for every signed-in page, so the sidebar keeps its state while you move around. */
function Shell(props: { fetchImpl: FetchLike }) {
  const location = useLocation();
  const background = (location.state as { background?: Location } | null)?.background;
  const settings = location.pathname.startsWith('/pengaturan');
  const main = background ?? location;
  const title = TITLES.find(([re]) => re.test(main.pathname))?.[1] ?? '';
  return (
    <HistoryProvider>
      <Layout title={title} bare={!title}>
        <Suspense fallback={<Loading />}>
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
        </Suspense>
      </Layout>
      {settings && (
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
  if (user === undefined) return <Loading />;

  return (
    <Routes>
      <Route path="/join/:token" element={<JoinRoute fetchImpl={fetchImpl} onSignedIn={signedIn} />} />
      {!session ? (
        <Route path="*" element={<LoginPage fetchImpl={fetchImpl} onSignedIn={signedIn} />} />
      ) : (
        <Route path="*" element={
          <SessionContext.Provider value={session}>
            <Shell fetchImpl={fetchImpl} />
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
