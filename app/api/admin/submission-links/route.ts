import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { HttpError, errorResponse, readJson, requireAdmin } from '@/lib/server/http';
import { generateSubmissionToken, submissionPath } from '@/lib/server/submission-links';

export const runtime = 'nodejs';
export const maxDuration = 60;

const createSchema = z.object({
  label: z.string().trim().min(2).max(120),
  expiresInDays: z.number().int().positive().max(365).optional(),
}).strict();
const updateSchema = z.object({
  id: z.string().uuid(),
  active: z.boolean(),
}).strict();

/**
 * Public submission links. The raw token is returned EXACTLY ONCE, at creation; only its hash
 * is stored. The link opens the public /submit/<token> form and grants no admin access.
 */
export async function GET(request: NextRequest) {
  try {
    const { db } = await requireAdmin(request);
    const { data: links, error } = await db.from('submission_links')
      .select('id,label,active,created_at,expires_at,created_by')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    const ids = (links ?? []).map((row: any) => row.id);
    const counts = new Map<string, number>();
    if (ids.length) {
      const { data: rows, error: countError } = await db.from('submissions')
        .select('link_id')
        .in('link_id', ids);
      if (countError) throw countError;
      for (const row of rows ?? []) counts.set(row.link_id, (counts.get(row.link_id) ?? 0) + 1);
    }
    return NextResponse.json({
      links: (links ?? []).map((row: any) => ({ ...row, submissionCount: counts.get(row.id) ?? 0 })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error, { route: 'GET /api/admin/submission-links' }); }
}

export async function POST(request: NextRequest) {
  try {
    const { db, user, role } = await requireAdmin(request);
    if (role !== 'admin') throw new HttpError(403, 'إنشاء روابط المشاركة يتطلب صلاحية مدير النظام.', 'approver_required');
    const parsed = createSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'اسم رابط المشاركة غير صالح.', 'validation_error');
    const { token, tokenHash } = generateSubmissionToken();
    const expiresAt = parsed.data.expiresInDays
      ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60_000).toISOString()
      : null;
    const { data: link, error } = await db.from('submission_links').insert({
      token_hash: tokenHash,
      label: parsed.data.label,
      created_by: user.id,
      expires_at: expiresAt,
    }).select('id,label,active,created_at,expires_at').single();
    if (error) throw error;
    return NextResponse.json({
      link,
      // Shown once: the token itself is never stored, so copy it now.
      token,
      url: `${request.nextUrl.origin}${submissionPath(token)}`,
    }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error, { route: 'POST /api/admin/submission-links' }); }
}

/** Activate/deactivate (revoke) a submission link. */
export async function PATCH(request: NextRequest) {
  try {
    const { db, role } = await requireAdmin(request);
    if (role !== 'admin') throw new HttpError(403, 'إدارة روابط المشاركة تتطلب صلاحية مدير النظام.', 'approver_required');
    const parsed = updateSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'بيانات غير صالحة.', 'validation_error');
    const { data: link, error } = await db.from('submission_links')
      .update({ active: parsed.data.active })
      .eq('id', parsed.data.id)
      .select('id,label,active,created_at,expires_at')
      .maybeSingle();
    if (error) throw error;
    if (!link) throw new HttpError(404, 'رابط المشاركة غير موجود.', 'not_found');
    return NextResponse.json({ link }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error, { route: 'PATCH /api/admin/submission-links' }); }
}
