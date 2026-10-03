/**
 * Go's url.PathEscape, which the service applies to every path segment it sends
 * to the gateway: only letters, digits and - _ . ~ stay as they are, plus
 * $ & + = : @ (legal in a segment); everything else, including , ; / ? and the
 * characters encodeURIComponent leaves alone (! ' ( ) *), is %XX in upper case.
 */
export function goPathEscape(segment: string): string {
  let out = '';
  for (const byte of Buffer.from(segment, 'utf8')) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~$&+=:@]/.test(ch)) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}
