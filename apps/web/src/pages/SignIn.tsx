import { useState } from 'react';
import { useApp } from '../session.tsx';
import { ErrorNote } from '../ui.tsx';

export function SignIn() {
  const { supabase } = useApp();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const redirectTo = `${location.origin}/projects`;

  const oauth = async (provider: 'github' | 'google') => {
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo } });
    if (error) setError(error);
  };

  return (
    <main className="signin">
      <h1>Git2App</h1>
      <p className="lead">Turn your web app on GitHub into Android and iPhone apps.</p>
      <div className="stack">
        <button className="btn btn-secondary btn-wide" onClick={() => void oauth('github')}>
          Continue with GitHub
        </button>
        <button className="btn btn-secondary btn-wide" onClick={() => void oauth('google')}>
          Continue with Google
        </button>
      </div>
      <div className="divider">or</div>
      {sent ? (
        <p className="note">Check your email for a sign-in link.</p>
      ) : (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
            if (error) setError(error);
            else setSent(true);
          }}
        >
          <label className="field">
            <span>Email</span>
            <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <button className="btn btn-primary btn-wide" type="submit">
            Email me a sign-in link
          </button>
        </form>
      )}
      <ErrorNote error={error} />
    </main>
  );
}
