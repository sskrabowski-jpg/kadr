import { Link, usePath } from './lib/router.jsx';
import Library from './pages/Library.jsx';
import Recorder from './pages/Recorder.jsx';
import Watch from './pages/Watch.jsx';

export default function App() {
  const path = usePath();
  const watch = path.match(/^\/v\/([A-Za-z0-9]+)\/?$/);

  let page;
  if (path === '/' || path === '') page = <Library />;
  else if (path === '/record') page = <Recorder />;
  else if (watch) page = <Watch id={watch[1]} />;
  else page = <NotFound />;

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-dot" aria-hidden /> Кадр
        </Link>
        {path !== '/record' && (
          <Link to="/record" className="btn btn-primary">
            <span className="rec-dot" aria-hidden /> Записать
          </Link>
        )}
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
