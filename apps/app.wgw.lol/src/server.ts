import handler from "@tanstack/react-start/server-entry";

import { app, isServerPath } from "./server/app";
import { handleCron } from "./server/cron";
import type { Env } from "./server/env";
import { handleEvents } from "./server/events";

export { Repo } from "./server/repo-object";
export { RepoReady } from "./server/workflow";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname } = new URL(request.url);
    if (isServerPath(pathname)) {
      return app.fetch(request, env, ctx);
    }
    return handler.fetch(request);
  },
  queue: handleEvents,
  scheduled: handleCron,
} satisfies ExportedHandler<Env>;
