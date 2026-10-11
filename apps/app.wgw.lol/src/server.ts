import handler from "@tanstack/react-start/server-entry";

import { app, isServerPath } from "./server/app";
import type { Env } from "./server/env";

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
} satisfies ExportedHandler<Env>;
