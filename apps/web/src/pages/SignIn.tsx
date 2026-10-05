import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client.js';
import { useBootstrapPassword, useLogin } from '../api/hooks.js';
import { Banner, Button, Card, Field, inputClass } from '../components/ui.js';

const MIN_PASSWORD_LENGTH = 12;

/**
 * Shown instead of the app when the server enforces a login.
 *
 * A server with no password yet asks for the setup code from its startup log, so
 * only someone who can see that log can claim it.
 */
export function SignInPage({ configured }: { configured: boolean }) {
  return (
    <div className="mx-auto grid w-full max-w-md gap-4">
      {configured ? <LoginForm /> : <FirstPasswordForm />}
    </div>
  );
}

function LoginForm() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const login = useLogin();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await login.mutateAsync({ password });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    }
  };

  return (
    <Card title="Sign in" description="This server is reachable from your network.">
      <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
        <Field label="Administrator password" htmlFor="signin-password">
          <input
            id="signin-password"
            type="password"
            className={inputClass}
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        {error && <Banner tone="bad">{error}</Banner>}
        <Button type="submit" variant="primary" busy={login.isPending} disabled={!password}>
          Sign in
        </Button>
      </form>
    </Card>
  );
}

function FirstPasswordForm() {
  const [setupToken, setSetupToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const bootstrap = useBootstrapPassword();

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready =
    setupToken.trim() !== '' && password.length >= MIN_PASSWORD_LENGTH && confirm === password;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await bootstrap.mutateAsync({ password, setupToken: setupToken.trim() });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    }
  };

  return (
    <Card
      title="Choose an administrator password"
      description="This server is reachable from your network, so it needs a password before it can be used."
    >
      <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
        <Field
          label="Setup code"
          htmlFor="setup-token"
          help={
            <>
              Printed in the server log at startup (<code>docker logs</code> for a container), and
              saved as <code>setup-token</code> in the data directory. It proves you run this
              server.
            </>
          }
        >
          <input
            id="setup-token"
            className={`${inputClass} font-mono`}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            value={setupToken}
            onChange={(event) => setSetupToken(event.target.value)}
          />
        </Field>
        <Field
          label="New password"
          htmlFor="new-password"
          help={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          error={tooShort ? `Use at least ${MIN_PASSWORD_LENGTH} characters.` : undefined}
        >
          <input
            id="new-password"
            type="password"
            className={inputClass}
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Field
          label="Confirm password"
          htmlFor="confirm-password"
          error={mismatch ? 'The passwords do not match.' : undefined}
        >
          <input
            id="confirm-password"
            type="password"
            className={inputClass}
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </Field>
        {error && <Banner tone="bad">{error}</Banner>}
        <Button type="submit" variant="primary" busy={bootstrap.isPending} disabled={!ready}>
          Set password and sign in
        </Button>
      </form>
    </Card>
  );
}
