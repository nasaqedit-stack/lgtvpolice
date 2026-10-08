# Test record

## Executed in this checkout

Environment: Node.js 22.22.3, npm, fake IndexedDB. No Supabase project credentials, configured deployed origin, or LG TV were available for this checkout.

- `npm run lint` — passed with no warnings.
- `npm run typecheck` — passed.
- `npm test` — 13 files, 160 tests passed.
  - Persistent IndexedDB credential/media/audio metadata and Blob reconstruction.
  - Atomic manifest activation rejects incomplete assets and old manifest remains active.
  - Mocked player sync downloads an image/video pair once; an image-only manifest update requests only the new image; old video remains locally cached.
  - Standalone video reuse, unchanged-source repeat without another `load()`, unmuted playback, and audio-unlock preference persistence.
  - Playback UI stays hidden over active media; viewport cover CSS and ES5 standalone syntax are checked.
  - QuickTime MOV parser requires H.264/AVC video and AAC-LC audio (when present); the upload API re-checks stored `moov` metadata and rejects unsupported codecs even when a client claims compatibility.
  - Mocked total network loss rejects sync without changing the active manifest; locally stored content remains readable.
  - Mocked corrupted download fails SHA-256 and does not replace the previous manifest.
  - Local time schedule selection and cross-midnight/week-day rollover.
  - Manifest routing: a screen with no assignment and no schedule follows the most recently published playlist; an explicit assignment wins over a newer one; an unpublished draft is never routed; an enabled schedule keeps its own playlist.
  - A 206 response whose body is longer than the requested window is trimmed to the window; a TV that cannot use the signed storage URL completes the download through the same-origin `/api/player/media/<mediaId>` stream.
- `npm run build` — passed; `/player` is generated as a static route and API routes are server-rendered.
- No `npm audit`, production deployment, Supabase migration, live media E2E, or physical-TV test has been run for this change.

## Multipart part-size defect (2026-10-08)

Production finalization failed for every upload with `409 upload_part_size_invalid`
(«حجم أحد أجزاء الرفع غير صحيح»).

Root cause — not the client slicing:

- `POST /api/admin/media/uploads/[uploadId]/complete` compared `ListParts().Parts[i].Size`
  with `Math.min(partSize, fileSize - i * partSize)`.
- Supabase Storage's S3 protocol handler (`supabase/storage` →
  `src/storage/protocols/s3/s3-handler.ts#listParts`) serialises only `PartNumber`,
  `LastModified` and `ETag` per part; it never emits `<Size>`. Its `uploadPart` also never
  writes `s3_multipart_uploads_parts.size`, so that column keeps its `DEFAULT 0`.
- Through the AWS SDK the field therefore arrives as `Size === undefined`, so
  `Number(undefined)` is `NaN` and `NaN !== expected` is always true: the check failed on
  part number 1 for every file size, including a 2 KiB image (expected 2048, "actual" NaN).
- The browser side was already correct: `Blob.slice(start, end)` with an exclusive `end` and
  `Math.min(start + PART_SIZE, file.size)` produced exactly the right bytes for the last,
  short part.

Fix (validation kept, not removed):

- `lib/shared.ts` now owns the only copy of the partition maths (`UPLOAD_PART_SIZE`,
  `uploadPartCount`, `uploadPartRange`, `uploadPartSize`); the page, the client uploader and
  all four upload API routes import it, so the two sides cannot diverge.
- `lib/client/media-upload.ts` (extracted from the media page) slices through that helper,
  verifies the Blob length it got back, and reports the length read off the Blob it actually
  PUT. The page sends that manifest as `parts` on finalization. Bytes still go straight to the
  signed Storage URL as a Blob PUT — no FormData, nothing routed through Vercel.
- `verifyUploadParts()` in `lib/server/uploads.ts` requires parts 1..N with an ETag, validates
  any byte length a store *does* report, validates the declared manifest part by part and its
  sum against the file size, and the route then re-measures the assembled object with
  `HeadObject.ContentLength`, which is the store's own count of the bytes that landed.
  A missing manifest (an admin tab left open across the deploy) falls back to those layers
  instead of failing.
- `GET …/status` no longer reports `0` for every landed part (Supabase gives no length), so a
  resumed upload shows real progress.

Coverage — `tests/media-upload-parts.test.ts` (30 tests):

- The partition for files smaller than one chunk, one byte under, exactly one chunk, one byte
  over, exactly two chunks, a short final chunk, a three-chunk MP4 and the 2 GiB cap:
  contiguous, exclusive-end, no gaps or overlaps, sizes summing to the file size.
- The regression itself: the pre-fix comparison is replayed against a real Supabase-shaped
  `ListParts` payload and asserted to fail part 1 with expected 2048 / actual NaN, while
  `verifyUploadParts` accepts the same payload.
- Validation still bites: a part one byte short, a short final part declared as a full chunk,
  a missing/duplicated/out-of-range part number, a manifest that does not sum to the file
  size, a store that reports a wrong size, and a part that never landed.
- `uploadParts()` driven by real `File`/`Blob` objects with a stubbed `fetch`: the bodies
  Storage received, reassembled in part order, are byte-for-byte the original image and MP4;
  a retried part re-derives its offsets instead of reusing a stale range.

Integration coverage — `tests/media-upload-finalize.test.ts` (11 tests): the real browser uploader,
the real Next.js route handlers and the real AWS SDK v3 commands are wired to a fake object store
that answers exactly like Supabase Storage's S3 protocol (its `ListParts` reply carries
`PartNumber`/`LastModified`/`ETag` and **no** `<Size>` element). Restoring the pre-fix comparison
in this harness reproduces the production failure verbatim — `409 upload_part_size_invalid`,
«حجم أحد أجزاء الرفع غير صحيح», part number 1, expected 2048 for a small PNG and 8388608 for a
multi-part file — while the fixed path and the new MOV validation cases all pass:

- a 2 KiB image (single part) finalizes, returns a media id, and the assembled bytes equal the file;
- a 20 MB MP4 (three parts, short final part) finalizes and stores the exact bytes;
- a file of `UPLOAD_PART_SIZE + 1` bytes finalizes with a 1-byte final part;
- a resumed session reports real per-part progress instead of zeros;
- a declared size one byte short is still rejected (`upload_part_size_invalid`, naming part 3);
- finalizing while a part never landed is still rejected (`upload_incomplete`);
- a client that sends no manifest still finalizes (backward compatible across the deploy);
- parts that are the right declared size but the wrong bytes are caught by `HeadObject`
  (`stored_file_mismatch`), i.e. the store's own measurement of what landed;
- structurally valid H.264/AAC-LC QuickTime MOV is stored with the original `video/quicktime` MIME;
- missing client preflight and a forged `candidate` claim for HEVC are rejected, and the server removes the unsupported object before library insertion.

`scripts/prod-media-e2e.mjs` now uploads through a shared driver that walks every part and
declares the real byte length of each one, and adds a two-part upload whose final part is a
single byte (`UPLOAD_PART_SIZE + 1` bytes, skipped with `E2E_MULTIPART=0`). The workflow runs
that media stage even when the pairing stage fails, so the media evidence is no longer hidden
behind an unrelated failure.

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

## Prior production run (2026-10-08 baseline)

The production evidence below is for previously merged commit `6b0d7c5`, not this working change.
The Vercel Production deployment of that baseline reported `Deployment has completed` (state
`success`). The `Production pairing E2E` workflow then ran against that deployment. Its media stage
was no longer skipped when the pairing stage failed, and it confirmed from a GitHub runner:

- `https://lgtvpolice.vercel.app/login` and `/player` answer HTTP 200 (the deployment is live);
- the storage endpoint serves the S3 protocol (`403 AccessDenied` with an S3 XML body for an
  unsigned object read);
- CORS preflight from the app origin allows `PUT` (`access-control-allow-origin: *`), so a browser
  Blob PUT of each part is permitted.

The authenticated checks (A–G), which include the real image upload, still report `SKIP`:
`resolved: url=yes anon=no serviceKey=no adminCreds=no`. Neither `ADMIN_EMAIL`/`ADMIN_PASSWORD`
nor `SUPABASE_SERVICE_ROLE_KEY` exists as a repository or "Production" environment secret, so no CI
run can log in as an admin. A real production upload therefore still has to be performed either by
an administrator in the browser at `/media`, or by a workflow run after those secrets are added.

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

## Playback-first offline runtime (2026-10-08, player `2.2.0-1`)

Root causes fixed in this change (all verified against the shipped files):

- Startup blocked the first frame on `getStats`, `countCachedAssets`, `getSeenReloadVersion`
  and `getAudioEnabled` before `attachEngine()` could render from the local manifest.
- `paint()` kept the opaque `.sp-overlay` (and the pairing form) over media that was already
  playing, including after a 401 that cleared the credential.
- `applyManifest()` called `engine.render()` after every synchronization, which re-created the
  blob object URL and re-assigned `video.src`, so a 60-second sync restarted the current video.
- `deleteUnreferenced()` protected only the previous manifest, so activating a new playlist while
  the old one was still on screen could delete the media being played.
- The stall watchdog advanced immediately with no recovery attempt, and a media failure removed
  the visible element before the replacement was ready (black screen for a missing asset).

Rules now enforced (PLAYBACK > CACHE > SYNC): local manifest -> cached media -> playback ->
background synchronization; atomic activation only after every asset is downloaded, size-checked
and hash-verified; missing next item keeps the current media and retries with bounded backoff;
Garbage collection always receives the hashes the engine is displaying (`protectHashes`);
stall recovery reinitializes the media element and re-reads the local copy before skipping;
the page-level watchdog may reload at most once per ten minutes and only when locally cached
media had been on screen; `meta.playbackState` resumes the same item after a reload.

Executed in this checkout:

- `npm test` — 14 files, 177 tests passed (includes `tests/player-offline-first.test.ts`, 17 new
  acceptance tests, and the three `the deployed /player document` checks that run once `.next`
  exists).
- `npm run lint` — passed with no warnings.
- `npm run typecheck` — passed.
- `npm run build` — passed; `/player` is still served as a static document
  (`public/player/*.js?v=2.2.0-1`), ES5-parsed at `ecmaVersion: 5` by the syntax suite.
- Production-parity acceptance run (local, sandbox): `npm run build && npm start`, then the
  served `/player` document plus the three served scripts were loaded into the webOS-3.5-like
  jsdom window with a pre-seeded IndexedDB cache while the live API calls failed
  (no Supabase credentials in this environment). Result: a cached `blob:` element was displayed,
  `.sp-overlay` stayed `display: none`, and the failure was recorded as a diagnostic only
  (`screen_unauthorized`) instead of stopping or blanking playback.
- Not run here: production deployment, `npm audit`, Supabase migration, live media E2E, and the
  physical LG UJ634V. `https://lgtvpolice.vercel.app` is unreachable from this sandbox and the
  change is not merged into `main`, so the deployed origin still serves `2.1.0-1`.

Manual acceptance on the television (after the change is merged and deployed):

1. Open `/player` on the TV, let it pair and finish a sync (the diagnostics screen lists the
   cached media count and the last sync time).
2. Unplug the Wi-Fi/Ethernet and power-cycle the TV.
3. Confirm cached content starts immediately and keeps cycling; the status line (hidden while
   media is on screen) shows «تشغيل محلي دون اتصال» when opened.
4. Reconnect the network: the next background sync resumes within a minute and the picture is
   never interrupted.
5. Publish a new playlist from the admin app: it is downloaded in the background and only becomes
   active once every asset is cached and verified; the current item keeps playing until its own
   transition.
