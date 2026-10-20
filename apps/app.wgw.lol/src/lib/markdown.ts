import { Marked } from "marked";

import { escapeHtml } from "./utils";

function safeUrl(href: string): string | null {
  const value = href.trim();
  if (/^(https?:|mailto:|#|\/|\.{0,2}\/|[^:]+$)/i.test(value) && !/^javascript:/i.test(value)) {
    return value;
  }
  return null;
}

// Repository content is untrusted: raw HTML is shown as text, and links keep safe schemes only.
const marked = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, tokens }) {
      const url = safeUrl(href);
      const label = this.parser.parseInline(tokens);
      return url === null
        ? label
        : `<a href="${escapeHtml(url)}" rel="nofollow noopener" target="_blank">${label}</a>`;
    },
    image({ href, text }) {
      const url = safeUrl(href);
      return url === null || !/^https:/i.test(url)
        ? escapeHtml(text)
        : `<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}" loading="lazy">`;
    },
  },
});

export function renderMarkdown(source: string): string {
  return marked.parse(source, { async: false });
}
