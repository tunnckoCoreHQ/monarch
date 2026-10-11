import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A browser title: the page's parts, most specific first, then the site name. */
export function pageTitle(...parts: string[]): string {
  return [...parts, "wgw"].filter((part) => part !== "").join(" · ");
}
