# url-from-req

> Reconstruct the original URL from a HTTP/1 or HTTP/2 request

Returns a [`URL`](https://developer.mozilla.org/en-US/docs/Web/API/URL) object from a Node.js `IncomingMessage` or `Http2ServerRequest`, accounting for proxy headers.

## Features

- Works with HTTP/1.1, HTTPS, and HTTP/2
- Supports `Forwarded` (RFC 7239), `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-Port`
- Zero dependencies

## Install

```
npm i url-from-req
```

## Usage

```ts
import urlFromReq from "url-from-req";

const url = urlFromReq(req);
console.log(url.href); // "https://example.com/path?q=1"
```

## License

BSD-2-Clause
