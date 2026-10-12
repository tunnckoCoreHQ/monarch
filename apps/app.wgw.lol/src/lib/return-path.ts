/**
 * Where to go after sign-in: the path, query, and fragment of `value` when it resolves to
 * `origin`, else "/". Browsers read `/\evil.example` and `/<tab>/evil.example` as other hosts, so
 * the check resolves the URL the way a browser does instead of looking at its first characters.
 * `https://app.wgw.lol//evil.example` resolves to this origin, but its path `//evil.example` is a
 * link to another host. So a path that starts with `//` or `/\`, decoded or not, returns "/", and
 * the path that comes back must still resolve to `origin`.
 */
export function returnPath(value: string | undefined, origin: string): string {
  if (value === undefined) {
    return "/";
  }
  try {
    const url = new URL(value, origin);
    const decoded = decodeURIComponent(url.pathname).replaceAll(/[\t\n\r]/g, "");
    if (url.origin !== origin || /^\/[/\\]/.test(decoded)) {
      return "/";
    }
    const path = `${url.pathname}${url.search}${url.hash}`;
    return new URL(path, origin).origin === origin ? path : "/";
  } catch {
    return "/";
  }
}
