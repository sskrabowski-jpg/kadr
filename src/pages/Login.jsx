import { useState } from 'react';
import { api } from '../lib/api.js';

export default function Login({ onDone }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(password);
      onDone();
    } catch (err) {
      setError(
        err.status === 429
          ? 'Слишком много попыток. Подождите 15 минут.'
          : err.status === 401
            ? 'Неверный пароль.'
            : 'Сервер недоступен.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel login" onSubmit={submit}>
      <h1>Вход</h1>
      <p className="muted small">Записывать видео могут только участники. Смотреть по ссылке можно без пароля.</p>
      <label className="field">
        <span>Пароль</span>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="password"
        />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn btn-primary btn-lg" disabled={busy || !password}>Войти</button>
    </form>
  );
}
