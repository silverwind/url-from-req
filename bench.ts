import urlFromReq from "./index.ts";

const iterations = 100_000;

const reqs = [
  {name: "simple", req: {url: "/path?q=1", headers: {host: "example.com:8080"}, socket: {}}},
  {name: "x-forwarded", req: {url: "/path?q=1", headers: {host: "internal.local", "x-forwarded-host": "public.com:443", "x-forwarded-proto": "https"}, socket: {}}},
  {name: "forwarded", req: {url: "/path", headers: {host: "internal.local", forwarded: "host=public.com:8443;proto=https"}, socket: {}}},
];

for (const {name, req} of reqs) {
  for (let i = 0; i < 1000; i++) urlFromReq(req as never);
  const start = performance.now();
  for (let i = 0; i < iterations; i++) urlFromReq(req as never);
  const time = performance.now() - start;
  console.info(`${name.padEnd(14)} ${(iterations / time * 1000).toFixed(0).padStart(10)} ops/sec  ${(time / iterations * 1000).toFixed(1).padStart(5)}µs/op`);
}
