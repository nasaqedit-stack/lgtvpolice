import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { errorResponse, readJson } from '@/lib/server/http';
import { createSupabaseAdmin } from '@/lib/server/supabase';
import { getSubmissionRateLimitSalt } from '@/lib/server/supabase';
import { SUBMISSION_MAX_FILE_SIZE, SUBMISSION_ALLOWED_MIME_TYPES, CONSENT_VERSION, CONSENT_TEXT } from '@/lib/shared';

export const runtime = 'nodejs';
export const maxDuration = 60;

const schema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(2000).optional().default(''),
  contributorName: z.string().trim().max(120).optional().default(''),
  contributorEmail: z.string().email().max(240).optional().default(''),
  contributorPhone: z.string().trim().max(30).optional().default(''),
  consentAccepted: z.literal(true),
  consentVersion: z.string().min(1).max(50),
  mediaId: z.string().uuid(),
}).strict();

type Context = { params: Promise<{ token: string }> };

function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(ip + salt).digest('hex');
}

function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}

export async function GET(request: NextRequest, context: Context) {
  try {
    const { token } = await context.params;
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      return NextResponse.json({ error: 'رابط المشاركة غير صالح.', code: 'invalid_token' }, { status: 400 });
    }
    const db = createSupabaseAdmin();
    const { data: tokenData, error } = await db
      .from('submission_tokens')
      .select('id, name, organization_id, expires_at, max_submissions, submission_count, enabled')
      .eq('token_hash', token)
      .maybeSingle();
    if (error) throw error;
    if (!tokenData || !tokenData.enabled) {
      return NextResponse.json({ error: 'رابط المشاركة غير صالح أو معطل.', code: 'token_invalid' }, { status: 404 });
    }
    if (tokenData.expires_at && new Date(tokenData.expires_at).getTime() < Date.now()) {
      return NextResponse.json({ error: 'انتهت صلاحية رابط المشاركة.', code: 'token_expired' }, { status: 410 });
    }
    if (tokenData.max_submissions && tokenData.submission_count >= tokenData.max_submissions) {
      return NextResponse.json({ error: 'تم استنفاد حد المشاركات لهذا الرابط.', code: 'token_exhausted' }, { status: 403 });
    }
    return NextResponse.json({
      tokenId: tokenData.id,
      name: tokenData.name,
      consentVersion: CONSENT_VERSION,
      consentText: CONSENT_TEXT,
      maxFileSize: SUBMISSION_MAX_FILE_SIZE,
      allowedMimeTypes: SUBMISSION_ALLOWED_MIME_TYPES,
    });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    const { token } = await context.params;
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      return NextResponse.json({ error: 'رابط المشاركة غير صالح.', code: 'invalid_token' }, { status: 400 });
    }
    const salt = getSubmissionRateLimitSalt();
    const ip = getClientIp(request);
    const ipHash = hashIp(ip, salt);

    const db = createSupabaseAdmin();

    // Validate token and check rate limit in one atomic operation
    const { data: validation, error: validateError } = await db.rpc('validate_submission_token', {
      p_token_hash: token,
      p_ip_hash: ipHash,
    });
    if (validateError) throw validateError;
    if (!validation) {
      return NextResponse.json({ error: 'تم تجاوز حد الطلبات. يرجى الانتظار قبل المحاولة مرة أخرى.', code: 'rate_limited' }, { status: 429 });
    }
    const tokenId = validation as string;

    // Read and validate submission data
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) {
      return NextResponse.json({ error: 'بيانات المشاركة غير صحيحة.', code: 'invalid_submission_data' }, { status: 400 });
    }
    const data = parsed.data;

    // Verify consent version matches
    if (data.consentVersion !== CONSENT_VERSION) {
      return NextResponse.json({ error: 'إصدار الإقرار غير متطابق.', code: 'consent_version_mismatch' }, { status: 400 });
    }

    // Verify media exists and belongs to this token's organization
    const { data: media, error: mediaError } = await db
      .from('media')
      .select('id, organization_id, storage_path, mime_type, kind, file_size, sha256')
      .eq('id', data.mediaId)
      .maybeSingle();
    if (mediaError) throw mediaError;
    if (!media) {
      return NextResponse.json({ error: 'الملف المحدد غير موجود.', code: 'media_not_found' }, { status: 404 });
    }

    // Verify token belongs to same organization
    const { data: tokenOrg, error: tokenOrgError } = await db
      .from('submission_tokens')
      .select('organization_id')
      .eq('id', tokenId)
      .maybeSingle();
    if (tokenOrgError) throw tokenOrgError;
    if (!tokenOrg || media.organization_id !== tokenOrg.organization_id) {
      return NextResponse.json({ error: 'الملف لا ينتمي لنفس المؤسسة.', code: 'media_org_mismatch' }, { status: 403 });
    }

    // Create submission
    const { data: submission, error: subError } = await db.rpc('create_submission', {
      p_token_id: tokenId,
      p_title: data.title,
      p_description: data.description,
      p_contributor_name: data.contributorName,
      p_contributor_email: data.contributorEmail,
      p_contributor_phone: data.contributorPhone,
      p_consent_accepted: data.consentAccepted,
      p_consent_version: data.consentVersion,
      p_consent_text: CONSENT_TEXT,
      p_ip_hash: ipHash,
    });
    if (subError) throw subError;
    const submissionId = submission as string;

    // Update submission with original media reference
    const { error: updateError } = await db
      .from('submissions')
      .update({ original_media_id: media.id, updated_at: new Date().toISOString() })
      .eq('id', submissionId);
    if (updateError) throw updateError;

    // Start processing
    const { error: processError } = await db.rpc('start_submission_processing', {
      p_submission_id: submissionId,
    });
    if (processError) throw processError;

    return NextResponse.json({ submissionId, state: 'PROCESSING' }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}