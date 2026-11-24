import { useEffect, useState } from 'react';
import { api } from './lib/api.js';
import { Link, usePath } from './lib/router.jsx';
import Library from './pages/Library.jsx';
import Login from './pages/Login.jsx';
import Recorder from './pages/Recorder.jsx';
import Watch from './pages/Watch.jsx';

export default function App() {
  const path = usePath();
  const watch = path.match(/^\/v\/([A-Za-z0-9]+)\/?$/);
  const [auth, setAuth] = useState(null); // { required, loggedIn }

  const refreshAuth = () =>
    api.authStatus().then(setAuth).catch(() => setAuth({ required: false, loggedIn: true }));
  useEffect(() => {
    refreshAuth();
  }, []);

  const canRecord = auth?.loggedIn;

  let page;
  if (watch) page = <Watch key={watch[1]} id={watch[1]} />; // public, no login needed
  else if (!auth) page = <div className="empty"><div className="spinner" /></div>;
  else if (!canRecord && (path === '/' || path === '/record')) page = <Login onDone={refreshAuth} />;
  else if (path === '/' || path === '') page = <Library />;
  else if (path === '/record') page = <Recorder />;
  else page = <NotFound />;

  async function logout() {
    await api.logout().catch(() => {});
    refreshAuth();
  }

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-dot" aria-hidden /> Кадр
        </Link>
        <div className="row">
          {canRecord && path !== '/record' && (
            <Link to="/record" className="btn btn-primary">
              <span className="rec-dot" aria-hidden /> Записать
            </Link>
          )}
          {auth?.required && auth.loggedIn && (
            <button className="btn btn-ghost" onClick={logout}>Выйти</button>
          )}
        </div>
      </header>
      <main>{page}</main>
    </>
  );
}

function NotFound() {
  return (
    <div className="empty">
      <h1>Страница не найдена</h1>
      <Link to="/" className="btn">На главную</Link>
    </div>
  );
}
