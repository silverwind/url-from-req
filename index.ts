import type {IncomingMessage, IncomingHttpHeaders} from "node:http";
import type {Http2ServerRequest} from "node:http2";

function firstHeaderValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (!value) return undefined;
  const str = Array.isArray(value) ? value[0] : value;
  const commaIndex = str.indexOf(",");
  return commaIndex !== -1 ? str.slice(0, commaIndex).trim() : str;
}

function parseForwarded(header: string): Record<string, string> | undefined {
  let result: Record<string, string> | undefined;
  for (const part of header.split(";")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;
    const key = part.slice(0, eqIndex).trim().toLowerCase();
    let value = part.slice(eqIndex + 1).trim();
    if (value.length >= 2 && value.charCodeAt(0) === 0x22 && value.charCodeAt(value.length - 1) === 0x22) {
      value = value.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    result ??= {};
    result[key] = value;
  }
  return result;
}

function urlParseHostPort(hostStr: string): {hostname: string; port: string} | null {
  const url = URL.parse(`http://${hostStr}`);
  return url ? {hostname: url.hostname, port: url.port} : null;
}

function parseHostPort(hostStr: string): {hostname: string; port: string} | null {
  if (hostStr.charCodeAt(0) === 0x5B) {
    const close = hostStr.indexOf("]");
    if (close === -1) return null;
    if (close === hostStr.length - 1) return {hostname: hostStr, port: ""};
    if (hostStr.charCodeAt(close + 1) === 0x3A) return {hostname: hostStr.slice(0, close + 1), port: hostStr.slice(close + 2)};
    return null;
  }
  const colon = hostStr.indexOf(":");
  if (colon === -1) {
    return !hostStr.includes(" ") ? {hostname: hostStr, port: ""} : urlParseHostPort(hostStr);
  }
  if (hostStr.includes(":", colon + 1)) {
    return urlParseHostPort(`[${hostStr}]`);
  }
  const hostname = hostStr.slice(0, colon);
  const port = hostStr.slice(colon + 1);
  return !hostname.includes(" ") && !port.includes(" ") ? {hostname, port} : urlParseHostPort(hostStr);
}

/** Reconstruct the original URL from a HTTP/1 or HTTP/2 request. */
export function urlFromReq(req: IncomingMessage | Http2ServerRequest): URL {
  const rawUrl = ("originalUrl" in req && typeof req.originalUrl === "string" ? req.originalUrl : req.url) || "";

  // absolute URL in req.url (rare: proxy requests) — return as-is
  if (rawUrl.includes("://")) {
    const parsed = URL.parse(rawUrl);
    if (parsed) return parsed;
  }

  // detect secure connection, req.secure can throw in Express
  let secure = false;
  if ("secure" in req) try { secure = Boolean(req.secure); } catch {}
  if (!secure && req.socket && "encrypted" in req.socket) secure = Boolean(req.socket.encrypted);
  if (!secure && "scheme" in req) secure = req.scheme === "https";

  // resolve host from headers (forwarded > x-forwarded-host > host > :authority)
  let hostUrl: {hostname: string; port: string} | null = null;
  let forwardedProto: string | undefined;

  const forwardedHeader = firstHeaderValue(req.headers, "forwarded");
  if (forwardedHeader) {
    const forwarded = parseForwarded(forwardedHeader);
    if (forwarded?.host) hostUrl = parseHostPort(forwarded.host);
    if (forwarded?.proto) forwardedProto = `${forwarded.proto}:`;
  } else {
    const forwardedHost = firstHeaderValue(req.headers, "x-forwarded-host");
    if (forwardedHost) hostUrl = parseHostPort(forwardedHost);
  }

  if (!hostUrl) {
    const hostHeader = req.headers.host ?? req.headers[":authority"];
    if (typeof hostHeader === "string") hostUrl = parseHostPort(hostHeader);
  }

  let protocol = "http:";
  if (forwardedProto) protocol = forwardedProto;
  else if (req.headers["x-forwarded-proto"]) protocol = `${firstHeaderValue(req.headers, "x-forwarded-proto")!}:`;
  else if (req.headers[":scheme"]) protocol = `${firstHeaderValue(req.headers, ":scheme")!}:`;
  else if (secure) protocol = "https:";

  const hostname = hostUrl?.hostname || "localhost";
  const port = firstHeaderValue(req.headers, "x-forwarded-port") || hostUrl?.port;
  const base = `${protocol}//${hostname}${port ? `:${port}` : ""}`;

  return new URL(rawUrl || "/", base);
}
