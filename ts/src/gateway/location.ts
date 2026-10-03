/**
 * @file Reading a redirect's `Location` the way Go's `url.Parse` and
 * `ResolveReference` do, with WHATWG URL doing the resolving.
 *
 * Where the two disagree, Go's verdict wins, because the contract pins what
 * the service does with a redirect (README note 25) and because the verdict
 * decides whether the caller's Authorization travels on:
 *
 *  - refused (the call is "st-gateway did not answer"): a control character
 *    anywhere, a malformed `%` in the path, the host or the fragment (not the
 *    query), a first path segment with a colon in a reference that has no
 *    scheme (so a leading space before `http://` is refused), a host with a
 *    character Go does not allow, a port that is not digits;
 *  - a backslash is an ordinary path character (`%5C` on the wire), not a slash;
 *  - the host is kept as written, with its case, because Go compares hosts
 *    byte for byte before it decides to strip Authorization.
 *
 * Not reproduced: Go converts a non-ASCII host to punycode with its own IDNA
 * tables, WHATWG with UTS 46; they agree on ordinary names.
 */

/** A request target: what fetch is given, and Go's `URL.Host` (case kept, port included). */
export interface Target {
  readonly url: URL;
  readonly host: string;
}

const CTL = /[\x00-\x1f\x7f]/;
const BAD_ESCAPE = /%(?![0-9A-Fa-f]{2})/;
/** Characters Go lets stand in a host (everything else below 0x80 is refused). */
const HOST_OK = /^[A-Za-z0-9\-._~!$&'()*+,;=:[\]<>"\u0080-￿%]*$/;

/** The `scheme:` of a reference, "" when it has none, null when Go calls the reference malformed. */
function schemeOf(ref: string): string | null {
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    const letter = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
    if (letter) continue;
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      if (i === 0) return "";
      continue;
    }
    if (c === 0x3a) return i === 0 ? null : ref.slice(0, i);
    return "";
  }
  return "";
}

/** True when Go's validOptionalPort and host rules accept `host` (as it stands between "//" and the next "/"). */
function hostAcceptable(host: string): boolean {
  if (!HOST_OK.test(host)) return false;
  // A percent sign in a host is only allowed as %25 or as part of an encoded non-ASCII byte.
  for (const m of host.matchAll(/%(.?)(.?)/g)) {
    if (!/^[0-9A-Fa-f]{2}$/.test(`${m[1]}${m[2]}`)) return false;
    if (Number.parseInt(m[1] as string, 16) < 8 && `${m[1]}${m[2]}` !== "25") return false;
  }
  const afterBracket = host.startsWith("[") ? host.indexOf("]") : -1;
  const colon = host.lastIndexOf(":");
  if (host.startsWith("[")) return afterBracket > 0 && (afterBracket === host.length - 1 || (host[afterBracket + 1] === ":" && /^:\d*$/.test(host.slice(afterBracket + 1))));
  return colon === -1 || /^\d*$/.test(host.slice(colon + 1));
}

/** The host name of a Go `URL.Host`: without the port and the brackets of an IPv6 literal. */
export function hostnameOf(host: string): string {
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]"));
  const colon = host.lastIndexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

/** Go's isDomainOrSubdomain, byte for byte (case matters). */
export const isDomainOrSubdomain = (sub: string, parent: string): boolean =>
  sub === parent || (sub.endsWith(parent) && sub[sub.length - parent.length - 1] === ".");

/**
 * `ref` resolved against `base` (or taken as it stands when `base` is null), or null when Go refuses it.
 */
export function resolveReference(base: Target | null, ref: string): Target | null {
  if (CTL.test(ref)) return null;
  const hash = ref.indexOf("#");
  if (hash !== -1 && BAD_ESCAPE.test(ref.slice(hash + 1))) return null;
  const noFragment = hash === -1 ? ref : ref.slice(0, hash);
  const q = noFragment.indexOf("?");
  let rest = q === -1 ? noFragment : noFragment.slice(0, q);
  const query = q === -1 ? "" : noFragment.slice(q);

  const scheme = schemeOf(rest);
  if (scheme === null) return null;
  rest = rest.slice(scheme === "" ? 0 : scheme.length + 1);
  if (scheme === "" && !rest.startsWith("/") && rest.split("/", 1)[0]?.includes(":")) return null;

  let host: string | undefined;
  let head = scheme === "" ? "" : `${scheme}:`;
  if (rest.startsWith("//") && (scheme !== "" || !rest.startsWith("///"))) {
    const slash = rest.indexOf("/", 2);
    const authority = slash === -1 ? rest.slice(2) : rest.slice(2, slash);
    host = authority.slice(authority.lastIndexOf("@") + 1);
    if (!hostAcceptable(host) || authority.includes("\\")) return null;
    head += rest.slice(0, slash === -1 ? rest.length : slash);
    rest = slash === -1 ? "" : rest.slice(slash);
  } else if (scheme !== "" && !rest.startsWith("/")) {
    // An opaque reference ("mailto:x"): fetch refuses its scheme.
    return null;
  }
  if (BAD_ESCAPE.test(rest)) return null;

  const built = `${head}${rest.replaceAll("\\", "%5C")}${query}`;
  if (base === null && host === undefined) return null;
  try {
    const url = base === null ? new URL(built) : new URL(built, base.url);
    return { url, host: host ?? (base as Target).host };
  } catch {
    return null;
  }
}
