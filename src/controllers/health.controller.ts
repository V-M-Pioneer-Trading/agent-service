import { Controller, Get, Route, Tags } from "@tsoa/runtime";

export interface HealthStatus {
  status: "ok";
}

/**
 * Liveness. Mounted bare for local dev/compose and under /api/agent because
 * production CloudFront only routes requests matching a configured path
 * pattern. Credentials are ignored (routePolicy in auth.ts): the header is
 * never read and auth-service is never asked, so these keep answering while
 * it is down.
 */
@Route("")
@Tags("operational")
export class HealthController extends Controller {
  /** Liveness check. */
  @Get("health")
  public health(): HealthStatus {
    return { status: "ok" };
  }

  /** Liveness check on the production path prefix. */
  @Get("api/agent/health")
  public apiHealth(): HealthStatus {
    return { status: "ok" };
  }
}
