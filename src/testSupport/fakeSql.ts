/**
 * @file A recorder in place of MySQL (the role sqlmock plays in the Go tests): it keeps every
 * statement with its parameters and answers from a script. Tests import this; nothing else does.
 */

import type { Sql, SqlRow, SqlValue } from "../db/sql";

export interface Call {
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

type Answer = SqlRow[] | Error | ((call: Call) => SqlRow[]);

export class FakeSql implements Sql {
  readonly calls: Call[] = [];
  pings = 0;
  closed = false;
  private readonly script: Array<{ match: RegExp; answer: Answer }> = [];
  /** Fails every ping while positive, counting down. */
  failPings = 0;

  /** Answers a statement whose text matches. The first matching entry wins. */
  on(match: RegExp, answer: Answer): this {
    this.script.push({ match, answer });
    return this;
  }

  async execute(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
    const call = { sql, params };
    this.calls.push(call);
    const entry = this.script.find((s) => s.match.test(sql));
    if (entry === undefined) return [];
    if (entry.answer instanceof Error) throw entry.answer;
    return typeof entry.answer === "function" ? entry.answer(call) : entry.answer;
  }

  async ping(): Promise<void> {
    this.pings++;
    if (this.failPings > 0) {
      this.failPings--;
      throw new Error("connection refused");
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** The statements, whitespace collapsed, in order. */
  statements(): string[] {
    return this.calls.map((c) => c.sql.replace(/\s+/g, " ").trim());
  }
}
