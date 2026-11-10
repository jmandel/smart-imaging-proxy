// The site map at the foot of every page, the trace pages too, so it reads nothing but the address and what
// this browser remembers: the guides, the viewer, your sandbox's pages, and the specifications and source.
(() => {
  const here = location.pathname.match(/^\/s\/[^/]+/)?.[0];
  let known = [], current;
  try { known = JSON.parse(localStorage.getItem("smart-imaging-client:sandboxes") ?? "[]"); current = localStorage.getItem("smart-imaging-client:current"); } catch {}
  const sandbox = known.find(w => w.base === (here ?? current)) ?? (here ? { base: here } : known.at(-1));
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const REPO = "https://github.com/jmandel/smart-imaging-proxy";
  const column = (title, links) => `<section><h2>${title}</h2><ul>${links.map(([href, label]) => `<li><a href="${esc(href)}" data-root>${esc(label)}</a></li>`).join("")}</ul></section>`;
  const sb = sandbox?.base;
  const columns = [
    column("Guides", [["/build-an-app", "Build an App"], ["/run-a-server", "Run a Server"], ["/how-it-works", "How It Works"], ["/why-it-matters", "Why It Matters"], [`${sb ?? ""}/llms.txt`, "For Agents (llms.txt)"]]),
    column("Test your server", [["/viewer", "Viewer"], ["/servers", "Your servers"], [`${REPO}/issues/1`, "Conformance checks: the plan"]]),
    sb ? column(`Sandbox${sandbox.name ? ` “${esc(sandbox.name)}”` : ""}`, [[`${sb}/`, "Home"], [`${sb}/build`, "Start here"], [`${sb}/connect`, "Register an app"], [`${sb}/activity`, "Logs"], [`${sb}/trace/`, "Live trace"], [`${sb}/tours`, "Tour"], [`${sb}/explore`, "Explore"], [`${sb}/checks`, "Conformance"], ["/", "All your sandboxes"]])
      : column("Sandboxes", [["/", "Your sandboxes"]]),
    column("Reference", [["https://build.fhir.org/ig/argonautproject/smart-imaging/", "SMART Imaging Access"], ["https://build.fhir.org/ig/HL7/smart-app-launch/", "SMART App Launch"], ["https://build.fhir.org/imagingstudy.html", "FHIR ImagingStudy"], ["https://www.dicomstandard.org/using/dicomweb/retrieve-wado-rs-and-wado-uri", "DICOMweb WADO-RS"], [REPO, "Source on GitHub"], [`${REPO}/issues`, "Issues and ideas"]]),
  ];
  const footer = document.createElement("footer");
  footer.className = "site-footer";
  footer.innerHTML = `<nav aria-label="Site map">${columns.join("")}</nav><p>A public sandbox of SMART Imaging Access, with sample data only. <a href="${REPO}" data-root>Open source on GitHub</a>.</p>`;
  // Its own look, so it's the same on pages with other stylesheets.
  const style = document.createElement("style");
  style.textContent = `
body { position:relative; box-sizing:border-box; min-height:calc(100vh + var(--footer-h, 0px) + 3rem); padding-bottom:calc(var(--footer-h, 0px) + 3rem); }
.site-footer { position:absolute; left:0; right:0; bottom:0; box-sizing:border-box; padding:2rem max(1rem, calc((100% - 62rem) / 2)) 1.5rem; background:var(--film, #0f2a3d); color:var(--on-film-dim, #b9cad6); font:15px/1.5 var(--sans, system-ui, sans-serif); }
.site-footer nav { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); gap:1.5rem 2rem; }
.site-footer h2 { margin:0 0 .5rem; font-size:.8rem; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--on-film, #e8f1f6); }
.site-footer ul { list-style:none; margin:0; padding:0; }
.site-footer li { margin:0; }
.site-footer a { display:inline-block; padding:.2rem 0; color:inherit; text-decoration:none; }
.site-footer a:hover { color:var(--on-film, #e8f1f6); text-decoration:underline; }
.site-footer > p { margin:1.75rem 0 0; padding-top:1rem; border-top:1px solid rgba(255,255,255,.12); font-size:.85rem; }
.site-footer > p a { text-decoration:underline; }`;
  document.head.append(style);
  document.body.append(footer);
  // It sits at the foot of a page at least a screen tall, so it's never on the first screen, and content that
  // arrives later pushes it along out of sight, never across what someone is reading.
  const measure = () => document.body.style.setProperty("--footer-h", `${footer.offsetHeight}px`);
  measure();
  new ResizeObserver(measure).observe(footer);
})();
