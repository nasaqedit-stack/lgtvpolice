import Player from '@/components/player';

/*
 * Desktop preview of the previous React player.
 *
 * The TV-facing player is the standalone ES5 runtime served by /player (see app/player/route.ts).
 * That runtime is what LG webOS 3.5 (Chromium 38) can actually execute; this React implementation
 * is kept only so the same flow can be inspected in a modern desktop browser.
 */
export const dynamic = 'force-static';
export const metadata = { title: 'معاينة المشغل (سطح المكتب)' };

export default function PlayerPreviewPage() {
  return <Player />;
}
