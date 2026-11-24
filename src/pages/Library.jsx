import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { copyText, formatDate, formatDuration, plural, shareUrl } from '../lib/format.js';
import { Link } from '../lib/router.jsx';

export default function Library() {
  const [videos, setVideos] = useState(null);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState(null);

  useEffect(() => {
    let timer;
    let alive = true;
    const load = async () => {
      try {
        const list = await api.list();
        if (!alive) return;
        setVideos(list);
        if (list.some((v) => v.status === 'processing')) timer = setTimeout(load, 2000);
      } catch {
        if (alive) setError('Сервер недоступен.');
      }
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  async function remove(id) {
    if (!confirm('Удалить видео навсегда?')) return;
    await api.remove(id);
    setVideos((vs) => vs.filter((v) => v.id !== id));
  }

  async function copy(id) {
    if (await copyText(shareUrl(id))) {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    }
  }

  if (error) return <div className="empty"><p className="error">{error}</p></div>;
  if (!videos) return <div className="empty"><div className="spinner" /></div>;

  // Recordings abandoned mid-way (tab closed) never got "finish" — hide them.
  const shown = videos.filter((v) => v.status !== 'recording');

  if (shown.length === 0) {
    return (
      <div className="empty hero">
        <h1>Покажите, а не пишите</h1>
        <p className="muted">
          Запишите экран и себя за пару кликов — ссылка на видео появится сразу после остановки.
        </p>
        <Link to="/record" className="btn btn-primary btn-lg">
          <span className="rec-dot" aria-hidden /> Записать первое видео
        </Link>
      </div>
    );
  }

  return (
    <section className="library">
      <h1>
        Мои видео <span className="muted">{shown.length}</span>
      </h1>
      <ul className="grid" data-testid="library">
        {shown.map((v) => (
          <li key={v.id} className="card">
            <Link to={`/v/${v.id}`} className="thumb">
              {v.thumbUrl ? <img src={v.thumbUrl} alt="" loading="lazy" /> : <div className="thumb-empty">▶</div>}
              {v.status === 'processing' ? (
                <span className="badge">обработка…</span>
              ) : (
                <span className="badge">{formatDuration(v.duration)}</span>
              )}
            </Link>
            <div className="card-body">
              <Link to={`/v/${v.id}`} className="card-title">{v.title}</Link>
              <p className="muted small">
                {formatDate(v.createdAt)} · {v.views} {plural(v.views, 'просмотр', 'просмотра', 'просмотров')}
              </p>
              <div className="card-actions">
                <button className="btn btn-sm" onClick={() => copy(v.id)}>
                  {copiedId === v.id ? '✓ Скопировано' : '🔗 Ссылка'}
                </button>
                <button className="btn btn-sm btn-ghost danger" onClick={() => remove(v.id)}>Удалить</button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
