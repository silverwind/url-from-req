import {afterAll, describe, expect, test} from "vitest";
import {once} from "node:events";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import type {AddressInfo, Server} from "node:net";
import {text} from "node:stream/consumers";
import {urlFromReq} from "./index.ts";

const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgFIgASgs7VOgg1ceE
sOcbiYq4fyOatdBFfJ6W+/Z9LxWhRANCAATI9fdsBMcpn0++uOSKGqOPo+v7VMo4
QtC0EAfxqtCfIdqLdQmGS0Aj35YZvDLDcEJfaDlInpbf8BwKhsVMcEhx
-----END PRIVATE KEY-----`;
const cert = `-----BEGIN CERTIFICATE-----
MIIBgDCCASWgAwIBAgIUePXCuz6bBbqUmoS9/TH5mb08Ho8wCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDMxODE5MTk1NVoYDzQyODQxMjI1
MTkxOTU1WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAATI9fdsBMcpn0++uOSKGqOPo+v7VMo4QtC0EAfxqtCfIdqLdQmGS0Aj
35YZvDLDcEJfaDlInpbf8BwKhsVMcEhxo1MwUTAdBgNVHQ4EFgQUagh6MunOS3Sm
b4NcJvUdA3i5MtQwHwYDVR0jBBgwFoAUagh6MunOS3Smb4NcJvUdA3i5MtQwDwYD
VR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEAm04PiLWuwocErEtQJMN3
ePJZRoFezP7aBPGMI/aqpRACIQC8kq8AEN7dMZdQDfM7w99I/mhHmTMznxgMpEyI
fr/zdQ==
-----END CERTIFICATE-----`;

const servers: Server[] = [
  http.createServer((req, res) => res.end(urlFromReq(req)!.href)),
  https.createServer({key, cert}, (req, res) => res.end(urlFromReq(req)!.href)),
  http2.createSecureServer({key, cert, allowHTTP1: true}, (req, res) => res.end(urlFromReq(req)!.href)),
];
const [httpPort, httpsPort, http2Port] = await Promise.all(servers.map(async server => {
  await once(server.listen(0, "127.0.0.1"), "listening");
  return (server.address() as AddressInfo).port;
}));
const http2Client = http2.connect(`https://127.0.0.1:${http2Port}`, {rejectUnauthorized: false});
afterAll(() => {
  http2Client.close();
  for (const server of servers) server.close();
});

function request(req: http.ClientRequest): Promise<string> {
  return new Promise((resolve, reject) => req.on("response", res => resolve(text(res))).on("error", reject).end());
}

const httpGet = (path: string, headers?: http.OutgoingHttpHeaders) => request(http.request({host: "127.0.0.1", port: httpPort, path, headers}));
const httpsGet = (path: string, headers?: http.OutgoingHttpHeaders) => request(https.request({host: "127.0.0.1", port: httpsPort, path, headers, rejectUnauthorized: false}));
const http2Get = (path: string, headers?: http2.OutgoingHttpHeaders) => text(http2Client.request({":path": path, ...headers}));

test.each<[string, () => Promise<string>, string]>([
  ["http1 root path", () => httpGet("/"), `http://127.0.0.1:${httpPort}/`],
  ["http1 path with query", () => httpGet("/path?q=1"), `http://127.0.0.1:${httpPort}/path?q=1`],
  ["http1 x-forwarded-proto", () => httpGet("/", {"x-forwarded-proto": "https"}), `https://127.0.0.1:${httpPort}/`],
  ["http1 x-forwarded-host", () => httpGet("/path", {"x-forwarded-host": "public.com"}), "http://public.com/path"],
  ["http1 x-forwarded-host with port", () => httpGet("/", {"x-forwarded-host": "public.com:8080"}), "http://public.com:8080/"],
  ["http1 x-forwarded-port", () => httpGet("/", {"x-forwarded-port": "9090"}), "http://127.0.0.1:9090/"],
  ["http1 forwarded host and proto", () => httpGet("/path", {forwarded: "host=public.com;proto=https"}), "https://public.com/path"],
  ["http1 forwarded host with port", () => httpGet("/", {forwarded: "host=public.com:8443;proto=https"}), "https://public.com:8443/"],
  ["http1 forwarded proto only falls through to host header", () => httpGet("/", {forwarded: "proto=https"}), `https://127.0.0.1:${httpPort}/`],
  ["http1 forwarded takes priority over x-forwarded-host", () => httpGet("/", {forwarded: "host=forwarded.com", "x-forwarded-host": "xforwarded.com"}), "http://forwarded.com/"],
  ["http1 custom host header", () => httpGet("/", {host: "custom.com:3000"}), "http://custom.com:3000/"],
  ["https detects encrypted connection", () => httpsGet("/"), `https://127.0.0.1:${httpsPort}/`],
  ["https path with query", () => httpsGet("/secure?token=abc"), `https://127.0.0.1:${httpsPort}/secure?token=abc`],
  ["https x-forwarded-proto overrides detected protocol", () => httpsGet("/", {"x-forwarded-proto": "http"}), `http://127.0.0.1:${httpsPort}/`],
  ["http2 uses :authority for hostname", () => http2Get("/"), `https://127.0.0.1:${http2Port}/`],
  ["http2 path with query", () => http2Get("/path?q=1"), `https://127.0.0.1:${http2Port}/path?q=1`],
  ["http2 x-forwarded-host overrides :authority", () => http2Get("/", {"x-forwarded-host": "public.com"}), "https://public.com/"],
  ["http2 forwarded header", () => http2Get("/path", {forwarded: "host=proxy.com:443;proto=https"}), "https://proxy.com/path"],
  ["http2 x-forwarded-proto overrides :scheme", () => http2Get("/", {"x-forwarded-proto": "http"}), `http://127.0.0.1:${http2Port}/`],
])("%s", async (_name, get, href) => expect(await get()).toBe(href));

type MockReq = {url?: string; originalUrl?: string; headers?: Record<string, string | string[]>; socket?: {encrypted: boolean}; scheme?: string};

function mockReq(req: MockReq) {
  return {url: "/", headers: {}, socket: {encrypted: false}, ...req} as unknown as http.IncomingMessage;
}

function reqUrl(opts: MockReq): URL {
  return urlFromReq(mockReq(opts))!;
}

test("req.secure throwing does not crash", () => {
  expect(urlFromReq({url: "/", headers: {host: "example.com"}, socket: {}, get secure(): boolean { throw new Error("trust is not a function"); }} as unknown as http.IncomingMessage)!.href).toBe("http://example.com/");
});

test.each<[string, MockReq, string]>([
  ["express req.originalUrl", {url: "/modified", originalUrl: "/original?q=1", headers: {host: "example.com"}}, "http://example.com/original?q=1"],
  ["req.scheme https", {headers: {":authority": "example.com"}, scheme: "https"}, "https://example.com/"],
  [":scheme header", {headers: {":authority": "example.com", ":scheme": "https"}}, "https://example.com/"],
  ["host header takes priority over :authority", {headers: {host: "host.com", ":authority": "authority.com"}}, "http://host.com/"],
  ["no host header falls back to localhost", {url: "/path"}, "http://localhost/path"],
  ["full url in req.url", {url: "http://example.com/path?q=1"}, "http://example.com/path?q=1"],
  ["header as array", {headers: {host: "example.com", "x-forwarded-proto": ["https", "http"]}}, "https://example.com/"],
  ["multiple x-forwarded-proto values", {headers: {host: "example.com", "x-forwarded-proto": "https, http"}}, "https://example.com/"],
  ["multiple forwarded entries uses first", {headers: {forwarded: "host=first.com;proto=https, host=second.com;proto=http"}}, "https://first.com/"],
  ["forwarded quoted host", {headers: {forwarded: 'host="example.com:8080";proto=https'}}, "https://example.com:8080/"],
  ["forwarded ipv6 host", {headers: {forwarded: 'host="[::1]:8080";proto=http'}}, "http://[::1]:8080/"],
  ["bracketed ipv6 host header", {headers: {host: "[::1]:8080"}}, "http://[::1]:8080/"],
  ["bracketed ipv6 without port", {headers: {host: "[::1]"}}, "http://[::1]/"],
  ["bare ipv6 gets brackets", {headers: {host: "::1"}}, "http://[::1]/"],
  ["full ipv6 address with port", {headers: {host: "[2001:db8::1]:443"}}, "http://[2001:db8::1]:443/"],
  ["empty url", {url: "", headers: {host: "example.com"}}, "http://example.com/"],
  ["hostname is normalized to lowercase", {headers: {host: "Example.COM"}}, "http://example.com/"],
  ["default port 80 is omitted for http", {headers: {host: "example.com:80"}}, "http://example.com/"],
  ["default port 443 is omitted for https", {headers: {host: "example.com:443"}, socket: {encrypted: true}}, "https://example.com/"],
  ["pathname trailing slash is normalized", {headers: {host: "example.com"}}, "http://example.com/"],
  ["percent-encoded path is preserved", {url: "/path%20with%20spaces", headers: {host: "example.com"}}, "http://example.com/path%20with%20spaces"],
  ["rfc 7239 forwarded with for, by, host, proto", {headers: {forwarded: "for=192.0.2.60;proto=https;by=203.0.113.43;host=example.com"}}, "https://example.com/"],
  ["rfc 7239 forwarded with quoted ipv6 for", {headers: {forwarded: 'for="[2001:db8:cafe::17]";host=example.com'}}, "http://example.com/"],
  ["rfc 7239 case-insensitive parameter names", {headers: {forwarded: "Host=example.com;Proto=https"}}, "https://example.com/"],
  ["rfc 7230 host header with ipv6 and port", {url: "/path", headers: {host: "[2001:db8::1]:8080"}}, "http://[2001:db8::1]:8080/path"],
  ["http2 :authority with port", {headers: {":authority": "example.com:8443", ":scheme": "https"}}, "https://example.com:8443/"],
  ["header priority: forwarded proto > x-forwarded-proto", {headers: {host: "example.com", forwarded: "proto=https", "x-forwarded-proto": "http"}}, "https://example.com/"],
  ["header priority: x-forwarded-proto > :scheme", {headers: {host: "example.com", "x-forwarded-proto": "http", ":scheme": "https"}}, "http://example.com/"],
  ["header priority: x-forwarded-host > host", {headers: {host: "internal.local", "x-forwarded-host": "public.com"}}, "http://public.com/"],
  ["x-forwarded-host comma-separated uses first", {headers: {host: "internal.local", "x-forwarded-host": "example.com, foobar.com"}}, "http://example.com/"],
  ["x-forwarded-host comma-separated with whitespace", {headers: {host: "internal.local", "x-forwarded-host": "example.com:8080 , foobar.com:9090"}}, "http://example.com:8080/"],
  ["x-forwarded-host as array uses first", {headers: {host: "internal.local", "x-forwarded-host": ["example.com", "foobar.com"]}}, "http://example.com/"],
  ["x-forwarded-port as array uses first", {headers: {host: "example.com", "x-forwarded-port": ["1337", "80"]}}, "http://example.com:1337/"],
  ["forwarded header as array uses first", {headers: {forwarded: ["host=first.com;proto=https", "host=second.com;proto=http"]}}, "https://first.com/"],
  ["empty x-forwarded-proto falls back", {headers: {host: "example.com", "x-forwarded-proto": ""}}, "http://example.com/"],
  ["host header with userinfo", {headers: {host: "user@example.com"}}, "http://user@example.com/"],
  ["long-form ipv6 is normalized", {headers: {host: "[2001:cdba:0000:0000:0000:0000:3257:9652]:1337"}}, "http://[2001:cdba::3257:9652]:1337/"],
  ["plain ipv4 host without port", {url: "/path", headers: {host: "127.0.0.1"}}, "http://127.0.0.1/path"],
  ["path with hash fragment", {url: "/path#fragment", headers: {host: "example.com"}}, "http://example.com/path#fragment"],
  ["path with query and hash", {url: "/path?q=1#frag", headers: {host: "example.com"}}, "http://example.com/path?q=1#frag"],
  ["host header with path is ignored for path", {url: "/actual", headers: {host: "example.com:8080/ignored"}}, "http://example.com:8080/actual"],
])("%s", (_name, req, href) => expect(reqUrl(req).href).toBe(href));

test("protocol-relative path does not override host", () => {
  expect(reqUrl({url: "//todo@txt", headers: {host: "example.com"}}).href).toBe("http://example.com//todo@txt");
  expect(reqUrl({url: "/\\evil.com/path", headers: {host: "example.com"}}).href).toBe("http://example.com//evil.com/path");
});

describe("invalid input returns null", () => {
  test.each<[string, MockReq]>([
    ["host header with spaces", {url: "/path", headers: {host: "invalid host with spaces"}}],
    ["host header with userinfo and port", {url: "/path", headers: {host: "user:pass@example.com:8080"}}],
    ["host header with non-numeric port", {headers: {host: "example.com:x"}}],
    ["host header with invalid characters", {headers: {host: "%"}}],
    ["invalid x-forwarded-proto", {headers: {host: "example.com", "x-forwarded-proto": "ja va"}}],
    ["invalid forwarded proto", {headers: {forwarded: "host=example.com;proto=ja va"}}],
    ["invalid x-forwarded-host with non-numeric port", {headers: {host: "example.com", "x-forwarded-host": "public.com:x"}}],
    ["unparseable forwarded host is not rescued by valid host header", {headers: {forwarded: "host=[::1;proto=https", host: "example.com"}}],
  ])("%s", (_name, req) => expect(urlFromReq(mockReq(req))).toBeNull());
});
