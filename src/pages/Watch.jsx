import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { copyText, formatDate, formatDuration, plural, shareUrl } from '../lib/format.js';
import { Link, navigate } from '../lib/router.jsx';

export default function Watch({ id }) {
  const [video, setVideo] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const isNew = new URLSearchParams(location.search).has('new');
  const counted = useRef(false);

  // Load, and poll while the server is still processing.
  useEffect(() => {
    let timer;
    let alive = true;
    const load = async () => {
      try {
        const v = await api.get(id);
        if (!alive) return;
        setVideo(v);
        if (v.status !== 'ready') timer = setTimeout(load, 1500);
      } catch (e) {
        if (alive) setError(e.status === 404 ? 'Видео не найдено или удалено.' : 'Не удалось загрузить видео.');
      }
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id]);

  // Copy the link right away after recording, like it should be.
  useEffect(() => {
    if (isNew && video) {
      copyText(shareUrl(id)).then((ok) => ok && flashCopied());
      history.replaceState(null, '', `/v/${id}`);
    }
  }, [isNew, !!video]);

  function flashCopied() {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function onPlay() {
    if (counted.current || video?.isOwner) return;
    counted.current = true;
    api.view(id).catch(() => {});
  }

  async function remove() {
    if (!confirm('Удалить видео навсегда? Ссылка перестанет работать.')) return;
    await api.remove(id);
    navigate('/', { replace: true });
  }

  async function rename(title) {
    setEditing(false);
    const t = title.trim();
    if (!t || t === video.title) return;
    setVideo(await api.rename(id, t));
  }

  if (error) {
    return (
      <div className="empty">
        <h1>{error}</h1>
        <Link to="/" className="btn">К моим видео</Link>
      </div>
    );
  }
  if (!video) return <div className="empty"><div className="spinner" /></div>;

  return (
    <article className="watch">
      <div className="player">
        {video.status === 'ready' && video.videoUrl ? (
          <Player src={video.videoUrl} poster={video.thumbUrl} duration={video.duration} onPlay={onPlay} />
        ) : (
          <div className="processing" data-testid="processing">
            <div className="spinner" />
            <p>{video.status === 'recording' ? 'Запись ещё идёт…' : 'Обрабатываем видео — это займёт несколько секунд'}</p>
            <p className="muted small">Ссылкой уже можно делиться.</p>
          </div>
        )}
      </div>

      <div className="meta">
        <div className="meta-main">
          {editing ? (
            <input
              className="title-input"
              defaultValue={video.title}
              autoFocus
              maxLength={200}
              onBlur={(e) => rename(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') setEditing(false);
              }}
            />
          ) : (
            <h1
              className={video.isOwner ? 'editable' : ''}
              title={video.isOwner ? 'Нажмите, чтобы переименовать' : undefined}
              onClick={() => video.isOwner && setEditing(true)}
              data-testid="title"
            >
              {video.title}
            </h1>
          )}
          <p className="muted">
            {formatDate(video.createdAt)} · {formatDuration(video.duration)} · {video.views}{' '}
            {plural(video.views, 'просмотр', 'просмотра', 'просмотров')}
          </p>
        </div>
        <div className="actions">
          <button
            className="btn btn-primary"
            data-testid="copy"
            onClick={async () => (await copyText(shareUrl(id))) && flashCopied()}
          >
            {copied ? '✓ Ссылка скопирована' : '🔗 Копировать ссылку'}
          </button>
          {video.status === 'ready' && video.videoUrl && (
            <a className="btn" href={video.videoUrl} download={`${video.title}.${video.videoUrl.split('.').pop()}`}>
              ⬇ Скачать
            </a>
          )}
          {video.isOwner && (
            <button className="btn btn-ghost danger" onClick={remove}>Удалить</button>
          )}
        </div>
      </div>

      {video.isOwner && (
        <div className="share-box">
          <span className="muted small">Ссылка для просмотра — открывается у любого, кто её получил:</span>
          <input readOnly value={shareUrl(id)} onFocus={(e) => e.target.select()} data-testid="share-url" />
        </div>
      )}
    </article>
  );
}

const SPEEDS = [1, 1.25, 1.5, 1.75, 2];

function Player({ src, poster, duration, onPlay }) {
  const ref = useRef(null);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    const v = ref.current;
    // WebM straight from MediaRecorder reports duration=Infinity until the end is
    // found; seeking far forward once makes the browser compute it.
    const fix = () => {
      if (v.duration === Infinity) {
        v.currentTime = 1e101;
        v.addEventListener('timeupdate', () => (v.currentTime = 0), { once: true });
      }
    };
    v.addEventListener('loadedmetadata', fix);
    return () => v.removeEventListener('loadedmetadata', fix);
  }, [src]);

  useEffect(() => {
    if (ref.current) ref.current.playbackRate = speed;
  }, [speed]);

  return (
    <>
      <video
        ref={ref}
        src={src}
        poster={poster || undefined}
        controls
        playsInline
        preload="metadata"
        onPlay={onPlay}
        data-testid="player"
        data-duration={duration ?? ''}
      />
      <div className="speeds" aria-label="Скорость">
        {SPEEDS.map((s) => (
          <button key={s} className={s === speed ? 'on' : ''} onClick={() => setSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>
    </>
  );
}
