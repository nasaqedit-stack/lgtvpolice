import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, HttpError, readJson, requireAdmin } from '@/lib/server/http';

export const runtime = 'nodejs';
export const maxDuration = 60;

const schema = z.object({
  name: z.string().trim().min(1).max(120),
  expiresAt: z.string().datetime().nullable().optional(),
  maxSubmissions: z.number().int().positive().max(10000).nullable().optional(),
}).strict();

export async function GET(request: NextRequest) {
  try {
    const { db } = await requireAdmin(request);
    const { data, error } = await db.from('submission_tokens').select(`
      *,
      creator:profiles!submission_tokens_created_by_fkey(id, email)
    `).order('created_at', { ascending: false });
    if (error) throw error;
    return NextResponse.json({ tokens: data ?? [] });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  try {
    const { db, user } = await requireAdmin(request);
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'بيانات الرمز غير صحيحة.', 'invalid_token_data');

    const { data: token, error } = await db.rpc('create_submission_token', {
      p_organization_id: (await db.from('profiles').select('organization_id').eq('id', user.id).maybeSingle()).data?.organization_id ?? null,
      p_name: parsed.data.name,
      p_expires_at: parsed.data.expiresAt ?? null,
      p_max_submissions: parsed.data.maxSubmissions ?? null,
      p_created_by: user.id,
    });
    if (error) throw error;

    return NextResponse.json({ token: token[0] }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}