# Test record

## Executed in this checkout

Environment: Node.js 22.22.3, npm, fake IndexedDB. No Supabase project, object-storage credentials, deployed origin, or LG TV were available.

- `npm run lint` — passed.
- `npm run typecheck` — passed.
- `npm test` — 19 tests passed.
  - Persistent IndexedDB credential/media metadata and Blob reconstruction.
  - Atomic manifest activation rejects incomplete assets and old manifest remains active.
  - Mocked player sync downloads an image/video pair once; an image-only manifest update requests only the new image; old video remains locally cached.
  - Mocked total network loss rejects sync without changing the active manifest; locally stored content remains readable.
  - Mocked corrupted download fails SHA-256 and does not replace the previous manifest.
  - Local time schedule selection and cross-midnight/week-day rollover.
  - Manifest routing: a screen with no assignment and no schedule follows the most recently published playlist; an explicit assignment wins over a newer one; an unpublished draft is never routed; an enabled schedule keeps its own playlist.
  - A 206 response whose body is longer than the requested window is trimmed to the window; a TV that cannot use the signed storage URL completes the download through the same-origin `/api/player/media/<mediaId>` stream.
- `npm audit` — 0 vulnerabilities reported at test time.
- `npm run build` — passed; `/player` is generated as a static route and API routes are server-rendered.
- Local HTTP smoke check — `/player`, `/sw.js`, and `/login` returned HTTP 200. This did not exercise a configured login or storage API.

## Production probe (2026-10-07, credential-free)

Run on the deployed production origin by the `Production media probe` workflow:

- The project serves the object-storage S3 protocol: an unsigned `GET /storage/v1/s3/signage-media/media/<key>`
  answers `403 AccessDenied` with an S3 XML error body (not a gateway/feature error), so uploads and
  downloads are not blocked by a disabled S3 endpoint.
- CORS preflight for `GET` and `PUT` from the production origin returns
  `access-control-allow-origin: *`, so browser multipart upload and cross-origin range download are
  permitted by the storage endpoint.
- No GitHub Actions secrets are configured (`url=yes anon=no serviceKey=no adminCreds=no`), so the
  authenticated A–I checks below report SKIP. The production Supabase URL is discoverable from the
  public bundle; the anon/service keys are not.

## Production harness (needs credentials)

`node scripts/presign-inspect.mjs` prints the presigned query parameters the server would send for a GetObject/UploadPart (no network, offline presigning only) so a change in AWS SDK defaults is visible in review.

`scripts/prod-media-e2e.mjs --self-test` validates the generated PNG fixture offline (no network). The
full production run (`node scripts/prod-media-e2e.mjs` with app+admin credentials, or the
`Production pairing E2E` workflow with `mode=media`) executes A–I: admin upload through the real API,
object presence in the private `signage-media` bucket, playlist creation and publish, pairing, manifest
delivery, signed URL issuance, and a 4 MiB Range download verified against SHA-256. Without
`ADMIN_EMAIL`/`ADMIN_PASSWORD` or `SUPABASE_SERVICE_ROLE_KEY` it reports SKIP with the missing
capability instead of failing.

## Not executed; required before production acceptance

| Scenario | Status | Reason / required verification |
|---|---|---|
| Create admin user, screen, and consume pairing code against Supabase | Not run | Requires configured Auth/PostgreSQL project |
| Upload image/MP4 through Supabase S3 multipart and resume after browser restart | Not run | Requires Storage S3 credentials and deployment-origin CORS |
| Download via signed `Range` URL on a physical TV | Not run | Requires real storage project and target webOS model |
| Play H.264/AAC MP4 from IndexedDB `Blob` while internet is physically disconnected | Not run | No LG TV was available; unit tests do not decode video |
| Offline app-shell navigation after a TV/browser restart | Not run | Requires a real persistent TV browser and successful Service Worker installation |
| Browser storage quota/persistence/eviction on LG | Not run | Device-specific; `navigator.storage.persist()` is best-effort |
| Supabase migration, PostgREST RPC grants, RLS and Vercel cron | Not run | No Supabase database or Vercel project credentials were configured |

The automated network tests use mocked HTTP and are not represented as physical network-loss or TV playback tests. Production acceptance requires the device checklist in `TV-SETUP.md` with a complete image → MP4 → image playlist and network physically disconnected.
