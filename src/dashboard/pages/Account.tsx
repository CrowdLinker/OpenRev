import { useState } from "react";
import { Badge, Button, ErrorBox, Field, Section, Toggle } from "../components/ui";
import { api, useApi } from "../lib/api";
import { useAuth } from "../lib/context";
import { dateTime } from "../lib/format";
import type { Row } from "../lib/types";
import { KeysList } from "./Settings";

export function AccountPage() {
  const { user, instance, refresh } = useAuth();
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [emailPassword, setEmailPassword] = useState("");
  const [profileMsg, setProfileMsg] = useState<unknown>(null);
  const emailChanged = email.trim().toLowerCase() !== (user?.email ?? "");
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [pwMsg, setPwMsg] = useState<unknown>(null);
  const [pwOk, setPwOk] = useState(false);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
      <Section title="Profile">
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setProfileMsg(null);
            try {
              await api("/api/account", { method: "PATCH", body: { name, email, current: emailChanged ? emailPassword : undefined } });
              setEmailPassword("");
              refresh();
              setProfileMsg("Saved ✓");
            } catch (err) {
              setProfileMsg(err);
            }
          }}
        >
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email">
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {emailChanged && (
            <Field label="Current password" help="Required to change your email">
              <input className="input" type="password" autoComplete="current-password" value={emailPassword} onChange={(e) => setEmailPassword(e.target.value)} required />
            </Field>
          )}
          <div className="flex items-center gap-3 sm:col-span-2">
            <Button variant="primary" type="submit">
              Save
            </Button>
            {typeof profileMsg === "string" ? <span className="text-sm text-money-600">{profileMsg}</span> : <ErrorBox error={profileMsg} />}
          </div>
        </form>
      </Section>
      <Section title="Password">
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setPwMsg(null);
            setPwOk(false);
            try {
              await api("/api/account/password", { body: { current, password } });
              setPwOk(true);
              setCurrent("");
              setPassword("");
            } catch (err) {
              setPwMsg(err);
            }
          }}
        >
          <Field label="Current password">
            <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="New password">
            <input className="input" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <div className="flex items-center gap-3 sm:col-span-2">
            <Button variant="primary" type="submit">
              Change password
            </Button>
            {pwOk && <span className="text-sm text-money-600">Password changed ✓</span>}
            <ErrorBox error={pwMsg} />
          </div>
        </form>
      </Section>
      <Section title="Account tokens" description="Account tokens (ort_…) work across all your websites with the API, CLI tools and MCP. Pass websiteId with each request.">
        <KeysList label="Account token" listPath="/api/account/tokens" createPath="/api/account/tokens" deletePath={(id) => `/api/account/tokens/${id}`} />
      </Section>
      {user?.is_admin ? <AdminSection signupEnabled={!!instance?.signupEnabled} onChange={refresh} /> : null}
      <p className="text-center text-xs text-zinc-400">
        OpenRev {instance?.version} · running on {instance?.platform}
      </p>
    </div>
  );
}

function AdminSection({ signupEnabled, onChange }: { signupEnabled: boolean; onChange: () => void }) {
  const { user } = useAuth();
  const { data, reload } = useApi<{ users: Row[] }>("/api/admin/users");
  return (
    <Section title="Instance administration" description="Only visible to instance admins.">
      <Toggle
        checked={signupEnabled}
        onChange={async (v) => {
          await api("/api/admin/settings", { method: "PATCH", body: { signupEnabled: v } });
          onChange();
        }}
        label="Allow public sign-ups"
        help="When off, people can only join with an invitation."
      />
      <div className="mt-5 divide-y divide-zinc-100 dark:divide-zinc-800">
        {data?.users.map((u) => (
          <div key={String(u.id)} className="flex items-center gap-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {u.name || u.email} {u.is_admin ? <Badge color="brand">admin</Badge> : null}
              </div>
              <div className="text-xs text-zinc-500">
                {u.email} · joined {dateTime(Number(u.created_at))}
              </div>
            </div>
            {u.id !== user?.id && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await api(`/api/admin/users/${u.id}`, { method: "PATCH", body: { is_admin: !u.is_admin } });
                    reload();
                  }}
                >
                  {u.is_admin ? "Remove admin" : "Make admin"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    if (!confirm(`Delete ${u.email}?`)) return;
                    await api(`/api/admin/users/${u.id}`, { method: "DELETE" });
                    reload();
                  }}
                >
                  Delete
                </Button>
              </>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}
