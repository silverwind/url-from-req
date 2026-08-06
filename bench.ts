import {urlFromReq} from "./index.ts";

const runs = Number(process.env.BENCH_RUNS) || 5;
const filter = process.env.BENCH_FILTER;

// Results escape here, otherwise V8 deletes the measured work outright.
let sink: unknown;

function bench(name: string, ops: number, fn: () => unknown): void {
  if (filter && !name.includes(filter)) return;
  for (let i = 0; i < ops; i++) sink = fn(); // warmup
  const times: number[] = [];
  for (let run = 0; run < runs; run++) {
    const start = performance.now();
    for (let i = 0; i < ops; i++) sink = fn();
    times.push((performance.now() - start) * 1e6 / ops);
  }
  times.sort((a, b) => a - b);
  console.info(`${name.padEnd(14)}${times[runs >> 1].toFixed(1).padStart(9)} ns/op`);
}

const reqs = [
  {name: "simple", req: {url: "/path?q=1", headers: {host: "example.com:8080"}, socket: {}}},
  {name: "x-forwarded", req: {url: "/path?q=1", headers: {host: "internal.local", "x-forwarded-host": "public.com:443", "x-forwarded-proto": "https"}, socket: {}}},
  {name: "forwarded", req: {url: "/path", headers: {host: "internal.local", forwarded: "host=public.com:8443;proto=https"}, socket: {}}},
];

for (const {name, req} of reqs) {
  bench(name, 1e5, () => urlFromReq(req as never));
}

if (sink === undefined) console.error("sink is empty, results were optimized away");
