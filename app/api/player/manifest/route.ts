import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, requireScreen } from '@/lib/server/http';
import { versionAndFormatManifest } from '@/lib/server/manifest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function matchesEtag(header: string | null, etag: string) {
  if (!header) return false;
  return header.split(',').some(value => value.trim() === etag || value.trim() === `W/${etag}` || value.trim() === '*');
}

export async function GET(request: NextRequest) {
  try {
    const { db, screen } = await requireScreen(request);
    const { manifest, etag } = await versionAndFormatManifest(db, screen);
    const headers = { ETag: etag, 'Cache-Control': 'no-store', 'X-Manifest-Version': String(manifest.manifestVersion) };
    if (matchesEtag(request.headers.get('if-none-match'), etag)) return new NextResponse(null, { status: 304, headers });
    return NextResponse.json(manifest, { headers });
  } catch (error) { return errorResponse(error); }
}
