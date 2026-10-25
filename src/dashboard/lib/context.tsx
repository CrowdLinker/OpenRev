import { createContext, useContext } from "react";
import type { Instance, Role, Site, SiteMeta, User } from "./types";

export interface AuthState {
  user: User | null;
  instance: Instance | null;
  refresh: () => void;
}
export const AuthContext = createContext<AuthState>({ user: null, instance: null, refresh: () => {} });
export const useAuth = () => useContext(AuthContext);

export interface SiteState {
  /** Base URL for stats endpoints (private dashboard or public share link) */
  statsBase: string;
  site: Site | null;
  meta: SiteMeta | null;
  role: Role | null;
  isPublic: boolean;
  reloadSite: () => void;
  reloadMeta: () => void;
}
export const SiteContext = createContext<SiteState>({
  statsBase: "",
  site: null,
  meta: null,
  role: null,
  isPublic: false,
  reloadSite: () => {},
  reloadMeta: () => {},
});
export const useSite = () => useContext(SiteContext);

export function canEdit(role: Role | null) {
  return role === "owner" || role === "admin";
}
