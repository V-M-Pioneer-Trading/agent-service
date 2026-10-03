// The part of swagger-ui-express (5.x) this service uses. The package ships no types, and its
// @types package is a dependency the allowlist (allowed-dependencies.txt) does not have.
declare module "swagger-ui-express" {
  import type { RequestHandler } from "express";

  interface SetupOptions {
    readonly customSiteTitle?: string;
    readonly customCss?: string;
    readonly swaggerOptions?: Record<string, unknown>;
  }

  /** The handlers that serve the UI's static files (and swagger-ui-init.js); mount them before `setup`. */
  const serve: RequestHandler[];
  /** The handler that answers with the UI page, the spec embedded in it. */
  function setup(spec: object | null, options?: SetupOptions): RequestHandler;

  const swaggerUi: { serve: typeof serve; setup: typeof setup };
  export { serve, setup };
  export default swaggerUi;
}
