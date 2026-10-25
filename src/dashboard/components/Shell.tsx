import { BookOpen, ChevronDown, LogOut, Moon, Plus, Sun, UserCircle } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { api, useApi } from "../lib/api";
import { useAuth } from "../lib/context";
import type { SiteSummary } from "../lib/types";
import { Dropdown, Favicon, MenuItem } from "./ui";

/** The OpenRev mark: a rev counter whose needle points into the green revenue zone. */
export function LogoMark({ className = "h-7 w-7" }: { className?: string }) {
  const id = useId().replace(/[^\w-]/g, "");
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}bg`} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7c6bff" />
          <stop offset=".55" stopColor="#5b4cf5" />
          <stop offset="1" stopColor="#3f2fd0" />
        </linearGradient>
        <linearGradient id={`${id}hl`} x1="0" y1="0" x2="0" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity=".22" />
          <stop offset=".5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill={`url(#${id}bg)`} />
      <rect width="64" height="64" rx="16" fill={`url(#${id}hl)`} />
      <g fill="none" strokeLinecap="round" strokeWidth="5.5">
        <path d="M19.27 46.73A18 18 0 0 1 36.35 16.53" stroke="#fff" />
        <path d="M43.57 20.21A18 18 0 0 1 44.73 46.73" stroke="#34d399" />
        <path d="M32 34L43.48 27.9" stroke="#fff" strokeWidth="5" />
      </g>
      <circle cx="32" cy="34" r="4.5" fill="#fff" />
    </svg>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <LogoMark />
      <span>
        Open<span className="text-brand-600 dark:text-brand-400">Rev</span>
      </span>
    </span>
  );
}

export function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  return [
    dark,
    () => {
      const next = !dark;
      document.documentElement.classList.toggle("dark", next);
      try {
        localStorage.setItem("openrev_theme", next ? "dark" : "light");
      } catch {
        /* ignore */
      }
      setDark(next);
    },
  ];
}

function SiteSwitcher() {
  const [location, navigate] = useLocation();
  const match = location.match(/^\/sites\/([a-z0-9]+)/);
  const siteId = match && match[1] !== "new" ? match[1] : null;
  const { data } = useApi<{ sites: SiteSummary[] }>(siteId ? "/api/sites" : null);
  if (!siteId) return null;
  const current = data?.sites.find((s) => s.id === siteId);
  return (
    <Dropdown
      button={() => (
        <button className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800">
          <Favicon domain={current?.domain} />
          <span className="max-w-[180px] truncate">{current?.name ?? "…"}</span>
          <ChevronDown className="h-4 w-4 text-zinc-400" />
        </button>
      )}
    >
      {(close) => (
        <>
          {data?.sites.map((s) => (
            <MenuItem
              key={s.id}
              active={s.id === siteId}
              onClick={() => {
                close();
                navigate(`/sites/${s.id}`);
              }}
            >
              <Favicon domain={s.domain} />
              <span className="truncate">{s.name}</span>
            </MenuItem>
          ))}
          <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
          <MenuItem
            onClick={() => {
              close();
              navigate("/sites/new");
            }}
          >
            <Plus className="h-4 w-4" /> Add website
          </MenuItem>
        </>
      )}
    </Dropdown>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { user, refresh } = useAuth();
  const [dark, toggleTheme] = useTheme();
  const [, navigate] = useLocation();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6">
          <Link href="/" className="shrink-0">
            <Logo />
          </Link>
          <span className="text-zinc-300 dark:text-zinc-700">/</span>
          <SiteSwitcher />
          <div className="flex-1" />
          <a href="https://github.com/CrowdLinker/OpenRev/tree/main/docs" target="_blank" rel="noreferrer" className="hidden items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 sm:flex dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
            <BookOpen className="h-4 w-4" /> Docs
          </a>
          <button onClick={toggleTheme} className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100" aria-label="Toggle theme">
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <Dropdown
            align="right"
            button={() => (
              <button className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
                <UserCircle className="h-5 w-5 text-zinc-400" />
                <span className="hidden max-w-[160px] truncate sm:inline">{user?.name || user?.email}</span>
              </button>
            )}
          >
            {(close) => (
              <>
                <div className="px-2.5 py-1.5 text-xs text-zinc-500">{user?.email}</div>
                <MenuItem
                  onClick={() => {
                    close();
                    navigate("/account");
                  }}
                >
                  <UserCircle className="h-4 w-4" /> Account
                </MenuItem>
                <MenuItem
                  onClick={async () => {
                    close();
                    await api("/api/auth/logout", { method: "POST", body: {} });
                    await refresh();
                    navigate("/login");
                  }}
                >
                  <LogOut className="h-4 w-4" /> Sign out
                </MenuItem>
              </>
            )}
          </Dropdown>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">{children}</main>
      <footer className="mx-auto max-w-7xl px-4 pb-8 text-center text-xs text-zinc-400 sm:px-6">
        OpenRev is open source (MIT) ·{" "}
        <a className="hover:underline" href="https://github.com/CrowdLinker/OpenRev" target="_blank" rel="noreferrer">
          GitHub
        </a>{" "}
        · IP geolocation by{" "}
        <a className="hover:underline" href="https://db-ip.com" target="_blank" rel="noreferrer">
          DB-IP
        </a>
      </footer>
    </div>
  );
}
