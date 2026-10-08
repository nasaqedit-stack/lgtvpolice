import { renderPlayerShell } from '@/lib/player/standalone/shell';

/*
 * /player — the TV signage player.
 *
 * This route returns a single static HTML document and nothing else: no React, no Next.js client
 * runtime, no module script. The heavy modern client bundle that the App Router emits would abort
 * with a SyntaxError on webOS 3.5 (Chromium 38) before React could mount, which is exactly the
 * failure the previous implementation had on the LG UJ634V.
 *
 * `force-static` keeps the response identical for every request and prerendered at build time, so
 * the TV receives one small document from the CDN. `/player/preview` still renders the React
 * implementation for desktop previews.
 */
export const dynamic = 'force-static';

export function GET() {
  return new Response(renderPlayerShell(), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate',
    },
  });
}
