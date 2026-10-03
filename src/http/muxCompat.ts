/**
 * @file The gorilla/mux and net/http artefacts the contract suite pins
 * (contract/README.md "Routing and HTTP"), reproduced in front of Express.
 *
 *  - a malformed percent escape in the path: bare `400 Bad Request`, connection closed;
 *  - an unclean (decoded) path: `301` to the cleaned path, query kept;
 *  - routing is on the decoded path: the URL Express sees is the decoded path
 *    with every byte that is not a plain path character escaped again, so `%2F`
 *    becomes a real slash (and splits the segment, as mux does) and `%2561`
 *    is `%61`, decoded once;
 *  - the terminal answers: `404 page not found` under the string prefix
 *    `/api/agent`, a bare `405` elsewhere.
 *
 * All of it comes before any Express default or route.
 *
 * A path parameter may hold bytes that are not UTF-8 (`%FF`): mux routes it
 * and hands the handler the raw bytes, but Express decodes its own params with
 * decodeURIComponent, which throws. So the URL Express routes on carries the
 * lossy UTF-8 reading of the path (a bad byte is U+FFFD, which no route
 * mentions), and the exact decoded bytes are kept for the handlers:
 * `decodedPathOf(req)`, `lastSegmentOf(req)`.
 */

import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, RequestHandler, Response } from "express";

const AGENT_PREFIX = "/api/agent";
const TEXT = "text/plain; charset=utf-8";

/** Percent-decode to bytes; null for a `%` not followed by two hex digits (Go's url.unescape). */
export function unescapeBytes(raw: string): Buffer | null {
  const out: number[] = [];
  const bytes = Buffer.from(raw, "latin1");
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i] as number;
    if (c !== 0x25) {
      out.push(c);
      continue;
    }
    const hex = bytes.toString("latin1", i + 1, i + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
    out.push(parseInt(hex, 16));
    i += 2;
  }
  return Buffer.from(out);
}

/** gorilla/mux cleanPath: path.Clean on a rooted path, trailing slash kept. */
export function cleanPath(p: string): string {
  if (p === "") return "/";
  const rooted = p.startsWith("/") ? p : `/${p}`;
  const out: string[] = [];
  for (const seg of rooted.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  const clean = `/${out.join("/")}`;
  return rooted.endsWith("/") && clean !== "/" ? `${clean}/` : clean;
}

const isUnreserved = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2d || c === 0x5f || c === 0x2e || c === 0x7e;

function escapeWith(bytes: Buffer, keep: string): string {
  let out = "";
  for (const c of bytes) {
    out += isUnreserved(c) || keep.includes(String.fromCharCode(c)) ? String.fromCharCode(c) : `%${c.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** Go's URL.String() path form, for the Location of a redirect. */
export const escapeForLocation = (bytes: Buffer): string => escapeWith(bytes, "$&+,/:;=@");
/** What Express routes on: the decoded path, escaped again except "/" and the sub-delimiters that cannot change the parse. */
const escapeForRouting = (bytes: Buffer): string => escapeWith(bytes, "/!$&'()*+,;=:@");

/** Go's url.PathEscape: what a path segment is sent as, whatever its bytes. */
export const pathEscape = (bytes: Uint8Array): string => escapeWith(Buffer.from(bytes), "$&+=:@");

const decodedPaths = new WeakMap<IncomingMessage, Buffer>();
/** The request path after percent-decoding, as mux sees it: raw bytes. */
export const decodedPathOf = (req: IncomingMessage): Buffer => decodedPaths.get(req) ?? Buffer.alloc(0);
/** What follows the last "/" of the decoded path: `mux.Vars` of a route that ends in a variable. */
export function lastSegmentOf(req: IncomingMessage): Buffer {
  return segmentFromEnd(req, 0);
}

/**
 * A segment of the decoded path counted from the end (0 is the last): `mux.Vars` of a variable that
 * is followed by a literal, as in `/ships/{shipSymbol}/sell` (1). A `%2F` is a slash by the time the
 * router looks, so a variable never holds one.
 */
export function segmentFromEnd(req: IncomingMessage, fromEnd: number): Buffer {
  const path = decodedPathOf(req);
  let end = path.length;
  for (let n = 0; ; n++) {
    // (A negative offset would count from the other end.)
    if (end < 1) return Buffer.alloc(0);
    const start = path.lastIndexOf(0x2f, end - 1) + 1;
    if (n === fromEnd) return path.subarray(start, end);
    if (start === 0) return Buffer.alloc(0);
    end = start - 1;
  }
}

const CORS_HEADER_NAMES = [
  "Access-Control-Allow-Origin",
  "Access-Control-Allow-Methods",
  "Access-Control-Allow-Headers",
  "Access-Control-Expose-Headers",
];

function badRequest(res: Response): void {
  res.statusCode = 400;
  res.setHeader("Content-Type", TEXT);
  res.setHeader("Connection", "close");
  res.end("400 Bad Request");
}

/** Wrap in passthrough() at the call site: it answers malformed or unclean URLs only, never a resource. */
export const muxCompat: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  // Absolute-form ("GET http://host/path HTTP/1.1"): Go routes on the URL's path, so do we.
  // An empty path ("GET http://host") is "" there, which mux cleans to "/": a 301.
  const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?]*)([\s\S]*)$/.exec(req.url);
  const target = absolute === null ? req.url : (absolute[2] ?? "");
  // A "#" in the authority is an invalid host for Go's parser: 400 ("GET http://h#f").
  if ((absolute !== null && (absolute[1] ?? "").includes("#")) || (absolute === null && !target.startsWith("/"))) {
    // "OPTIONS *" is answered by Go's server itself (200, empty); here it is a 400. No caller sends it.
    badRequest(res);
    return;
  }
  const q = target.indexOf("?");
  const rawPath = q === -1 ? target : target.slice(0, q);
  const query = q === -1 ? "" : target.slice(q); // "?" included, also an empty query

  const decoded = unescapeBytes(rawPath);
  if (decoded === null) {
    badRequest(res);
    return;
  }
  const decodedStr = decoded.toString("latin1");
  const cleaned = cleanPath(decodedStr);
  if (cleaned !== decodedStr) {
    res.statusCode = 301;
    res.setHeader("Location", escapeForLocation(Buffer.from(cleaned, "latin1")) + query);
    res.end();
    return;
  }
  decodedPaths.set(req, decoded);
  req.url = escapeForRouting(Buffer.from(decoded.toString("utf8"), "utf8")) + query;
  next();
};

/** net/http's NotFound, which is what a path under /api/agent that no route takes gets. */
export function pageNotFound(res: Response): void {
  // CORS headers belong to a matched route; this answer is for none.
  for (const name of CORS_HEADER_NAMES) res.removeHeader(name);
  res.status(404);
  res.setHeader("Content-Type", TEXT);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end("404 page not found\n");
}

/** The terminal handler: wrap in notFound() from clerk-client. */
export const terminalAnswer = (req: Request, res: Response): void => {
  if (req.path.startsWith(AGENT_PREFIX)) {
    pageNotFound(res);
    return;
  }
  for (const name of CORS_HEADER_NAMES) res.removeHeader(name);
  // A catch-all OPTIONS route in the Go router makes every other method
  // "a wrong method on a path that exists": a bare 405, no body, no Allow.
  res.status(405).end();
};
