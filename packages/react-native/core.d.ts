import type { OpenRevClient, OpenRevOptions } from "./index";
export const VERSION: string;
export function createClient(
  options: OpenRevOptions & {
    storage: NonNullable<OpenRevOptions["storage"]>;
    platform?: { os?: string; osVersion?: string; device?: "phone" | "tablet"; screenWidth?: number; language?: string };
    initialURL?: Promise<string | null> | string | null;
    fetch?: typeof fetch;
    now?: () => number;
  },
): OpenRevClient;
