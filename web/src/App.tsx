import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BrowserRouter, MemoryRouter, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { authApi, type FetchLike, type User } from './lib/api.js';
import { SessionContext, type Session } from './lib/session.js';
import { LoginPage } from './features/auth/LoginPage.js';
import { JoinPage } from './features/auth/JoinPage.js';
import { Layout } from './shell/Layout.js';
import { LoadingState, Skel } from './ui/states.js';
import { StoriesPage } from './features/stories/StoriesPage.js';
import { StoryDetailPage } from './features/stories/StoryDetailPage.js';

const StudioScreen = lazy(() => import('./features/studio/StudioScreen.js'));
const GeneratePage = lazy(() => import('./features/generate/GeneratePage.js'));
const PublishPage = lazy(() => import('./features/publish/PublishPage.js'));
const SettingsPage = lazy(() => import('./features/settings/SettingsPage.js'));

function Loading() {
  return <LoadingState label="Memuat halaman" className="page-skeleton"><Skel w="30%" h={24} /><Skel h={160} /><Skel h={160} /></LoadingState>;
}

function JoinRoute(props: { fetchImpl: FetchLike; onSignedIn: (u: User) => void }) {
  const { token = '' } = useParams();
  return <JoinPage token={token} fetchImpl={props.fetchImpl} onSignedIn={props.onSignedIn} />;
}

function Page(props: { title: string; children: ReactNode }) {
  return (
    <Layout title={props.title}>
      <Suspense fallback={<Loading />}>{props.children}</Suspense>
    </Layout>
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

  const signedIn = useCallback((u: User) => { setUser(u); navigate('/cerita', { replace: true }); }, [navigate]);
  const session = useMemo<Session | null>(() => (user ? {
    user,
    fetchImpl,
    signOut: async () => { await authApi(fetchImpl).logout().catch(() => undefined); setUser(null); navigate('/', { replace: true }); }
  } : null), [user, fetchImpl, navigate]);

  if (user === undefined) return <Loading />;

  return (
    <Routes>
      <Route path="/join/:token" element={<JoinRoute fetchImpl={fetchImpl} onSignedIn={signedIn} />} />
      {!session ? (
        <Route path="*" element={<LoginPage fetchImpl={fetchImpl} onSignedIn={signedIn} />} />
      ) : (
        <Route path="*" element={
          <SessionContext.Provider value={session}>
            <Routes>
              <Route path="/" element={<Navigate to="/cerita" replace />} />
              <Route path="/cerita" element={<Page title="Cerita"><StoriesPage /></Page>} />
              <Route path="/cerita/:id" element={<Page title="Cerita"><StoryDetailPage /></Page>} />
              <Route path="/studio" element={<Page title="Studio"><StudioScreen baseUrl="" fetchImpl={fetchImpl} /></Page>} />
              <Route path="/generate" element={<Page title="Alat cepat"><GeneratePage /></Page>} />
              <Route path="/publish" element={<Page title="Publish"><PublishPage /></Page>} />
              <Route path="/pengaturan" element={<Page title="Pengaturan"><SettingsPage /></Page>} />
              <Route path="*" element={<Navigate to="/cerita" replace />} />
            </Routes>
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
