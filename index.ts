import type {IncomingMessage, IncomingHttpHeaders} from "node:http";
import type {Http2ServerRequest} from "node:http2";

type HostPort = {hostname: string; port: string};

function firstHeaderValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (!value) return undefined;
  const str = Array.isArray(value) ? value[0] : value;
  const commaIndex = str.indexOf(",");
  return commaIndex !== -1 ? str.slice(0, commaIndex).trim() : str;
}

function parseForwarded(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;
    let value = part.slice(eqIndex + 1).trim();
    if (value.length >= 2 && value.charCodeAt(0) === 0x22 && value.charCodeAt(value.length - 1) === 0x22) {
      value = value.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    result[part.slice(0, eqIndex).trim().toLowerCase()] = value;
  }
  return result;
}

function urlParseHostPort(hostStr: string): HostPort | null {
  const url = URL.parse(`http://${hostStr}`);
  return url ? {hostname: url.hostname, port: url.port} : null;
}

function parseHostPort(hostStr: string): HostPort | null {
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

/** Reconstruct the original URL from a HTTP/1 or HTTP/2 request. Returns `null` when the request does not form a valid URL. */
export function urlFromReq(req: IncomingMessage | Http2ServerRequest): URL | null {
  const rawUrl = ("originalUrl" in req && typeof req.originalUrl === "string" ? req.originalUrl : req.url) || "";

  if (rawUrl.includes("://")) {
    const parsed = URL.parse(rawUrl);
    if (parsed) return parsed;
  }

  let secure = false;
  if ("secure" in req) try { secure = Boolean(req.secure); } catch {} // req.secure can throw in Express
  if (!secure && req.socket && "encrypted" in req.socket) secure = req.socket.encrypted;
  if (!secure && "scheme" in req) secure = req.scheme === "https";

  let hostPort: HostPort | null = null;
  let forwardedProto: string | undefined;

  const forwardedHeader = firstHeaderValue(req.headers, "forwarded");
  if (forwardedHeader) {
    const forwarded = parseForwarded(forwardedHeader);
    if (forwarded.host) {
      hostPort = parseHostPort(forwarded.host);
      if (!hostPort) return null;
    }
    if (forwarded.proto) forwardedProto = `${forwarded.proto}:`;
  } else {
    const forwardedHost = firstHeaderValue(req.headers, "x-forwarded-host");
    if (forwardedHost) {
      hostPort = parseHostPort(forwardedHost);
      if (!hostPort) return null;
    }
  }

  if (!hostPort) {
    const hostHeader = req.headers.host ?? req.headers[":authority"];
    if (typeof hostHeader === "string") {
      hostPort = parseHostPort(hostHeader);
      if (!hostPort) return null;
    }
  }

  let protocol = "http:";
  if (forwardedProto) protocol = forwardedProto;
  else if (req.headers["x-forwarded-proto"]) protocol = `${firstHeaderValue(req.headers, "x-forwarded-proto")!}:`;
  else if (req.headers[":scheme"]) protocol = `${firstHeaderValue(req.headers, ":scheme")!}:`;
  else if (secure) protocol = "https:";

  const hostname = hostPort?.hostname || "localhost";
  const port = firstHeaderValue(req.headers, "x-forwarded-port") || hostPort?.port;
  const base = `${protocol}//${hostname}${port ? `:${port}` : ""}`;

  return URL.parse(rawUrl.startsWith("//") || rawUrl.startsWith("/\\") ? `/.${rawUrl}` : rawUrl || "/", base); // "/." keeps the path from parsing as a host
}
