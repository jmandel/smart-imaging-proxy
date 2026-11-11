// Each page of the site map, as the component that draws it.
import type { ComponentType } from "react";
import type { PageId } from "../sitemap";
import Home from "./Home";
import SandboxHome from "./SandboxHome";
import { About } from "./Guides";
import BuildAnApp from "./BuildAnApp";
import BuildAServer from "./BuildAServer";
import Sandboxes from "./Sandboxes";
import Build from "./Build";
import Connect from "./Connect";
import Viewer from "./Viewer";
import Servers from "./Servers";
import ServerCheck from "./ServerCheck";
import AppCheck from "./AppCheck";
import Explore from "./Explore";
import Activity from "./Activity";
import Config from "./Config";
import Trace from "./Trace";
import TraceSpan from "./TraceSpan";
import TraceLog from "./TraceLog";

export const UI_PAGES: Partial<Record<PageId, ComponentType>> = {
  home: Home, sandbox: SandboxHome,
  "build-an-app": BuildAnApp, "build-a-server": BuildAServer, about: About, sandboxes: Sandboxes,
  build: Build, connect: Connect,
  viewer: Viewer,
  servers: Servers, check: ServerCheck, "app-check": AppCheck,
  explore: Explore,
  activity: Activity, config: Config,
  trace: Trace, "trace-span": TraceSpan, "trace-log": TraceLog,
};
