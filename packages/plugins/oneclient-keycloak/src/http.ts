import http from "node:http";
import https from "node:https";

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Accept any TLS certificate (self-signed dev servers). */
  allowSelfSigned?: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * A minimal HTTP client on node:http(s) rather than `fetch`: it can accept self-signed certificates per request
 * (fetch can't without a global dispatcher), and it can force IPv4 for "localhost" — Docker Desktop and some
 * proxies accept the IPv6 connection that "localhost" resolves to first and then reset it.
 */
export function httpRequest(req: HttpRequest): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      reject(new Error(`Not a valid URL: ${req.url}`));
      return;
    }
    const secure = url.protocol === "https:";
    if (!secure && url.protocol !== "http:") {
      reject(new Error(`Unsupported protocol "${url.protocol}" — use http:// or https://`));
      return;
    }

    const headers: Record<string, string> = { Accept: "application/json, text/plain, */*", ...req.headers };
    if (req.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(req.body));

    const options: https.RequestOptions = {
      method: req.method,
      hostname: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers,
      ...(url.hostname === "localhost" ? { family: 4 } : {}),
      ...(secure ? { rejectUnauthorized: !req.allowSelfSigned } : {}),
    };

    const request = (secure ? https : http).request(options, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("Response too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    request.setTimeout(req.timeoutMs ?? 30_000, () => request.destroy(Object.assign(new Error("Request timed out"), { code: "ETIMEDOUT" })));
    request.on("error", reject);
    if (req.body !== undefined) request.write(req.body);
    request.end();
  });
}
