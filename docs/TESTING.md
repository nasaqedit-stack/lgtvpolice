# Test record

## Executed in this checkout

Environment: Node.js 22.22.3, npm, fake IndexedDB. No Supabase project, object-storage credentials, deployed origin, or LG TV were available.

- `npm run lint` — passed.
- `npm run typecheck` — passed.
- `npm test` — 7 tests passed.
  - Persistent IndexedDB credential/media metadata and Blob reconstruction.
  - Atomic manifest activation rejects incomplete assets and old manifest remains active.
  - Mocked player sync downloads an image/video pair once; an image-only manifest update requests only the new image; old video remains locally cached.
  - Mocked total network loss rejects sync without changing the active manifest; locally stored content remains readable.
  - Mocked corrupted download fails SHA-256 and does not replace the previous manifest.
  - Local time schedule selection and cross-midnight/week-day rollover.
- `npm audit` — 0 vulnerabilities reported at test time.
- `npm run build` — passed; `/player` is generated as a static route and API routes are server-rendered.
- Local HTTP smoke check — `/player`, `/sw.js`, and `/login` returned HTTP 200. This did not exercise a configured login or storage API.

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
