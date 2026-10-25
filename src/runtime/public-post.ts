/**
 * Outbound POSTs to user-configured URLs (alert webhooks) on Node.
 *
 * The connection uses an address that `publicLookup` has checked, so a hostname can't pass a check with
 * a public address and then resolve to an internal one for the actual request (DNS rebinding).
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { request } from "node:https";
import { isPublicIp } from "../server/lib/net";

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A `dns.lookup` replacement that fails when any address for the name is private, loopback or link-local. */
export function publicLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    if (!addresses.length || addresses.some((a) => !isPublicIp(a.address))) {
      const error: NodeJS.ErrnoException = new Error("The destination resolves to a private or internal address");
      error.code = "EPRIVATEADDR";
      return callback(error, "", 0);
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

/** POSTs `body` to an https URL through `publicLookup`. Resolves with the status and up to 4 kB of the response. */
export function postPublic(url: URL, body: string, headers: Record<string, string>, timeoutMs = 10_000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
        lookup: publicLookup as never,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (text.length < 4096) text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text.slice(0, 4096) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
