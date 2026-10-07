import { HttpError } from '@/lib/server/http';

export async function loadUpload(db: any, userId: string, id: string) {
  const { data, error } = await db.from('media_uploads').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'جلسة الرفع غير موجودة.', 'upload_not_found');
  if (data.status !== 'uploading') throw new HttpError(409, 'جلسة الرفع لم تعد نشطة.', 'upload_not_active');
  if (new Date(data.expires_at).getTime() < Date.now()) throw new HttpError(410, 'انتهت صلاحية جلسة الرفع. ابدأ رفعاً جديداً.', 'upload_expired');
  return data;
}
