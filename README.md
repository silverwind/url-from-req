# url-from-req

[![](https://img.shields.io/npm/v/url-from-req.svg?style=flat)](https://www.npmjs.org/package/url-from-req) [![](https://img.shields.io/npm/dm/url-from-req.svg)](https://www.npmjs.org/package/url-from-req) [![](https://packagephobia.com/badge?p=url-from-req)](https://packagephobia.com/result?p=url-from-req) [![](https://depx.co/api/badge/url-from-req)](https://depx.co/pkg/url-from-req)

Returns a [`URL`](https://developer.mozilla.org/en-US/docs/Web/API/URL) object from a Node.js `IncomingMessage` or `Http2ServerRequest`, accounting for proxy headers.

## Features

- Works with HTTP/1.1, HTTPS, and HTTP/2
- Supports `Forwarded` (RFC 7239), `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-Port`
- Zero dependencies

## Usage

```ts
import http from "node:http";
import http2 from "node:http2";
import urlFromReq from "url-from-req";

http.createServer((req, res) => {
  res.end(urlFromReq(req).href); // "http://example.com/path?q=1"
}).listen(3000);

http2.createSecureServer({key, cert}, (req, res) => {
  res.end(urlFromReq(req).href); // "https://example.com/path?q=1"
}).listen(3001);
```

## License

BSD-2-Clause
