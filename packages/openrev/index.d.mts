// Types for the tests, which import the CLI. Not published.
export const VERSION: string;
export interface Io {
  fetch?: typeof fetch;
  stdout?: { write(s: string): unknown; isTTY?: boolean; columns?: number };
  stderr?: { write(s: string): unknown };
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  env?: Record<string, string | undefined>;
  home?: string;
}
export function main(argv: string[], io?: Io): Promise<number>;
export function parseLogLine(line: string): { path: string; user_agent: string; timestamp?: number } | null;
export function configPath(env: Record<string, string | undefined>, home?: string): string;
