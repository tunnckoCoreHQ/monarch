/**
 * Where to go after sign-in: the path, query, and fragment of `value` when it resolves to
 * `origin`, else "/". Browsers read `/\evil.example` and `/<tab>/evil.example` as other hosts, so
 * the check resolves the URL the way a browser does instead of looking at its first characters.
 */
export function returnPath(value: string | undefined, origin: string): string {
  if (value === undefined) {
    return "/";
  }
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch {
    return "/";
  }
}
