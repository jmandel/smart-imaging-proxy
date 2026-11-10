// What every page has around it, drawn from the site map: the header with the guides, a sandbox's own bar with
// its pages, and the footer with the whole map. A sandbox's name comes from the shared store, so a rename shows
// in all three at once, in every tab.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useOneRow } from "./fit";
import { api, BASE } from "../lib/api";
import { enterSandbox, rememberName, useLinkedSandbox, useSandboxes, type KnownSandbox } from "../lib/store";
import { openViewer, sandboxServer } from "../lib/servers";
import { hrefOf, MENU, PAGES, REFERENCES, REPO, SANDBOX_GROUPS, SITE_TOOLS, type PageId } from "../sitemap";

/** A link to a page of the map. The viewer, from a sandbox, opens on that sandbox. */
export function PageLink({ id, base = BASE, current, children, className }: { id: PageId; base?: string; current?: PageId; children?: ReactNode; className?: string }) {
  const here = current === id ? { "aria-current": "page" as const } : {};
  // Its words, for the bold copy that keeps a menu item as wide as it is when it's the current page.
  const label = typeof (children ?? PAGES[id].name) === "string" ? { "data-label": (children ?? PAGES[id].name) as string } : {};
  if (id === "viewer" && base) {
    return <a href="/viewer" className={className} {...here} {...label} onClick={e => { e.preventDefault(); openViewer(sandboxServer(base)); }}>{children ?? PAGES.viewer.name}</a>;
  }
  return <Link to={hrefOf(id, base)} className={className} {...here} {...label}>{children ?? PAGES[id].name}</Link>;
}

const sandboxTitle = (w: KnownSandbox | undefined) => w?.name ? `Sandbox “${w.name}”` : "Sandbox";

function Header({ page }: { page: PageId }) {
  const [open, setOpen] = useState(false), bar = useRef<HTMLElement>(null);
  useOneRow(bar);
  useEffect(() => {
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, []);
  return (
    <header ref={bar} className={`topbar${open ? " menu-open" : ""}`}>
      <a className="mark" href="/" title="Home">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="2" y="2" width="16" height="16" rx="3" /><circle cx="10" cy="10" r="3.2" /></svg>
        <span className="name">SMART Imaging</span>
      </a>
      <button type="button" className="menu-button" aria-expanded={open} aria-controls="menu" onClick={() => setOpen(!open)}>Menu</button>
      <nav className="pages" id="menu" aria-label="Pages">
        {MENU.map(id => <PageLink key={id} id={id} current={page} />)}
        <a href={`${BASE}/llms.txt`}>For Agents</a>
      </nav>
    </header>
  );
}

/** Inside a sandbox: its name, and its pages by what they're for. When they don't fit on one row, they open from a button. */
function SandboxBar({ page, sandbox }: { page: PageId; sandbox: KnownSandbox | undefined }) {
  const [open, setOpen] = useState(false), bar = useRef<HTMLElement>(null);
  useOneRow(bar, [sandbox?.name]);
  return (
    <nav ref={bar} className={`sandbox-bar${open ? " open" : ""}`} aria-label="This sandbox">
      <div className="sandbox-bar-head">
        <PageLink id="sandbox" current={page} className="sandbox-bar-name">{sandboxTitle(sandbox)}</PageLink>
        {page !== "sandbox" && <span className="sandbox-bar-here">{PAGES[page].name}</span>}
        <button type="button" className="tool sandbox-bar-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>Pages</button>
      </div>
      <div className="sandbox-bar-groups">
        {SANDBOX_GROUPS.map(g => (
          <div className="sandbox-bar-group" key={g.title}>
            <span className="sandbox-bar-title">{g.title}</span>
            {g.pages.map(id => <PageLink key={id} id={id} current={page} />)}
          </div>
        ))}
      </div>
    </nav>
  );
}

function Footer({ sandbox }: { sandbox: KnownSandbox | undefined }) {
  const ref = useRef<HTMLElement>(null);
  const yours = useSandboxes();
  // It sits at the foot of a page at least a screen tall, so it's never on the first screen, and content that
  // arrives later pushes it along out of sight, never across what someone is reading. Measured before the first
  // paint, so it's never seen anywhere else.
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => document.body.style.setProperty("--footer-h", `${el.offsetHeight}px`);
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  const base = sandbox?.base;
  return (
    <footer className="site-footer" ref={ref}>
      <nav aria-label="Site map">
        <section>
          <h2>Guides</h2>
          <ul>
            {MENU.map(id => <li key={id}><PageLink id={id} /></li>)}
            <li><a href={`${base ?? ""}/llms.txt`}>For Agents (llms.txt)</a></li>
          </ul>
        </section>
        <section>
          <h2>Test your server</h2>
          <ul>
            {SITE_TOOLS.map(id => <li key={id}><PageLink id={id} base="" /></li>)}
          </ul>
        </section>
        {base ? (
          <section className="site-footer-sandbox">
            <h2><PageLink id="sandbox" base={base}>{sandboxTitle(sandbox)}</PageLink></h2>
            {SANDBOX_GROUPS.map(g => (
              <div key={g.title}>
                <h3>{g.title}</h3>
                <ul>{g.pages.map(id => <li key={id}><PageLink id={id} base={base} /></li>)}</ul>
              </div>
            ))}
            <p><PageLink id="sandboxes">All your sandboxes</PageLink></p>
          </section>
        ) : (
          <section>
            <h2>Your sandboxes</h2>
            <ul>{yours.slice(0, 6).map(w => <li key={w.base}><a href={`${w.base}/`}>{w.name ?? "Sandbox"}</a></li>)}
              <li><PageLink id="sandboxes">{yours.length ? "All, or a new one" : "Make one"}</PageLink></li></ul>
          </section>
        )}
        <section>
          <h2>Reference</h2>
          <ul>
            {REFERENCES.map(([name, url]) => <li key={url}><a href={url}>{name}</a></li>)}
            <li><a href={REPO}>Source on GitHub</a></li>
            <li><a href={`${REPO}/issues`}>Issues and ideas</a></li>
          </ul>
        </section>
      </nav>
      <p>A public sandbox of SMART Imaging Access, with sample data only. <a href={REPO}>Open source on GitHub</a>.</p>
    </footer>
  );
}

interface AppCheckOn { run: string; client: string; staged: string[]; endsAt: string }
/** While an app check runs in this sandbox: loud on every page, since the sandbox isn't answering as it usually does. */
function AppCheckBanner({ on }: { on: AppCheckOn }) {
  const ends = new Date(on.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <div className="app-check-banner" role="status" id="app-check-banner">
      <p><b>An app check is running here</b>, grading <code>{on.client}</code>, until it's ended or {ends}. Staged: {on.staged.length ? on.staged.join("; ") : "nothing"}.</p>
      <Link to={`${BASE}/app-check?run=${encodeURIComponent(on.run)}`}>End it on the App check page</Link>
    </div>
  );
}

/** A page of the site, in its shell. Inside a sandbox, the sandbox's bar sits under the header. */
export function Shell({ page, children }: { page: PageId; children: ReactNode }) {
  const list = useSandboxes();
  const inSandbox = !!BASE;
  const [served, setServed] = useState<string>();
  const [appCheck, setAppCheck] = useState<AppCheckOn | null>(null);
  const working = useLinkedSandbox();
  const sandbox = inSandbox ? list.find(w => w.base === BASE) ?? { base: BASE, joined: false, name: served } : working;
  useEffect(() => {
    document.title = page === "home" ? PAGES.home.name : `${PAGES[page].name} · SMART Imaging`;
    if (!inSandbox) return;
    enterSandbox();
    // The server has the name as it is now, which may have changed in another browser, and whether an app check is on.
    const read = () => api<{ name: string | null; appCheck: AppCheckOn | null }>("GET", "/api/sandbox").then(s => {
      if (s.name) { setServed(s.name); rememberName(BASE, s.name); }
      setAppCheck(s.appCheck ?? null);
    }, () => {});
    read();
    addEventListener("app-check", read);
    return () => removeEventListener("app-check", read);
  }, [page, inSandbox, BASE]);
  return (
    <>
      <Header page={page} />
      {inSandbox && <SandboxBar page={page} sandbox={sandbox} />}
      {inSandbox && appCheck && <AppCheckBanner on={appCheck} />}
      <div id="announce" className="sr-only" role="status" aria-live="polite" />
      {children}
      <Footer sandbox={sandbox} />
    </>
  );
}
