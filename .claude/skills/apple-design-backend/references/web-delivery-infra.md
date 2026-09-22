# Apple Web Delivery Infrastructure — Observable Delivery Layer Reference

**Scope**: How Apple delivers apple.com, the App Store, and media assets to end users —
CDN topology, image-transform service, video delivery, HTTP protocol choices, caching strategy,
compression, and DNS. Companion to `inferred-backend-architecture.md`. Claims are labelled
`[observed]` / `[documented]` / `[inferred]` / `[speculative]`. Internal Apple architecture
(origin servers, ingestion pipelines) is deliberately out of scope.

---

## Principles

These "why" statements transfer to any modern edge-delivery system.

1. **Push work to the edge.** Cache at the CDN PoP closest to the user. Reserve origin
   round-trips for cache misses only. Apple's cache-hit ratio is estimated at 95%+ on
   primary asset types [inferred from Akamai industry norms; speculative for apple.com
   specifically].

2. **Immutable URLs + long TTLs.** Static assets whose content never changes get
   content-hashed filenames (e.g. `main.a3f9c2d.js`). With a hash in the filename the
   byte content is guaranteed immutable, so `Cache-Control: public, max-age=31536000,
   immutable` is safe. A deploy bumps the hash → old URL stays cached harmlessly, new
   URL is a cold miss → instant invalidation without explicit purges. [documented best
   practice; Apple's adherence is inferred from PageSpeed audit behavior]

3. **Transform images on demand at the CDN/edge.** Rather than pre-generating every
   size, the delivery layer (mzstatic) accepts dimension and quality parameters in the
   URL path segment and returns the appropriate derivative. The origin stores one
   high-resolution master; the edge encodes the requested derivative. [observed — see
   mzstatic URL patterns below]

4. **Adaptive video over HLS.** Video is segmented and encoded at multiple bitrates.
   The player picks the best rendition per segment based on measured bandwidth, so a
   slow connection degrades gracefully rather than stalling. Apple authored HLS and uses
   it internally. [documented]

5. **Multi-CDN for resilience and surge absorption.** No single CDN can absorb an
   iOS-release-day traffic spike. Apple routes through its own edge fleet + at least two
   commercial CDN partners simultaneously, using Akamai's infrastructure as the
   geo-routing brain. [observed via academic measurement, see §3]

6. **HTTP/2 multiplexing; HTTP/3/QUIC where supported.** Both eliminate head-of-line
   blocking that would serialize waterfall loads under HTTP/1.1. QUIC further reduces
   handshake RTT and handles lossy mobile connections better. [documented; Apple ships
   QUIC support in URLSession/Safari since iOS 15 / macOS Monterey]

---

## Apple Specifics (Observed)

### CDN Topology — the Meta-CDN

A 2018 Internet Measurement Conference paper (Blendin et al., arXiv:1810.02978) performed
passive DNS + active traffic measurement from 800+ RIPE Atlas probes during the iOS 11
rollout. Key findings:

**Three-tier CDN selection chain** [observed — DNS measurement]:
```
1. appldnld.apple.com           (entry; Akamai geo-detection)
   └─ CNAME: ios8-{eu|us|apac}-lb.apple.com.akadns.net
2. appldnld.g.applimg.com       (Apple's own Meta-CDN mapper; 15-second TTL)
   ├─ CNAME: {a|b}.gslb.applimg.com   → Apple-owned edge (IP range 17.253.0.0/16)
   ├─ CNAME: apple.vo.llnwi.net       → Limelight (US)
   └─ CNAME: apple-dnld.vo.llnwd.net  → Limelight (APAC)
3. Akamai edge resolves final CDN selection for India/China routing
```

**CDN traffic split during iOS 11 peak day** [observed]:
- Apple own edge: ~33%
- Limelight Networks: ~44%
- Akamai: ~23%
- Level3 (CenturyLink): present until June 2017, removed thereafter

**DNS TTL trick** [observed]: The Meta-CDN mapper uses a 15-second TTL on the CNAME
at `appldnld.g.applimg.com`. This lets Apple reroute traffic away from a saturated CDN
within seconds, without waiting for caches to expire. [observed via DNS measurement]

**www.apple.com DNS chain** [observed via community DNS inspection]:
```
www.apple.com → CNAME → www.apple.com.akadns.net → A records (Akamai edge IPs)
```
Akamai acts as the primary geo-DNS resolver for apple.com; Apple's own IP range (17.x.x.x)
handles CDN-offload and some direct delivery. [observed]

**IPv6**: The Meta-CDN mapping entry points did not support IPv6 at time of 2018 study.
[observed; current status unconfirmed — likely updated since]

---

### Image Delivery — mzstatic.com

`mzstatic.com` (owned by Apple) is the CDN host for App Store icons, marketing artwork,
music covers, app screenshots, and related media assets. It is NOT used for apple.com
marketing-page hero images (those ship from `www.apple.com` or Akamai-fronted origins directly).

**Subdomain pattern** [observed]:
```
is1-ssl.mzstatic.com
is2-ssl.mzstatic.com
is3-ssl.mzstatic.com
is4-ssl.mzstatic.com
a5.mzstatic.com       (original/source resolution — less common)
```
The `is[N]-ssl` subdomains are the thumbnail/transform layer. The number (`1`–`4` and
beyond) is a sharding index to spread DNS load across multiple server groups. [inferred
from parallel shard behavior; consistent with observed subdomain variety]

**URL structure — thumbnail transform** [observed from App Store API responses and
community teardowns]:
```
https://is[N]-ssl.mzstatic.com/image/thumb/{ColorBucket}/v{version}/{UUID-path}/{filename}/{WxH}{modifier}.{ext}
```

Real example (App Store icon):
```
https://is4.mzstatic.com/image/thumb/Purple122/v4/77/a0/bb/
  77a0bb06-41e5-3743-452f-0bcbb6a44591/source/60x60bb.jpg
```

Real example (music artwork to WebP at quality 60):
```
https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/bd/ed/cf/
  bdedcfcf-3b3d-35ae-f752-175e2d8034dc/194152826486.png/1200x630wp-60.jpg
```

**Dimension parameter** [observed]: `{W}x{H}` placed directly before the modifier suffix.
Replace with any integer pair; the edge re-encodes on demand. Maximum observed: 4000×4000
for artwork. Limit documented in some developer tooling as 10000×10000.

**Modifier codes** [observed, community-documented — Apple has no public spec]:

| Code | Meaning |
|------|---------|
| `bb` | Bounding-box fit (letterbox/pillarbox to fit dimensions) |
| `bf` | Best-fit (similar to bb, preserves aspect ratio) |
| `cc` | Center-crop to exact dimensions |
| `cw` | Crop with width priority |
| `wp` | Deliver as WebP (quality from `-NN` suffix) |
| `ss` | Return native/source resolution (ignore W×H numerics) |

**Quality suffix** [observed]: `-{NN}` appended before the extension controls JPEG/WebP
quality as a percentile. `-60` is the WebP default; `-80` is the JPEG default; `-999`
or `-100` is lossless/highest. Example: `1200x630wp-60.jpg` means 1200×630, WebP
quality 60, served with a `.jpg` extension for compatibility.

**Format selection** [observed]:
- Default extension is `.jpg` (JPEG, lossy).
- Append `wp` modifier → WebP encoding regardless of file extension shown.
- `.png` extension returns lossless PNG for artwork without a `wp` modifier.
- AVIF is NOT observed on mzstatic as of 2024–2025; WebP is the modern format offered.
- HEIC is Apple's container for device-captured photos but is NOT served over the web
  CDN (browser compatibility is too narrow). [inferred from absence of HEIC MIME types
  on public mzstatic responses]

---

### apple.com Marketing Pages — Image Delivery

Apple.com proper does not use mzstatic for marketing images. Hero images on product
pages (iPhone, Mac, etc.) ship from `www.apple.com` origin paths or Akamai-fronted
paths, typically as:

- High-resolution JPEG or PNG with 1x/2x variants via `srcset` [observed from
  page-source inspection by developers; no Apple-official spec]
- `<picture>` elements offering WebP with JPEG fallback on some pages [inferred from
  Apple's own WWDC23 "Explore media formats for the web" session recommending this
  pattern — Apple documents it as best practice, uses it internally]
- Filenames contain build hashes (e.g. `hero_iphone15_large_2x.jpg?version=abc123` or
  content-hashed paths) [inferred from cache-bust patterns observed in page audits]

Responsive image pattern commonly observed in apple.com HTML source [observed from
developer community inspections]:
```html
<picture>
  <source srcset="hero_2x.webp 2x, hero_1x.webp 1x" type="image/webp">
  <img
    src="hero_2x.jpg"
    srcset="hero_2x.jpg 2x, hero_1x.jpg 1x"
    alt="iPhone 15 Pro"
    loading="lazy"
    decoding="async"
    width="1200" height="630"
  >
</picture>
```
[Pattern reconstructed from WWDC guidance and community observations; exact markup
varies per page and release — treat as representative, not verbatim]

---

### Video Delivery

**Scroll-scrub / cinematic hero videos** [observed on apple.com product pages]:
- Delivered as pre-encoded MP4 (H.264 or HEVC) for scroll-synchronized sequences where
  the video frame is driven by the user's scroll position. HLS is not used here because
  ABR switching would break frame-accurate scrubbing. [inferred from scroll-scrub
  implementation requirements; confirmed by community devtools inspection]
- Typical pattern: multiple resolution MP4s loaded via `<video>` with `src` swap on
  viewport, or a single high-resolution MP4 with `preload="auto"` for above-the-fold
  cinematic loops.

**Streaming / long-form video (Apple TV+, trailers, developer sessions)** [documented]:
- HTTP Live Streaming (HLS) via `.m3u8` master playlist.
- Multiple renditions (bitrate ladder) per Apple's own HLS Authoring Specification.
  Minimum required renditions per current spec include ~145 kbps audio-only through
  4.5 Mbps for 1080p, up to 9.6 Mbps for 4K/HDR.
- Segment format: fMP4 (fragmented MP4) preferred since WWDC16; MPEG-TS is legacy.
- Segment duration: 6 seconds (Apple recommendation per HLS Authoring Spec).
- Codec: H.264 (required for base compatibility) + HEVC (H.265) for higher tiers,
  HDR10 / Dolby Vision where applicable.

**Sample HLS master playlist structure** [documented from Apple HLS spec]:
```
#EXTM3U
#EXT-X-VERSION:6
#EXT-X-STREAM-INF:BANDWIDTH=145000,CODECS="mp4a.40.2"
audio_only.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=416x234,CODECS="avc1.4d400d,mp4a.40.2"
360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=960x540,CODECS="avc1.4d401e,mp4a.40.2"
540p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p.m3u8
```

---

### HTTP Protocol

**HTTP/2** [inferred — universally deployed on Akamai-fronted origins; no contrary evidence]:
- Multiplexed streams over a single TLS connection.
- Header compression (HPACK).
- Server push (largely deprecated in practice post-2022 due to poor adoption).
- All modern Akamai PoPs support HTTP/2; apple.com serves HTTP/2 to all modern browsers.

**HTTP/3 / QUIC** [documented — Apple shipped QUIC in Safari/URLSession since iOS 15;
inferred for apple.com origin support]:
- Apple advertises HTTP/3 via `Alt-Svc: h3=":443"; ma=3600` header [documented as the
  standard advertisement mechanism; Apple's own infrastructure likely uses this given
  they authored the QUIC WWDC session and ship it in URLSession]
- QUIC uses TLS 1.3 mandatorily, eliminating a round-trip vs TLS 1.2 over TCP.
- Connection migration: QUIC CIDs allow seamless Wi-Fi → LTE transitions without
  re-handshaking — relevant for mobile Apple marketing pages.
- Safari performs HTTPS SVCB/ALPN DNS lookup and upgrades directly to HTTP/3 without
  Alt-Svc round-trip when the DNS record advertises `h3`. [documented WWDC21]

---

### TLS

- TLS 1.3 minimum for modern clients [documented — required by QUIC; standard Akamai
  edge behavior since 2020].
- TLS 1.2 maintained as fallback for older clients.
- Certificate: apple.com uses an organization-validated wildcard `*.apple.com`
  [observed by anyone visiting the site].

---

### Caching & Headers

**Immutable static assets** [inferred from Lighthouse audit behavior and industry-standard
CDN configs; apple.com conforms]:
```
Cache-Control: public, max-age=31536000, immutable
```
Applied to content-hashed JS/CSS/font files. Browsers never revalidate; a new deploy
emits new hashes → new URLs.

**Versioned images / media** [inferred]:
```
Cache-Control: public, max-age=86400
ETag: "abc123def456"
```
Shorter TTL + ETag for marketing assets that may change (product images, updated hero
shots). On revalidation, a `304 Not Modified` avoids re-downloading unchanged bytes.

**Dynamic / personalised responses**:
```
Cache-Control: no-store
```
Any authenticated or personalised response (account pages, App Store purchase state)
must not be cached at the CDN or browser.

**CDN Age header** [observed on Akamai-served responses generally]:
```
Age: 3821
```
Seconds the object has been cached at the edge. Allows debugging cache warm-up.

**X-Cache** [observed on Akamai]:
- `X-Cache: TCP_HIT` — served from edge cache (no origin fetch).
- `X-Cache: TCP_MISS` — cache miss; fetched from origin.
- Apple may suppress or rename these diagnostic headers on production; presence varies
  by path. [inferred]

---

### Compression

**Brotli** (`Content-Encoding: br`) [inferred — Akamai supports Brotli since 2018 and
enables it by default for text assets; apple.com HTML/CSS/JS almost certainly uses it]:
- Higher compression ratio than gzip (~15–25% better for text).
- Requires HTTPS (apple.com is HTTPS-only). [documented]
- Browser signals support via `Accept-Encoding: gzip, deflate, br`.
- CDN/edge handles compression transparently; origin may serve uncompressed to edge,
  edge compresses on first miss and caches the compressed form.

**Gzip** (`Content-Encoding: gzip`) [documented fallback]:
- Served to older clients that do not advertise `br` in `Accept-Encoding`.

**Pre-compressed assets**: Build pipelines typically emit `.br` and `.gz` sidecar files
alongside assets; the CDN serves the appropriate one. [inferred from standard practice;
Apple's build system behavior is private]

---

### DNS / Anycast

- Apple's authoritative nameservers: `a.ns.apple.com`, `b.ns.apple.com`, etc. [observed]
- Akamai acts as the geo-routing DNS resolver for www.apple.com and app-download paths,
  directing clients to the nearest CDN PoP via Anycast. [observed — CNAME to
  `www.apple.com.akadns.net`]
- Short TTLs (15–60s) on CDN-selection CNAMEs allow rapid failover or traffic rebalancing
  without relying on DNS TTL expiry. [observed from 2018 research]
- Apple IP range `17.0.0.0/8` is the registered Apple ASN block; own-CDN edge nodes
  answer from this space. [documented — ARIN]

---

## Recipes

### 1. Responsive Image with Transform-Service CDN (imgix / Cloudinary pattern)

Replicates the mzstatic transform-on-demand model with any image CDN.

```html
<picture>
  <!-- AVIF: best compression, check browser support first -->
  <source
    type="image/avif"
    srcset="
      https://cdn.example.com/hero.jpg?w=600&fm=avif&q=75   600w,
      https://cdn.example.com/hero.jpg?w=1200&fm=avif&q=75 1200w,
      https://cdn.example.com/hero.jpg?w=2400&fm=avif&q=75 2400w
    "
    sizes="(max-width: 600px) 100vw, (max-width: 1200px) 80vw, 1200px"
  >
  <!-- WebP: wide support, good compression -->
  <source
    type="image/webp"
    srcset="
      https://cdn.example.com/hero.jpg?w=600&fm=webp&q=80   600w,
      https://cdn.example.com/hero.jpg?w=1200&fm=webp&q=80 1200w,
      https://cdn.example.com/hero.jpg?w=2400&fm=webp&q=80 2400w
    "
    sizes="(max-width: 600px) 100vw, (max-width: 1200px) 80vw, 1200px"
  >
  <!-- JPEG fallback -->
  <img
    src="https://cdn.example.com/hero.jpg?w=1200&fm=jpg&q=85"
    srcset="
      https://cdn.example.com/hero.jpg?w=600&fm=jpg&q=85   600w,
      https://cdn.example.com/hero.jpg?w=1200&fm=jpg&q=85 1200w,
      https://cdn.example.com/hero.jpg?w=2400&fm=jpg&q=85 2400w
    "
    sizes="(max-width: 600px) 100vw, (max-width: 1200px) 80vw, 1200px"
    alt="Product hero"
    width="1200" height="630"
    loading="eager"
    decoding="async"
    fetchpriority="high"
  >
</picture>
```

**mzstatic equivalent** for App Store art at 300×300 WebP quality 80:
```
https://is1-ssl.mzstatic.com/image/thumb/Purple122/v4/{UUID-path}/{file}/300x300wp-80.jpg
```

---

### 2. Immutable Cache-Control Headers (Nginx)

```nginx
# Content-hashed assets — cache forever, never revalidate
location ~* \.(js|css|woff2|woff|ttf)$ {
    # Assumes filename contains a content hash, e.g. main.a3f9c2d.js
    add_header Cache-Control "public, max-age=31536000, immutable";
    add_header Vary "Accept-Encoding";
    gzip_static on;   # serve pre-compressed .gz if present
    brotli_static on; # serve pre-compressed .br if present (ngx_brotli module)
}

# Versioned images — shorter TTL + ETag revalidation
location ~* \.(jpg|jpeg|png|webp|avif|gif|svg)$ {
    add_header Cache-Control "public, max-age=86400, stale-while-revalidate=3600";
    add_header Vary "Accept-Encoding, Accept";
    etag on;
}

# HTML — always revalidate; never immutable
location ~* \.html$ {
    add_header Cache-Control "no-cache";
    etag on;
}
```

---

### 3. HLS Video Setup (HTML + FFmpeg)

**Encode a bitrate ladder with FFmpeg:**
```bash
# Encode three renditions from a source file
ffmpeg -i source.mp4 \
  -vf scale=416:234  -b:v 400k  -c:v libx264 -profile:v baseline -level 3.0 \
    -c:a aac -b:a 64k -hls_time 6 -hls_list_size 0 -f hls 360p/index.m3u8 \
  -vf scale=960:540  -b:v 1500k -c:v libx264 -profile:v main    -level 3.1 \
    -c:a aac -b:a 96k -hls_time 6 -hls_list_size 0 -f hls 540p/index.m3u8 \
  -vf scale=1920:1080 -b:v 4500k -c:v libx264 -profile:v high   -level 4.2 \
    -c:a aac -b:a 128k -hls_time 6 -hls_list_size 0 -f hls 1080p/index.m3u8
```

**Master playlist (`master.m3u8`):**
```m3u8
#EXTM3U
#EXT-X-VERSION:6
#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=416x234,CODECS="avc1.4d400d,mp4a.40.2"
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=960x540,CODECS="avc1.4d401e,mp4a.40.2"
540p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p/index.m3u8
```

**HTML player:**
```html
<video
  controls
  playsinline
  preload="metadata"
  poster="https://cdn.example.com/poster.jpg?w=1920&fm=jpg&q=85"
>
  <source src="https://cdn.example.com/video/master.m3u8" type="application/x-mpegURL">
  <!-- MP4 fallback for non-HLS browsers -->
  <source src="https://cdn.example.com/video/1080p.mp4" type="video/mp4">
</video>
```

**Scroll-scrub cinematic (no HLS — frame accuracy required):**
```html
<!-- Preload the whole short clip; JS drives currentTime from scroll position -->
<video
  id="hero-scrub"
  muted
  playsinline
  preload="auto"
  aria-hidden="true"
>
  <source src="hero_2x.mp4" type="video/mp4" media="(min-width: 769px)">
  <source src="hero_1x.mp4" type="video/mp4">
</video>
<script>
window.addEventListener('scroll', () => {
  const pct = window.scrollY / (document.body.scrollHeight - window.innerHeight);
  const vid = document.getElementById('hero-scrub');
  vid.currentTime = pct * vid.duration;
});
</script>
```

---

### 4. Brotli + HTTP/3 Server Config Sketch (Nginx + ngx_brotli + OpenSSL QUIC)

```nginx
server {
    listen 443 ssl;
    listen 443 quic reuseport;  # HTTP/3 over QUIC
    http2 on;

    ssl_certificate     /etc/ssl/certs/fullchain.pem;
    ssl_certificate_key /etc/ssl/private/key.pem;
    ssl_protocols       TLSv1.3 TLSv1.2;
    ssl_prefer_server_ciphers off;

    # Advertise HTTP/3 support to client
    add_header Alt-Svc 'h3=":443"; ma=3600';
    add_header QUIC-Status $quic;  # optional debugging

    # Brotli (requires ngx_brotli module)
    brotli on;
    brotli_comp_level 6;
    brotli_types text/html text/css application/javascript
                 application/json font/woff2 image/svg+xml;

    # Gzip fallback for clients without brotli
    gzip on;
    gzip_vary on;
    gzip_types text/html text/css application/javascript
               application/json image/svg+xml;

    # Security headers Apple uses
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload";
    add_header X-Content-Type-Options "nosniff";
}
```

---

## Faithful Replication

How to achieve Apple-grade delivery with widely available commercial tools:

| Layer | Apple's approach | Replication tool |
|-------|-----------------|-----------------|
| CDN / edge | Own fleet + Akamai + Limelight (multi-CDN) | Cloudflare or Fastly (single CDN covers 95% of use cases); add BunnyCDN as a second CDN for true multi-CDN |
| Image transform | mzstatic edge transform (W×H + modifier + quality in URL path) | imgix, Cloudinary, or Cloudflare Images — same URL-parameter model |
| Image formats | JPEG primary, WebP via `wp` modifier; no AVIF on mzstatic | imgix `auto=format` auto-negotiates AVIF/WebP/JPEG by Accept header |
| Responsive images | `srcset` 1x/2x + `<picture>` with WebP source | Standard HTML `<picture>` + `srcset` — no framework needed |
| Video streaming | HLS `.m3u8` + multiple bitrate renditions via Akamai CDN | FFmpeg encode → S3 or R2 storage → Cloudflare CDN; or managed: Mux.com, Cloudflare Stream |
| Scroll-scrub video | Pre-encoded MP4 per viewport width, JS-driven `currentTime` | Same — MP4 on CDN, vanilla JS scroll listener |
| Immutable asset cache | `max-age=31536000, immutable` on content-hashed filenames | Any CDN + Vite/webpack content-hash build output |
| Compression | Brotli primary, gzip fallback | Cloudflare enables Brotli by default; Nginx + ngx_brotli for self-hosted |
| HTTP version | HTTP/2 everywhere; HTTP/3/QUIC where supported | Cloudflare: HTTP/3 on by default since 2019; nginx: needs QUIC build |
| DNS routing | Akamai geo-DNS + short TTL Meta-CDN mapper | Cloudflare DNS + Cloudflare Load Balancing rules; 60s TTL |
| TLS | TLS 1.3 primary | Any modern CDN enforces TLS 1.3 by default |

---

## Anti-Patterns

Patterns that violate Apple-grade delivery discipline — avoid these:

1. **Serving unresized originals.** Uploading a 5 MB 4000×3000 JPEG and sending it to
   mobile viewports that only need 400×300. A transform service adds minutes of
   setup; unoptimised images cost every user on every visit.

2. **No edge cache — origin-only delivery.** Every request hits the application server.
   A single product-launch traffic spike can take down an origin that would be
   trivially absorbed by a CDN with 95% cache-hit ratio.

3. **Mutable URLs with long Cache-Control.** Deploying a new `hero.jpg` over the same
   URL with `max-age=86400` means users see the old image for up to 24 hours, or you
   must do a manual CDN purge (error-prone, not atomic). Use content-hashed filenames
   instead.

4. **Single-bitrate video.** Serving only a 1080p MP4 to all connections. Users on
   slow mobile connections buffer indefinitely; users on fast connections get no
   quality benefit. Use HLS or DASH with a bitrate ladder.

5. **No Brotli.** Shipping gzip-only HTML/JS/CSS leaves 15–25% compression on the
   table for every text response. Brotli is supported by all modern browsers (>96%
   global coverage as of 2024) and every major CDN.

6. **Format-blind image delivery.** Serving JPEG to browsers that sent `Accept:
   image/avif,image/webp,*/*`. AVIF is 50% smaller than JPEG at equivalent quality;
   WebP is ~30% smaller. Ignoring the Accept header wastes bandwidth for the majority
   of users.

7. **`preload="auto"` on below-the-fold videos.** Forces the browser to download the
   entire video before it's needed, competing with LCP resources. Use
   `preload="metadata"` or `preload="none"` + IntersectionObserver-triggered load.

8. **Missing `width`/`height` on images.** Causes Cumulative Layout Shift (CLS) as
   images load and reflow the page. Apple's marketing pages always specify explicit
   dimensions. [inferred from their historically strong Core Web Vitals scores]

9. **Single-CDN for global launch-day traffic.** A major product launch can exceed any
   single CDN's regional capacity. Apple's observed 438% Limelight spike during iOS 11
   with Akamai overflow demonstrates the need for multi-CDN.

---

## Sources

- Blendin, J. et al. (2018). "Dissecting Apple's Meta-CDN during an iOS Update."
  IMC 2018. [arXiv:1810.02978](https://arxiv.org/abs/1810.02978) |
  [ar5iv readable version](https://ar5iv.labs.arxiv.org/html/1810.02978)
  — Primary source for CDN topology, DNS chains, traffic split percentages.

- [mzstatic image URL teardown — community analysis](https://mzstatic.pages.dev/)
  — URL modifier codes, quality suffix, subdomain sharding.

- [iTunes Open Graph image URL gist — karlding](https://gist.github.com/karlding/954388cb6cd2665d4f3a)
  — Observed mzstatic URL parameter structure with real examples.

- [Apple Developer — Accelerate networking with HTTP/3 and QUIC (WWDC21)](https://developer.apple.com/videos/play/wwdc2021/10094/)
  — Alt-Svc header format, QUIC/TLS 1.3 relationship, URLSession HTTP/3 support.

- [Apple Developer — HLS Authoring Specification for Apple Devices](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices)
  — Bitrate ladder, segment duration, codec requirements.

- [Apple Developer — Explore media formats for the web (WWDC23)](https://developer.apple.com/videos/play/wwdc2023/10122/)
  — Apple's own web delivery format guidance (WebP, AVIF, responsive images).

- [Apple Support — Use Apple products on enterprise networks](https://support.apple.com/en-us/101555)
  — Confirms Akamai/akadns.net as Apple CDN routing layer.

- [OpenDNS — configuration.apple.com.akadns.net](https://domain.opendns.com/configuration.apple.com.akadns.net)
  — Observable DNS CNAME chain evidence.

- [Apple CDN Infrastructure — BlazingCDN analysis](https://blog.blazingcdn.com/en-us/apple-cdn-infrastructure-icloud-apple-tv-scale-globally)
  — Secondary/aggregate source; treat claims as inferred.

- [Akamai — Pragma headers / X-Cache behavior](https://techdocs.akamai.com/edge-diagnostics/docs/pragma-headers)
  — Akamai CDN header reference for X-Cache values.

- [MDN — Cache-Control header reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control)
  — Canonical documentation for `immutable`, `max-age`, `no-cache`, `no-store`.

- [Can I Use — Brotli](https://caniuse.com/brotli)
  — Browser support matrix for `content-encoding: br`.

---

CONFIDENCE: 72% — Observable CDN topology (Meta-CDN paper) and mzstatic URL transforms are well-evidenced; HTTP/3 and Brotli adoption on apple.com specifically are inferred from Apple's own tooling/documentation rather than direct header inspection of apple.com responses.
