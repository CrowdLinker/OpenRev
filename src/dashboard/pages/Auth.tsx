import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Logo } from "../components/Shell";
import { Button, ErrorBox, Field, Loading } from "../components/ui";
import { api, useApi } from "../lib/api";
import { useAuth } from "../lib/context";

function AuthCard({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <Logo className="mb-8 text-lg" />
      <div className="card w-full max-w-sm p-7">
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { refresh, instance } = useAuth();
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { body: { email, password } });
      refresh();
      navigate("/");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Welcome back" subtitle="Sign in to your OpenRev dashboard.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Password">
          <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorBox error={error} />
        <Button variant="primary" className="w-full" loading={busy} type="submit">
          Sign in
        </Button>
      </form>
      {instance?.signupEnabled && (
        <p className="mt-5 text-center text-sm text-zinc-500">
          No account?{" "}
          <Link href="/signup" className="font-medium text-brand-600 hover:underline">
            Create one
          </Link>
        </p>
      )}
    </AuthCard>
  );
}

function SignupForm({ invite, onDone, email: presetEmail }: { invite?: string; onDone: () => void; email?: string | null }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState(presetEmail ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/signup", { body: { name, email, password, invite } });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Name">
        <input className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <Field label="Email">
        <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Password" help="At least 8 characters.">
        <input className="input" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <ErrorBox error={error} />
      <Button variant="primary" className="w-full" loading={busy} type="submit">
        Create account
      </Button>
    </form>
  );
}

export function SignupPage() {
  const { refresh, instance } = useAuth();
  const [, navigate] = useLocation();
  const first = !instance?.hasUsers;
  if (!first && !instance?.signupEnabled) {
    return (
      <AuthCard title="Sign-ups are closed" subtitle="Ask the admin of this OpenRev instance to invite you.">
        <Link href="/login" className="text-sm font-medium text-brand-600 hover:underline">
          ← Back to sign in
        </Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard
      title={first ? "Set up OpenRev" : "Create your account"}
      subtitle={first ? "Create the admin account for this instance. You'll add your first website next." : undefined}
    >
      <SignupForm
        onDone={() => {
          refresh();
          navigate(first ? "/sites/new" : "/");
        }}
      />
      {!first && (
        <p className="mt-5 text-center text-sm text-zinc-500">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-brand-600 hover:underline">
            Sign in
          </Link>
        </p>
      )}
    </AuthCard>
  );
}

export function InvitePage({ token }: { token: string }) {
  const { user, refresh } = useAuth();
  const [, navigate] = useLocation();
  const invite = useApi<{ site: { name: string; domain: string } | null; role: string; email: string | null }>(`/api/invites/${token}`);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (invite.loading) return <Loading className="min-h-screen" />;
  if (invite.error)
    return (
      <AuthCard title="Invitation not found" subtitle={invite.error.message}>
        <Link href="/" className="text-sm font-medium text-brand-600 hover:underline">
          Go to dashboard →
        </Link>
      </AuthCard>
    );
  const site = invite.data?.site;
  const title = `Join ${site?.name ?? "a website"} on OpenRev`;

  if (user) {
    return (
      <AuthCard title={title} subtitle={`You'll get ${invite.data?.role} access to ${site?.domain}.`}>
        <ErrorBox error={error} />
        <Button
          variant="primary"
          className="mt-2 w-full"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api<{ siteId: string }>(`/api/invites/${token}/accept`, { body: {} });
              navigate(`/sites/${r.siteId}`);
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          Accept invitation
        </Button>
      </AuthCard>
    );
  }
  return (
    <AuthCard title={title} subtitle="Create your account to accept the invitation.">
      <SignupForm
        invite={token}
        email={invite.data?.email}
        onDone={() => {
          refresh();
          navigate("/");
        }}
      />
      <p className="mt-5 text-center text-sm text-zinc-500">
        Already have an account?{" "}
        <Link href={`/login`} className="font-medium text-brand-600 hover:underline">
          Sign in
        </Link>{" "}
        then open this link again.
      </p>
    </AuthCard>
  );
}
