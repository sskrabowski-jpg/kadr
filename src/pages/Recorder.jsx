import { useEffect, useRef, useState } from 'react';
import { api, createChunkUploader } from '../lib/api.js';
import { formatBytes, formatDuration } from '../lib/format.js';
import { navigate } from '../lib/router.jsx';
import {
  MODES, canRecordScreen, composeStream, isSupported, listDevices, openCamera, openScreen,
  pickMimeType, stopStream,
} from '../lib/recorder.js';

const BUBBLE_POSITIONS = [
  ['bottom-left', '↙'],
  ['bottom-right', '↘'],
  ['top-left', '↖'],
  ['top-right', '↗'],
  ['hidden', '⊘'],
];

function load(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export default function Recorder() {
  const [mode, setMode] = useState(() => (canRecordScreen() ? load('kadr.mode', 'screen+cam') : 'cam'));
  const [micOn, setMicOn] = useState(() => load('kadr.mic', '1') === '1');
  const [camId, setCamId] = useState(() => load('kadr.cam', ''));
  const [micId, setMicId] = useState(() => load('kadr.micId', ''));
  const [devices, setDevices] = useState({ cams: [], mics: [] });
  const [title, setTitle] = useState('');
  const [phase, setPhase] = useState('setup'); // setup | countdown | recording | paused | uploading
  const [countdown, setCountdown] = useState(3);
  const [elapsed, setElapsed] = useState(0);
  const [bubble, setBubble] = useState('bottom-left');
  const [upload, setUpload] = useState({ sent: 0, queued: 0 });
  const [error, setError] = useState('');

  const previewRef = useRef(null);
  const camStream = useRef(null); // camera and/or mic
  const rec = useRef(null); // { recorder, composed, screen, uploader, video, clock }

  const needsCam = MODES[mode].cam;

  // Camera / mic preview while in setup.
  useEffect(() => {
    if (phase !== 'setup' || !isSupported()) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await openCamera({ camId, micId, video: needsCam, audio: micOn });
        if (cancelled) return stopStream(s);
        stopStream(camStream.current);
        camStream.current = s;
        if (previewRef.current) previewRef.current.srcObject = s && needsCam ? s : null;
        setError('');
        setDevices(await listDevices()); // labels are only available after permission
      } catch (e) {
        if (!cancelled) setError(permissionMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, needsCam, micOn, camId, micId]);

  // Release everything when leaving the page.
  useEffect(
    () => () => {
      const r = rec.current;
      if (r?.recorder.state !== 'inactive' && r) {
        r.discard = true;
        r.recorder.stop();
      }
      cleanupStreams();
    },
    [],
  );

  // Warn before closing the tab mid-recording.
  useEffect(() => {
    if (phase === 'setup') return;
    const onUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [phase]);

  // Timer.
  useEffect(() => {
    if (phase !== 'recording') return;
    const t = setInterval(() => setElapsed(rec.current.clock.elapsed()), 250);
    return () => clearInterval(t);
  }, [phase]);

  function cleanupStreams() {
    const r = rec.current;
    r?.composed?.stop();
    stopStream(r?.screen);
    stopStream(camStream.current);
    camStream.current = null;
  }

  async function start() {
    setError('');
    const mimeType = pickMimeType();
    if (mimeType == null) return setError('Этот браузер не умеет записывать видео. Попробуйте Chrome, Edge или Firefox.');
    let screen = null;
    try {
      if (MODES[mode].screen) {
        screen = await openScreen(); // must run directly from the click
      }
      if (!camStream.current && (needsCam || micOn)) {
        camStream.current = await openCamera({ camId, micId, video: needsCam, audio: micOn });
      }
    } catch (e) {
      stopStream(screen);
      return setError(e.name === 'NotAllowedError' && MODES[mode].screen && !screen
        ? 'Доступ к экрану не выдан. Нажмите «Начать запись» ещё раз и выберите, что показывать.'
        : permissionMessage(e));
    }

    let video;
    try {
      video = await api.create(title.trim() || defaultTitle(), mimeType || 'video/webm');
    } catch {
      stopStream(screen);
      return setError('Сервер недоступен — не удалось создать запись.');
    }

    const composed = composeStream({ mode, screen, camera: camStream.current });
    composed.setBubble(bubble);
    const uploader = createChunkUploader(video.id, { onProgress: setUpload });
    const recorder = new MediaRecorder(composed.stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 2_500_000,
    });
    recorder.ondataavailable = (e) => {
      if (!rec.current?.discard) uploader.push(e.data);
    };
    recorder.onstop = () => finish();
    screen?.getVideoTracks()[0].addEventListener('ended', () => stop()); // browser's "Stop sharing"

    rec.current = { recorder, composed, screen, uploader, video, clock: makeClock() };
    if (previewRef.current) previewRef.current.srcObject = composed.stream;

    setPhase('countdown');
    for (let i = 3; i > 0; i--) {
      setCountdown(i);
      await new Promise((r) => setTimeout(r, 1000));
      if (!rec.current) return; // cancelled during countdown
    }
    recorder.start(2000);
    rec.current.clock.resume();
    setElapsed(0);
    setPhase('recording');
  }

  function stop() {
    const r = rec.current;
    if (!r || r.recorder.state === 'inactive') return;
    r.clock.pause();
    r.recorder.stop();
  }

  function togglePause() {
    const r = rec.current;
    if (r.recorder.state === 'recording') {
      r.recorder.pause();
      r.clock.pause();
      setPhase('paused');
    } else if (r.recorder.state === 'paused') {
      r.recorder.resume();
      r.clock.resume();
      setPhase('recording');
    }
  }

  async function cancel() {
    const r = rec.current;
    if (!r) return;
    r.discard = true;
    if (r.recorder.state !== 'inactive') r.recorder.stop();
    else finish();
  }

  async function finish() {
    const r = rec.current;
    if (!r || r.finishing) return;
    r.finishing = true;
    cleanupStreams();
    if (previewRef.current) previewRef.current.srcObject = null;

    if (r.discard) {
      rec.current = null;
      api.remove(r.video.id).catch(() => {});
      setPhase('setup');
      return;
    }
    setPhase('uploading');
    try {
      await r.uploader.drain();
      await api.finish(r.video.id, r.clock.elapsed() / 1000);
      rec.current = null;
      navigate(`/v/${r.video.id}?new=1`, { replace: true });
    } catch (e) {
      rec.current = null;
      setPhase('setup');
      setError(
        e.message === 'empty_recording'
          ? 'Запись получилась пустой. Попробуйте ещё раз.'
          : 'Не удалось загрузить видео. Проверьте соединение и попробуйте снова.',
      );
    }
  }

  function changeBubble(pos) {
    setBubble(pos);
    rec.current?.composed.setBubble(pos);
  }

  if (!isSupported()) {
    return (
      <div className="empty">
        <h1>Запись недоступна</h1>
        <p className="muted">
          Нужен современный браузер (Chrome, Edge, Firefox, Safari 15+) и защищённое соединение (HTTPS или localhost).
        </p>
      </div>
    );
  }

  const live = phase === 'recording' || phase === 'paused' || phase === 'countdown';
  const showPreview = live ? true : needsCam;

  return (
    <div className="recorder">
      <section className="stage">
        <div className={`preview ${mode === 'cam' || live ? 'wide' : 'bubble'} ${showPreview ? '' : 'off'}`}>
          <video
            ref={previewRef}
            autoPlay
            muted
            playsInline
            className={!live ? 'mirror' : ''}
            data-testid="preview"
          />
          {!showPreview && <div className="preview-placeholder">Камера выключена</div>}
          {phase === 'countdown' && <div className="countdown" data-testid="countdown">{countdown}</div>}
          {phase === 'uploading' && (
            <div className="overlay">
              <div className="spinner" />
              <p>Сохраняем видео… {upload.queued ? Math.round((upload.sent / upload.queued) * 100) : 100}%</p>
            </div>
          )}
        </div>

        {live && phase !== 'countdown' && (
          <div className="controls" role="toolbar" aria-label="Управление записью">
            <span className={`timer ${phase === 'paused' ? 'paused' : ''}`} data-testid="timer">
              <span className="rec-dot" aria-hidden /> {formatDuration(elapsed / 1000)}
            </span>
            <button className="btn" onClick={togglePause}>
              {phase === 'paused' ? '▶ Продолжить' : '❚❚ Пауза'}
            </button>
            <button className="btn btn-primary" onClick={stop} data-testid="stop">■ Готово</button>
            <button className="btn btn-ghost" onClick={cancel} title="Удалить запись">✕ Отмена</button>
            {mode === 'screen+cam' && (
              <div className="seg" aria-label="Положение камеры">
                {BUBBLE_POSITIONS.map(([pos, icon]) => (
                  <button
                    key={pos}
                    className={bubble === pos ? 'on' : ''}
                    onClick={() => changeBubble(pos)}
                    title={pos === 'hidden' ? 'Скрыть камеру' : 'Переместить камеру'}
                  >
                    {icon}
                  </button>
                ))}
              </div>
            )}
            <span className="muted small">загружено {formatBytes(upload.sent)}</span>
          </div>
        )}
      </section>

      {phase === 'setup' && (
        <aside className="panel">
          <h1>Новая запись</h1>
          <div className="field">
            <span>Что записываем</span>
            <div className="seg seg-wide">
              {Object.entries(MODES).map(([key, m]) => (
                <button
                  key={key}
                  className={mode === key ? 'on' : ''}
                  disabled={m.screen && !canRecordScreen()}
                  onClick={() => {
                    setMode(key);
                    save('kadr.mode', key);
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {needsCam && (
            <label className="field">
              <span>Камера</span>
              <select value={camId} onChange={(e) => { setCamId(e.target.value); save('kadr.cam', e.target.value); }}>
                <option value="">По умолчанию</option>
                {devices.cams.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Камера ${i + 1}`}</option>
                ))}
              </select>
            </label>
          )}

          <div className="field">
            <span className="row">
              Микрофон
              <button
                className={`switch ${micOn ? 'on' : ''}`}
                role="switch"
                aria-checked={micOn}
                onClick={(e) => {
                  e.preventDefault();
                  setMicOn(!micOn);
                  save('kadr.mic', micOn ? '0' : '1');
                }}
              />
            </span>
            {micOn && (
              <select value={micId} onChange={(e) => { setMicId(e.target.value); save('kadr.micId', e.target.value); }}>
                <option value="">По умолчанию</option>
                {devices.mics.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Микрофон ${i + 1}`}</option>
                ))}
              </select>
            )}
          </div>

          {mode === 'screen+cam' && (
            <div className="field">
              <span>Положение камеры на видео</span>
              <div className="seg">
                {BUBBLE_POSITIONS.map(([pos, icon]) => (
                  <button key={pos} className={bubble === pos ? 'on' : ''} onClick={() => setBubble(pos)}>{icon}</button>
                ))}
              </div>
            </div>
          )}

          <label className="field">
            <span>Название (можно потом)</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={defaultTitle()} maxLength={200} />
          </label>

          {error && <p className="error" role="alert">{error}</p>}

          <button className="btn btn-primary btn-lg" onClick={start} data-testid="start">
            <span className="rec-dot" aria-hidden /> Начать запись
          </button>
          {MODES[mode].screen && (
            <p className="muted small">
              Браузер спросит, что показывать: весь экран, окно или вкладку. Чтобы записать звук вкладки, отметьте «Поделиться аудио».
            </p>
          )}
        </aside>
      )}
    </div>
  );
}

function makeClock() {
  let acc = 0;
  let since = null;
  return {
    resume() {
      if (since == null) since = performance.now();
    },
    pause() {
      if (since != null) acc += performance.now() - since;
      since = null;
    },
    elapsed() {
      return acc + (since != null ? performance.now() - since : 0);
    },
  };
}

function defaultTitle() {
  return `Запись от ${new Date().toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`;
}

function permissionMessage(e) {
  if (e?.name === 'NotAllowedError') return 'Нет доступа к камере или микрофону. Разрешите доступ в настройках сайта в браузере.';
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return 'Устройство не найдено. Выберите другую камеру или микрофон.';
  if (e?.name === 'NotReadableError') return 'Камера или микрофон заняты другим приложением.';
  return `Не удалось получить доступ к устройствам: ${e?.message || e}`;
}
