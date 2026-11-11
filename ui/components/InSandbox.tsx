// A link into your sandbox's page, for a page outside any sandbox. It goes to the sandbox you were last in, and with
// none, following it makes one first.
import { useState, type MouseEvent, type ReactNode } from "react";
import { createSandbox, useLinkedSandbox } from "../lib/store";
import { PAGES, type PageId } from "../sitemap";

export function InSandbox({ page, className, children }: { page: PageId; className?: string; children: ReactNode }) {
  const linked = useLinkedSandbox();
  const [error, setError] = useState<string>();
  const path = PAGES[page].path;
  const go = async (e: MouseEvent) => {
    if (linked) return;
    e.preventDefault();
    try { location.assign(`${await createSandbox()}${path}`); }
    catch (x) { setError((x as Error).message); }
  };
  return <>
    <a className={className} href={`${linked?.base ?? ""}${path}`} onClick={go}>{children}</a>
    {error && <span className="error" role="alert"> {error}</span>}
  </>;
}
