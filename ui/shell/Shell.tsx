// What every page has around it, drawn from the site map: the header with the guides, a sandbox's own bar with
// its pages, and the footer with the whole map. A sandbox's name comes from the shared store, so a rename shows
// in all three at once, in every tab.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { BASE, sandboxName } from "../lib/api";
import { enterSandbox, rememberName, useLinkedSandbox, useSandboxes, type KnownSandbox } from "../lib/store";
import { openViewer, sandboxServer } from "../lib/servers";
import { hrefOf, MENU, PAGES, REFERENCES, REPO, SANDBOX_GROUPS, SITE_TOOLS, type PageId } from "../sitemap";

/** A link to a page of the map. The viewer, from a sandbox, opens on that sandbox. */
export function PageLink({ id, base = BASE, current, children, className }: { id: PageId; base?: string; current?: PageId; children?: ReactNode; className?: string }) {
  const here = current === id ? { "aria-current": "page" as const } : {};
  if (id === "viewer" && base) {
    return <a href="/viewer" className={className} {...here} onClick={e => { e.preventDefault(); openViewer(sandboxServer(base)); }}>{children ?? PAGES.viewer.name}</a>;
  }
  return <Link to={hrefOf(id, base)} className={className} {...here}>{children ?? PAGES[id].name}</Link>;
}

const sandboxTitle = (w: KnownSandbox | undefined) => w?.name ? `Sandbox “${w.name}”` : "Sandbox";

function Header({ page }: { page: PageId }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, []);
  return (
    <header className={`topbar${open ? " menu-open" : ""}`}>
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

/** Inside a sandbox: its name, and its pages by what they're for. On a phone, the pages open from a button. */
function SandboxBar({ page, sandbox }: { page: PageId; sandbox: KnownSandbox | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <nav className={`sandbox-bar${open ? " open" : ""}`} aria-label="This sandbox">
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
            <p><a href="/">All your sandboxes</a></p>
          </section>
        ) : (
          <section>
            <h2>Sandboxes</h2>
            <ul><li><a href="/">Your sandboxes</a></li></ul>
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

/** A page of the site, in its shell. Inside a sandbox, the sandbox's bar sits under the header. */
export function Shell({ page, children }: { page: PageId; children: ReactNode }) {
  const list = useSandboxes();
  const inSandbox = !!BASE;
  const [served, setServed] = useState<string>();
  const working = useLinkedSandbox();
  const sandbox = inSandbox ? list.find(w => w.base === BASE) ?? { base: BASE, joined: false, name: served } : working;
  useEffect(() => {
    document.title = page === "home" ? PAGES.home.name : `${PAGES[page].name} · SMART Imaging`;
    if (!inSandbox) return;
    enterSandbox();
    // The server has the name as it is now, which may have changed in another browser.
    sandboxName(BASE).then(name => { if (name) { setServed(name); rememberName(BASE, name); } });
  }, [page, inSandbox, BASE]);
  return (
    <>
      <Header page={page} />
      {inSandbox && <SandboxBar page={page} sandbox={sandbox} />}
      <div id="announce" className="sr-only" role="status" aria-live="polite" />
      {children}
      <Footer sandbox={sandbox} />
    </>
  );
}
