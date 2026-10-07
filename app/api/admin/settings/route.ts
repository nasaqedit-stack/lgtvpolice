import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, requireAdmin } from '@/lib/server/http';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
    return NextResponse.json({
      provider: 'Supabase + Vercel-ready Next.js',
      objectStorageConfigured: Boolean(process.env.SUPABASE_S3_ENDPOINT && process.env.SUPABASE_S3_ACCESS_KEY_ID && process.env.SUPABASE_S3_SECRET_ACCESS_KEY),
      bucket: process.env.SIGNAGE_STORAGE_BUCKET || 'signage-media',
      maxMediaBytes: 2 * 1024 * 1024 * 1024,
      timezone: 'Asia/Riyadh',
      playerStorage: 'IndexedDB chunk store + Service Worker app shell',
      deployment: process.env.VERCEL ? 'Vercel' : 'Self-hosted / local',
    });
  } catch (error) { return errorResponse(error); }
}
