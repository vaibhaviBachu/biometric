/**
 * Error text that is safe to send to a browser.
 *
 * Friendly messages written for users pass through. Text that carries internals (SQL, Prisma and driver
 * dumps, stack frames, file paths, hosts, connection strings, env variable names) is swapped for a generic
 * line, so nothing private shows up in a response body or in devtools.
 */

const INTERNAL_PATTERNS: RegExp[] = [
  /\bat [\w$.<>]+ \(|\n\s+at /,                                   // stack frames
  /node_modules|[A-Za-z]:\\|\/(src|dist|app|opt|home|usr|var|tmp)\//, // file paths
  /prisma|Invocation|P\d{4}\b/i,                                   // Prisma
  /\bselect\s+(\*|[\w."]+(\s*,\s*[\w."]+)+)\s+from\b|\bselect\b[\s\S]*\bfrom\s+"?[\w.]+"?\s+where\b|\binsert\s+into\b|\bupdate\s+"?\w+"?\s+set\b|\bdelete\s+from\b/i, // SQL
  /\b(relation|column|constraint|table|schema)\b[\s\S]*\b(does not exist|violates|already exists)\b/i,
  /duplicate key|syntax error at|SQLITE_|ER_[A-Z_]+|\bpg_|42P01|23505/i, // driver codes
  /(postgres(ql)?|mysql|redis|mongodb(\+srv)?):\/\//i,              // connection strings
  /ECONN\w+|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up/i,   // network internals
  /\b[A-Z][A-Z0-9_]*_(URL|KEY|SECRET|TOKEN|PASSWORD)\b/,             // env variable names
  /\bsupabase\.co\b|\bonrender\.com\b|amazonaws\.com|localhost:\d+|127\.0\.0\.1/i, // internal hosts
  /Cannot read propert|is not a function|is not defined|Unexpected token|undefined \(reading/i, // JS faults
];

export const GENERIC_SERVER_ERROR = 'Something went wrong on our side. Please try again.';

export function looksInternal(text: string): boolean {
  return text.length > 300 || INTERNAL_PATTERNS.some((re) => re.test(text));
}

/** The message to show a user for `err`, or `fallback` when the real one would expose internals. */
export function publicErrorMessage(err: unknown, fallback = GENERIC_SERVER_ERROR): string {
  const text = (err instanceof Error ? err.message : typeof err === 'string' ? err : '').trim();
  if (!text || looksInternal(text)) return fallback;
  return text;
}
