// Each page of the site map, as the component that draws it.
import type { ComponentType } from "react";
import type { PageId } from "../sitemap";
import Home from "./Home";
import SandboxHome from "./SandboxHome";
import { BuildAnApp, HowItWorks, RunAServer, WhyItMatters } from "./Guides";
import Build from "./Build";
import Connect from "./Connect";

export const UI_PAGES: Partial<Record<PageId, ComponentType>> = {
  home: Home, sandbox: SandboxHome,
  "build-an-app": BuildAnApp, "run-a-server": RunAServer, "how-it-works": HowItWorks, "why-it-matters": WhyItMatters,
  build: Build, connect: Connect,
};
