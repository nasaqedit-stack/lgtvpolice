'use client';

export type UploadStatus = 'uploading' | 'success' | 'error' | 'cancelled';
export type UploadUiState = {
  name: string;
  phase: string;
  status: UploadStatus;
  percent: number;
  uploaded: number;
  total: number;
  error?: string;
};
export type UploadProgress = (phase: string, uploaded?: number) => void;

function stateFor(
  file: Pick<File, 'name' | 'size'>,
  status: UploadStatus,
  phase: string,
  uploaded: number,
  error?: string,
): UploadUiState {
  const safeUploaded = Math.max(0, Math.min(file.size, uploaded));
  return {
    name: file.name,
    status,
    phase,
    percent: file.size ? Math.min(100, Math.round(safeUploaded / file.size * 100)) : 0,
    uploaded: safeUploaded,
    total: file.size,
    ...(error ? { error } : {}),
  };
}

/**
 * The state transition used by the media page: a rejected request is always rendered as `error`,
 * rather than leaving the last progress phase on screen forever.
 */
export async function runUploadTask<T>(
  file: Pick<File, 'name' | 'size'>,
  update: (state: UploadUiState) => void,
  task: (reportProgress: UploadProgress) => Promise<T | null>,
): Promise<T | null> {
  let lastPhase = 'فحص الملف…';
  let lastUploaded = 0;
  const reportProgress: UploadProgress = (phase, uploaded = 0) => {
    lastPhase = phase;
    lastUploaded = Math.max(0, Math.min(file.size, uploaded));
    update(stateFor(file, 'uploading', phase, lastUploaded));
  };
  reportProgress(lastPhase, lastUploaded);

  try {
    const result = await task(reportProgress);
    if (result === null) {
      update(stateFor(file, 'cancelled', 'تم إلغاء الرفع.', lastUploaded));
    } else {
      update(stateFor(file, 'success', 'اكتمل الرفع وأُضيف الوسيط إلى المكتبة.', file.size));
    }
    return result;
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : 'تعذر إكمال رفع الملف.';
    update(stateFor(file, 'error', `فشل الرفع أثناء: ${lastPhase}`, lastUploaded, message));
    throw reason;
  }
}
