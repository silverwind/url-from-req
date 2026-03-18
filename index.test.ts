import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {execSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import type {AddressInfo} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import urlFromReq from "./index.ts";

let httpServer: http.Server;
let httpsServer: https.Server;
let http2Server: http2.Http2SecureServer;
let httpPort: number;
let httpsPort: number;
let http2Port: number;

function listen(server: http.Server | https.Server | http2.Http2SecureServer): Promise<number> {
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function toJSON(req: http.ClientRequest): Promise<URL> {
  return new Promise((resolve, reject) => {
    req.on("response", (res: http.IncomingMessage) => {
      let data = "";
      res.on("data", (chunk: string) => data += chunk);
      res.on("end", () => resolve(new URL(JSON.parse(data))));
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "url-from-req-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`, {stdio: "ignore"});
  const key = readFileSync(keyPath, "utf8");
  const cert = readFileSync(certPath, "utf8");
  rmSync(dir, {recursive: true});

  httpServer = http.createServer((req, res) => {
    res.writeHead(200, {"content-type": "application/json"});
    res.end(JSON.stringify(urlFromReq(req).href));
  });
  httpsServer = https.createServer({key, cert}, (req, res) => {
    res.writeHead(200, {"content-type": "application/json"});
    res.end(JSON.stringify(urlFromReq(req).href));
  });
  http2Server = http2.createSecureServer({key, cert, allowHTTP1: true}, (req, res) => {
    res.writeHead(200, {"content-type": "application/json"});
    res.end(JSON.stringify(urlFromReq(req).href));
  });

  [httpPort, httpsPort, http2Port] = await Promise.all([
    listen(httpServer),
    listen(httpsServer),
    listen(http2Server),
  ]);
});

afterAll(() => {
  httpServer?.close();
  httpsServer?.close();
  http2Server?.close();
});

function httpGet(path: string, headers: Record<string, string> = {}) {
  return toJSON(http.request({hostname: "127.0.0.1", port: httpPort, path, headers: {host: `127.0.0.1:${httpPort}`, ...headers}}));
}

function httpsGet(path: string, headers: Record<string, string> = {}) {
  return toJSON(https.request({hostname: "127.0.0.1", port: httpsPort, path, headers: {host: `127.0.0.1:${httpsPort}`, ...headers}, rejectUnauthorized: false}));
}

function http2Get(path: string, headers: Record<string, string> = {}): Promise<URL> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://127.0.0.1:${http2Port}`, {rejectUnauthorized: false});
    const req = client.request({":path": path, ":method": "GET", ...headers});
    let data = "";
    req.on("data", (chunk: Buffer) => data += String(chunk));
    req.on("end", () => {
      client.close();
      resolve(new URL(JSON.parse(data)));
    });
    req.on("error", reject);
  });
}

describe("http1", () => {
  test("root path", async () => {
    const r = await httpGet("/");
    expect(r.protocol).toBe("http:");
    expect(r.hostname).toBe("127.0.0.1");
    expect(r.port).toBe(String(httpPort));
    expect(r.pathname).toBe("/");
    expect(r.href).toBe(`http://127.0.0.1:${httpPort}/`);
  });

  test("path with query", async () => {
    const r = await httpGet("/path?q=1");
    expect(r.pathname).toBe("/path");
    expect(r.search).toBe("?q=1");
    expect(r.href).toBe(`http://127.0.0.1:${httpPort}/path?q=1`);
  });

  test("x-forwarded-proto", async () => {
    const r = await httpGet("/", {"x-forwarded-proto": "https"});
    expect(r.protocol).toBe("https:");
  });

  test("x-forwarded-host", async () => {
    const r = await httpGet("/path", {"x-forwarded-host": "public.com"});
    expect(r.hostname).toBe("public.com");
    expect(r.href).toBe("http://public.com/path");
  });

  test("x-forwarded-host with port", async () => {
    const r = await httpGet("/", {"x-forwarded-host": "public.com:8080"});
    expect(r.hostname).toBe("public.com");
    expect(r.port).toBe("8080");
  });

  test("x-forwarded-port", async () => {
    const r = await httpGet("/", {"x-forwarded-port": "9090"});
    expect(r.port).toBe("9090");
  });


  test("forwarded host and proto", async () => {
    const r = await httpGet("/path", {forwarded: "host=public.com;proto=https"});
    expect(r.hostname).toBe("public.com");
    expect(r.protocol).toBe("https:");
    expect(r.href).toBe("https://public.com/path");
  });

  test("forwarded host with port", async () => {
    const r = await httpGet("/", {forwarded: "host=public.com:8443;proto=https"});
    expect(r.hostname).toBe("public.com");
    expect(r.port).toBe("8443");
    expect(r.href).toBe("https://public.com:8443/");
  });

  test("forwarded proto only falls through to host header", async () => {
    const r = await httpGet("/", {forwarded: "proto=https"});
    expect(r.hostname).toBe("127.0.0.1");
    expect(r.protocol).toBe("https:");
  });

  test("forwarded takes priority over x-forwarded-host", async () => {
    const r = await httpGet("/", {forwarded: "host=forwarded.com", "x-forwarded-host": "xforwarded.com"});
    expect(r.hostname).toBe("forwarded.com");
  });

  test("custom host header", async () => {
    const r = await httpGet("/", {host: "custom.com:3000"});
    expect(r.hostname).toBe("custom.com");
    expect(r.port).toBe("3000");
  });
});

describe("https", () => {
  test("detects encrypted connection", async () => {
    const r = await httpsGet("/");
    expect(r.protocol).toBe("https:");
    expect(r.href).toBe(`https://127.0.0.1:${httpsPort}/`);
  });

  test("path with query", async () => {
    const r = await httpsGet("/secure?token=abc");
    expect(r.protocol).toBe("https:");
    expect(r.pathname).toBe("/secure");
    expect(r.search).toBe("?token=abc");
  });

  test("x-forwarded-proto overrides detected protocol", async () => {
    const r = await httpsGet("/", {"x-forwarded-proto": "http"});
    expect(r.protocol).toBe("http:");
  });
});

describe("http2", () => {
  test("uses :authority for hostname", async () => {
    const r = await http2Get("/");
    expect(r.hostname).toBe("127.0.0.1");
    expect(r.port).toBe(String(http2Port));
    expect(r.protocol).toBe("https:");
  });

  test("path with query", async () => {
    const r = await http2Get("/path?q=1");
    expect(r.pathname).toBe("/path");
    expect(r.search).toBe("?q=1");
    expect(r.href).toBe(`https://127.0.0.1:${http2Port}/path?q=1`);
  });

  test("x-forwarded-host overrides :authority", async () => {
    const r = await http2Get("/", {"x-forwarded-host": "public.com"});
    expect(r.hostname).toBe("public.com");
  });

  test("forwarded header", async () => {
    const r = await http2Get("/path", {forwarded: "host=proxy.com:443;proto=https"});
    expect(r.hostname).toBe("proxy.com");
    expect(r.port).toBe("");
  });

  test("x-forwarded-proto overrides :scheme", async () => {
    const r = await http2Get("/", {"x-forwarded-proto": "http"});
    expect(r.protocol).toBe("http:");
  });
});

function mockReq(opts: {
  url?: string;
  originalUrl?: string;
  headers?: Record<string, string | string[]>;
  encrypted?: boolean;
  secure?: boolean;
  scheme?: string;
} = {}) {
  return {
    url: opts.url ?? "/",
    originalUrl: opts.originalUrl,
    secure: opts.secure,
    scheme: opts.scheme,
    socket: {encrypted: opts.encrypted ?? false},
    headers: opts.headers ?? {},
  } as unknown as http.IncomingMessage;
}

describe("mock tests", () => {
  test("req.secure throwing does not crash", () => {
    const req = {
      url: "/",
      headers: {host: "example.com"},
      socket: {},
      get secure(): boolean { throw new Error("trust is not a function"); },
    } as unknown as http.IncomingMessage;
    expect(urlFromReq(req).protocol).toBe("http:");
  });

  test("express req.originalUrl", () => {
    const r = urlFromReq(mockReq({
      url: "/modified",
      originalUrl: "/original?q=1",
      headers: {host: "example.com"},
    }));
    expect(r.href).toBe("http://example.com/original?q=1");
  });

  test("req.scheme https", () => {
    const r = urlFromReq(mockReq({url: "/", headers: {":authority": "example.com"}, scheme: "https"}));
    expect(r.protocol).toBe("https:");
  });

  test(":scheme header", () => {
    const r = urlFromReq(mockReq({url: "/", headers: {":authority": "example.com", ":scheme": "https"}}));
    expect(r.protocol).toBe("https:");
    expect(r.href).toBe("https://example.com/");
  });

  test("host header takes priority over :authority", () => {
    const r = urlFromReq(mockReq({url: "/", headers: {host: "host.com", ":authority": "authority.com"}}));
    expect(r.hostname).toBe("host.com");
  });

  test("no host header falls back to localhost", () => {
    const r = urlFromReq(mockReq({url: "/path"}));
    expect(r.hostname).toBe("localhost");
    expect(r.pathname).toBe("/path");
  });

  test("full url in req.url", () => {
    const r = urlFromReq(mockReq({url: "http://example.com/path?q=1", headers: {}}));
    expect(r.href).toBe("http://example.com/path?q=1");
  });

  test("header as array", () => {
    const r = urlFromReq(mockReq({url: "/", headers: {host: "example.com", "x-forwarded-proto": ["https", "http"]}}));
    expect(r.protocol).toBe("https:");
  });

  test("multiple x-forwarded-proto values", () => {
    const r = urlFromReq(mockReq({url: "/", headers: {host: "example.com", "x-forwarded-proto": "https, http"}}));
    expect(r.protocol).toBe("https:");
  });

  test("multiple forwarded entries uses first", () => {
    const r = urlFromReq(mockReq({url: "/", headers: {forwarded: "host=first.com;proto=https, host=second.com;proto=http"}}));
    expect(r.hostname).toBe("first.com");
    expect(r.protocol).toBe("https:");
  });

  test("forwarded quoted host", () => {
    const r = urlFromReq(mockReq({url: "/", headers: {forwarded: 'host="example.com:8080";proto=https'}}));
    expect(r.hostname).toBe("example.com");
    expect(r.port).toBe("8080");
    expect(r.protocol).toBe("https:");
  });

  test("forwarded ipv6 host", () => {
    const r = urlFromReq(mockReq({url: "/", headers: {forwarded: 'host="[::1]:8080";proto=http'}}));
    expect(r.hostname).toBe("[::1]");
    expect(r.port).toBe("8080");
  });

  test("bracketed ipv6 host header", () => {
    const r = urlFromReq(mockReq({url: "/", headers: {host: "[::1]:8080"}}));
    expect(r.hostname).toBe("[::1]");
    expect(r.port).toBe("8080");
    expect(r.href).toBe("http://[::1]:8080/");
  });

  test("bracketed ipv6 without port", () => {
    const r = urlFromReq(mockReq({url: "/", headers: {host: "[::1]"}}));
    expect(r.hostname).toBe("[::1]");
    expect(r.href).toBe("http://[::1]/");
  });

  test("bare ipv6 gets brackets", () => {
    const r = urlFromReq(mockReq({url: "/", headers: {host: "::1"}}));
    expect(r.hostname).toBe("[::1]");
    expect(r.href).toBe("http://[::1]/");
  });

  test("full ipv6 address with port", () => {
    const r = urlFromReq(mockReq({url: "/", headers: {host: "[2001:db8::1]:443"}}));
    expect(r.hostname).toBe("[2001:db8::1]");
    expect(r.port).toBe("443");
  });

  test("empty url", () => {
    const r = urlFromReq(mockReq({url: "", headers: {host: "example.com"}}));
    expect(r.href).toBe("http://example.com/");
  });
});

describe("spec compliance", () => {
  // WHATWG URL: hostname is lowercased
  test("hostname is normalized to lowercase", () => {
    const r = urlFromReq(mockReq({headers: {host: "Example.COM"}}));
    expect(r.hostname).toBe("example.com");
  });

  // WHATWG URL: default ports are omitted
  test("default port 80 is omitted for http", () => {
    const r = urlFromReq(mockReq({headers: {host: "example.com:80"}}));
    expect(r.port).toBe("");
    expect(r.href).toBe("http://example.com/");
  });

  test("default port 443 is omitted for https", () => {
    const r = urlFromReq(mockReq({headers: {host: "example.com:443"}, encrypted: true}));
    expect(r.port).toBe("");
    expect(r.href).toBe("https://example.com/");
  });

  // WHATWG URL: pathname is normalized
  test("pathname trailing slash is normalized", () => {
    const r = urlFromReq(mockReq({headers: {host: "example.com"}}));
    expect(r.pathname).toBe("/");
  });

  // WHATWG URL: percent-encoding is preserved
  test("percent-encoded path is preserved", () => {
    const r = urlFromReq(mockReq({url: "/path%20with%20spaces", headers: {host: "example.com"}}));
    expect(r.pathname).toBe("/path%20with%20spaces");
  });

  // RFC 7239: Forwarded header with all parameters
  test("rfc 7239 forwarded with for, by, host, proto", () => {
    const r = urlFromReq(mockReq({url: "/", headers: {forwarded: "for=192.0.2.60;proto=https;by=203.0.113.43;host=example.com"}}));
    expect(r.hostname).toBe("example.com");
    expect(r.protocol).toBe("https:");
  });

  // RFC 7239: Forwarded with quoted IPv6 for
  test("rfc 7239 forwarded with quoted ipv6 for", () => {
    const r = urlFromReq(mockReq({url: "/", headers: {forwarded: 'for="[2001:db8:cafe::17]";host=example.com'}}));
    expect(r.hostname).toBe("example.com");
  });

  // RFC 7239: case-insensitive parameter names
  test("rfc 7239 case-insensitive parameter names", () => {
    const r = urlFromReq(mockReq({url: "/", headers: {forwarded: "Host=example.com;Proto=https"}}));
    expect(r.hostname).toBe("example.com");
    expect(r.protocol).toBe("https:");
  });

  // RFC 7230: Host header with IPv6
  test("rfc 7230 host header with ipv6 and port", () => {
    const r = urlFromReq(mockReq({url: "/path", headers: {host: "[2001:db8::1]:8080"}}));
    expect(r.hostname).toBe("[2001:db8::1]");
    expect(r.port).toBe("8080");
    expect(r.pathname).toBe("/path");
  });

  // HTTP/2 pseudo-headers
  test("http2 :authority with port", () => {
    const r = urlFromReq(mockReq({url: "/", headers: {":authority": "example.com:8443", ":scheme": "https"}}));
    expect(r.hostname).toBe("example.com");
    expect(r.port).toBe("8443");
    expect(r.protocol).toBe("https:");
  });

  // Priority: Forwarded > X-Forwarded-Proto > :scheme > socket
  test("header priority: forwarded proto > x-forwarded-proto", () => {
    const r = urlFromReq(mockReq({url: "/", headers: {
      host: "example.com",
      forwarded: "proto=https",
      "x-forwarded-proto": "http",
    }}));
    expect(r.protocol).toBe("https:");
  });

  test("header priority: x-forwarded-proto > :scheme", () => {
    const r = urlFromReq(mockReq({url: "/", headers: {
      host: "example.com",
      "x-forwarded-proto": "http",
      ":scheme": "https",
    }}));
    expect(r.protocol).toBe("http:");
  });

  test("header priority: x-forwarded-host > host", () => {
    const r = urlFromReq(mockReq({url: "/", headers: {
      host: "internal.local",
      "x-forwarded-host": "public.com",
    }}));
    expect(r.hostname).toBe("public.com");
  });
});
