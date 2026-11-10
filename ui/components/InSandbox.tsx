// A link into your sandbox's page, or the viewer opened on it, for a page outside any sandbox. It goes to the
// sandbox you were last in, and with none, following it makes one first.
import { useState, type MouseEvent, type ReactNode } from "react";
import { createSandbox, useLinkedSandbox } from "../lib/store";
import { openViewer, sandboxServer } from "../lib/servers";
import { PAGES, type PageId } from "../sitemap";

export function InSandbox({ page, className, children }: { page: PageId; className?: string; children: ReactNode }) {
  const linked = useLinkedSandbox();
  const [error, setError] = useState<string>();
  const viewer = page === "viewer", path = PAGES[page].path;
  const go = async (e: MouseEvent) => {
    if (linked && !viewer) return;
    e.preventDefault();
    try {
      const base = linked?.base ?? await createSandbox();
      if (viewer) openViewer(sandboxServer(base)); else location.assign(`${base}${path}`);
    } catch (x) { setError((x as Error).message); }
  };
  return <>
    <a className={className} href={viewer ? "/viewer" : `${linked?.base ?? ""}${path}`} onClick={go}>{children}</a>
    {error && <span className="error" role="alert"> {error}</span>}
  </>;
}
