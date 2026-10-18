import { useState } from 'react';
import { ApiError } from '../transport/api';
import { signIn } from '../state/store';

export function Login() {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(mode: 'login' | 'register') {
    setBusy(true);
    setError(null);
    setMissing(false);
    try {
      await signIn(name, mode);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else setError(e instanceof ApiError ? e.message : 'Network error, try again');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-screen grid place-items-center bg-[#3f0e40]">
      <form
        className="w-80 bg-white rounded-xl p-6 shadow-xl space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit('login');
        }}
      >
        <div>
          <h1 className="text-xl font-bold">Sign in to Slacky</h1>
          <p className="text-sm text-gray-500">Just a name. Try alice, ben or dana from the seeded team.</p>
        </div>
        <input
          autoFocus
          className="w-full border rounded-md px-3 py-2 outline-none focus:ring-2 ring-sky-500"
          placeholder="your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {missing && (
          <p className="text-sm">
            No user named <b>{name.trim()}</b>.{' '}
            <button type="button" className="text-sky-700 underline" onClick={() => submit('register')}>
              Create it?
            </button>
          </p>
        )}
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <div className="flex gap-2">
          <button disabled={busy || !name.trim()} className="flex-1 bg-[#007a5a] text-white rounded-md py-2 font-semibold disabled:opacity-50">
            Log in
          </button>
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => submit('register')}
            className="flex-1 border rounded-md py-2 font-semibold disabled:opacity-50"
          >
            Create user
          </button>
        </div>
      </form>
    </div>
  );
}
