// A link to an address the server gave, on one of the site's pages: in place when the app draws that page.
import type { ReactNode } from "react";
import { Link } from "react-router";
import { PORTED } from "../ported";
import type { PageId } from "../sitemap";

export function ToPage({ page, href, className, children }: { page: PageId; href: string; className?: string; children: ReactNode }) {
  return PORTED.includes(page) ? <Link to={href} className={className}>{children}</Link> : <a href={href} className={className}>{children}</a>;
}
