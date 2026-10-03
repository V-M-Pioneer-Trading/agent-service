/**
 * @file `createApp` with a centre that fails loudly if it is ever asked, and
 * the helpers the unit tests share. Tests import this; nothing else does.
 */

import { createExpressAuth, type CenterAnswer, type Introspector } from "@v-m-pioneer-trading/clerk-client";
import { HistoryStore } from "../db/history";
import type { Sql } from "../db/sql";
import { GatewayClient } from "../gateway/client";
import { createApp, type AppDeps } from "../server";

export const TEST_ORIGIN = "https://contract.example.test";

/** An introspector that records the tokens it was asked about and answers `answer`. */
/** A gateway client that fails loudly if it is ever used. */
export const noGateway = new GatewayClient("http://gateway.invalid/proxy", async () => {
  throw new Error("the test app has no st-gateway");
});

/** A history that fails loudly if it is ever used. */
export const noHistory = new HistoryStore({
  execute: async () => {
    throw new Error("the test app has no database");
  },
  ping: async () => undefined,
  close: async () => undefined,
} satisfies Sql);

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
    gateway: noGateway,
    history: noHistory,
    ...overrides,
  });
  return { app, centre };
}
