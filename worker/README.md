# Shared artwork service

This Cloudflare Worker lets installed yanpresence clients use the owner's existing `yanpresence` R2 bucket without receiving an R2 access key. Discord application IDs are public identifiers; R2 credentials are not and must never ship with an installer.

The deployed endpoint is [yanpresence-artwork.ethanxucoder.workers.dev](https://yanpresence-artwork.ethanxucoder.workers.dev/health). Desktop defaults are in `src/shared-defaults.js`.

## API

- `POST /v1/artwork`: raw PNG, JPEG, GIF, WebP, or AVIF bytes; matching `Content-Type` and `Content-Length` headers required; maximum 25 MiB. Returns `200 {"url":"https://…/shared/v1/<sha256>.<extension>"}`. No authorization token is required.
- `GET /health`: returns `200 {"ok":true,"service":"yanpresence-artwork","maxUploadBytes":26214400}` when bindings are configured and uploads are enabled. This is a configuration/liveness check, not a bucket connectivity probe.
- Errors contain `{ "error": "…" }`. `429` includes `Retry-After: 60`; clients should back off and retain/fall back to other artwork. `503` means paused or unavailable.

The service derives every key from the bytes, validates raster container signatures, limits actual streamed bytes, deduplicates identical uploads, and uses conditional writes so concurrent uploads cannot replace objects. It never accepts object keys, fetches a submitted remote URL, exposes bucket listings, or deletes objects. Existing owner objects are outside the `shared/v1/` prefix. Responses omit storage errors and credentials. Requests from browser origins are rejected; the desktop Node client uses no Origin header.

## Owner deployment

Only the service owner does this. Installer users do not need Cloudflare accounts, Node, Wrangler, storage keys, or Discord applications.

1. Authenticate Wrangler to the Cloudflare account that owns the bucket: `npx wrangler@4.136.1 login --scopes account:read user:read workers_scripts:write`.
2. Check `worker/wrangler.jsonc`: bucket `yanpresence`, public R2 URL, and rate-limit namespace IDs `81001` / `81002` must belong to this service and be unused by unrelated limiters on that account. Existing R2 public access must be enabled.
3. From the repository root, validate with `npx wrangler@4.136.1 deploy --config worker/wrangler.jsonc --dry-run`, then deploy with `npx wrangler@4.136.1 deploy --config worker/wrangler.jsonc`.
4. Use the resulting HTTPS Workers URL as the desktop shared hosting endpoint. Check `/health`, upload a small real image, and fetch the returned public URL before releasing the installer.

The Worker needs the `ARTWORK_BUCKET` R2 binding and both rate-limit bindings. It has no secrets. Do not copy a personal config file into a release. For local work, `npx wrangler dev --config worker/wrangler.jsonc` uses local simulated bindings; send a test `CF-Connecting-IP` header if your local runtime does not supply one. Public URLs from the local emulator will not contain locally stored objects.

## Abuse and operations

Default limits are 30 upload attempts per client IP per minute and 180 total attempts per minute **per Cloudflare location**. Concurrent body buffering is capped at 25 MiB per Worker isolate to protect its shared memory. Cloudflare rate-limit bindings are approximate, location-local protection, not a hard global storage or billing budget. Shared network users share the IP allowance. The endpoint is public: a determined client can submit any matching raster container; signature checks do not establish that an image came from Apple Music. Browser rejection is an additional guard, not authentication.

Keep Cloudflare usage alerts enabled and monitor Workers/R2 usage. Set `UPLOADS_ENABLED` to `"false"` and redeploy to pause anonymous uploads immediately. For larger public distribution, use a dedicated bucket/quota service if a hard spend limit is required. If adding an R2 expiry rule, scope it strictly to `shared/v1/`; never apply it to the owner's existing objects, and account for clients caching returned URLs.

Cloudflare references: [R2 bindings and conditional writes](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [rate-limit bindings and their guarantees](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
