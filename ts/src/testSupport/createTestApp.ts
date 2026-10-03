/**
 * @file `createApp` with a centre that fails loudly if it is ever asked, and
 * the helpers the unit tests share. Tests import this; nothing else does.
 */

import { createExpressAuth, type CenterAnswer, type Introspector } from "@v-m-pioneer-trading/clerk-client";
import { createApp, type AppDeps } from "../server";

export const TEST_ORIGIN = "https://contract.example.test";

/** An introspector that records the tokens it was asked about and answers `answer`. */
export function stubCentre(answer: CenterAnswer = { state: "unavailable" }) {
  const asked: string[] = [];
  const introspector: Introspector = {
    introspect: async (token) => {
      asked.push(token);
      return answer;
    },
  };
  return { asked, introspector };
}

export function createTestApp(overrides: Partial<AppDeps> = {}, centre = stubCentre()) {
  const app = createApp({
    corsAllowedOrigin: TEST_ORIGIN,
    auth: createExpressAuth(centre.introspector),
    ...overrides,
  });
  return { app, centre };
}
