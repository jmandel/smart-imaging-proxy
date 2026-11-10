// Each page of the site map, as the component that draws it.
import type { ComponentType } from "react";
import type { PageId } from "../sitemap";
import Home from "./Home";
import SandboxHome from "./SandboxHome";
import { BuildAnApp, HowItWorks, RunAServer, WhyItMatters } from "./Guides";
import Build from "./Build";
import Connect from "./Connect";
import Viewer from "./Viewer";
import Tours from "./Tours";
import Checks from "./Checks";
import Servers from "./Servers";
import Explore from "./Explore";
import Activity from "./Activity";
import Config from "./Config";
import Trace from "./Trace";
import TraceSpan from "./TraceSpan";
import TraceLog from "./TraceLog";

export const UI_PAGES: Partial<Record<PageId, ComponentType>> = {
  home: Home, sandbox: SandboxHome,
  "build-an-app": BuildAnApp, "run-a-server": RunAServer, "how-it-works": HowItWorks, "why-it-matters": WhyItMatters,
  build: Build, connect: Connect,
  viewer: Viewer,
  tours: Tours, checks: Checks,
  servers: Servers,
  explore: Explore,
  activity: Activity, config: Config,
  trace: Trace, "trace-span": TraceSpan, "trace-log": TraceLog,
};
