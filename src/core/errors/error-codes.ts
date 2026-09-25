/**
 * Every error the API can return. Clients switch on `error.code`; the message is a
 * human-readable default (Arabic first, English available via Accept-Language).
 */
export const ERROR_DEFINITIONS = {
  VALIDATION_ERROR: { status: 400, ar: 'البيانات المدخلة غير صحيحة', en: 'Invalid input' },
  INVALID_CREDENTIALS: {
    status: 401,
    ar: 'رقم الهاتف أو كلمة المرور غير صحيحة',
    en: 'Invalid phone or password',
  },
  UNAUTHENTICATED: { status: 401, ar: 'يجب تسجيل الدخول أولاً', en: 'Authentication required' },
  TOKEN_EXPIRED: { status: 401, ar: 'انتهت صلاحية الجلسة', en: 'Access token expired' },
  TOKEN_INVALID: { status: 401, ar: 'رمز الدخول غير صالح', en: 'Invalid access token' },
  SESSION_REVOKED: {
    status: 401,
    ar: 'انتهت الجلسة، يرجى تسجيل الدخول مجدداً',
    en: 'Session is no longer valid',
  },
  REFRESH_TOKEN_INVALID: {
    status: 401,
    ar: 'انتهت الجلسة، يرجى تسجيل الدخول مجدداً',
    en: 'Invalid refresh token',
  },
  ACCOUNT_DISABLED: {
    status: 403,
    ar: 'هذا الحساب معطّل، يرجى مراجعة إدارة المعهد',
    en: 'Account is disabled',
  },
  FORBIDDEN: { status: 403, ar: 'ليس لديك صلاحية لتنفيذ هذا الإجراء', en: 'You are not allowed to do this' },
  DEVICE_ALREADY_BOUND: {
    status: 403,
    ar: 'هذا الحساب مرتبط بجهاز آخر. يرجى التواصل مع الإدارة',
    en: 'This account is bound to another device',
  },
  DEVICE_MISMATCH: {
    status: 403,
    ar: 'هذا الجهاز غير مسجّل لهذا الحساب',
    en: 'Device does not match this account',
  },
  DEVICE_REQUIRED: { status: 400, ar: 'معلومات الجهاز مطلوبة', en: 'Device information is required' },
  REGISTRATION_DISABLED: {
    status: 403,
    ar: 'التسجيل الذاتي غير متاح حالياً',
    en: 'Self registration is disabled',
  },
  ACCESS_DENIED: { status: 403, ar: 'هذا المحتوى مقفل', en: 'This content is locked' },
  NOT_FOUND: { status: 404, ar: 'العنصر المطلوب غير موجود', en: 'Resource not found' },
  ROUTE_NOT_FOUND: { status: 404, ar: 'المسار غير موجود', en: 'Route not found' },
  FILE_NOT_FOUND: { status: 404, ar: 'الملف غير موجود', en: 'File not found' },
  VIDEO_NOT_FOUND: { status: 404, ar: 'الفيديو غير موجود', en: 'Video not found' },
  VIDEO_NOT_READY: { status: 409, ar: 'الفيديو غير جاهز بعد', en: 'Video is not ready yet' },
  CONTENT_NOT_READY: { status: 409, ar: 'المحتوى غير جاهز بعد', en: 'Content is not ready yet' },
  CONFLICT: { status: 409, ar: 'تعارض مع بيانات موجودة', en: 'Conflicts with existing data' },
  PHONE_ALREADY_EXISTS: { status: 409, ar: 'رقم الهاتف مستخدم مسبقاً', en: 'Phone number already in use' },
  OWNER_ALREADY_EXISTS: {
    status: 409,
    ar: 'يوجد حساب لصاحب المعهد مسبقاً',
    en: 'An institute owner already exists',
  },
  PARENT_ARCHIVED: { status: 409, ar: 'العنصر الأب مؤرشف', en: 'Parent item is archived' },
  ITEM_ARCHIVED: { status: 409, ar: 'هذا العنصر مؤرشف', en: 'Item is archived' },
  WEAK_PASSWORD: {
    status: 400,
    ar: 'كلمة المرور ضعيفة: 8 أحرف على الأقل وتحتوي على حروف وأرقام',
    en: 'Password must be at least 8 characters and contain letters and digits',
  },
  INVALID_CURRENT_PASSWORD: {
    status: 400,
    ar: 'كلمة المرور الحالية غير صحيحة',
    en: 'Current password is incorrect',
  },
  PASSWORD_CONFIRMATION_MISMATCH: {
    status: 400,
    ar: 'تأكيد كلمة المرور غير مطابق',
    en: 'Password confirmation does not match',
  },
  INVALID_FILE_TYPE: { status: 415, ar: 'نوع الملف غير مسموح', en: 'File type is not allowed' },
  FILE_TOO_LARGE: { status: 413, ar: 'حجم الملف أكبر من المسموح', en: 'File is too large' },
  UPLOAD_FAILED: { status: 400, ar: 'فشل رفع الملف', en: 'Upload failed' },
  UPLOAD_INCOMPLETE: { status: 409, ar: 'لم يكتمل رفع الملف بعد', en: 'Upload is incomplete' },
  INVALID_UPLOAD_STATE: {
    status: 409,
    ar: 'لا يمكن تنفيذ العملية في حالة الرفع الحالية',
    en: 'Invalid upload state',
  },
  MEDIA_TOKEN_INVALID: {
    status: 403,
    ar: 'رابط الوسائط غير صالح أو منتهي',
    en: 'Media link is invalid or expired',
  },
  OFFLINE_DISABLED: {
    status: 403,
    ar: 'التحميل للمشاهدة دون إنترنت غير متاح',
    en: 'Offline downloads are disabled',
  },
  RATE_LIMITED: {
    status: 429,
    ar: 'محاولات كثيرة، يرجى الانتظار قليلاً',
    en: 'Too many requests, slow down',
  },
  PAYLOAD_TOO_LARGE: { status: 413, ar: 'حجم الطلب أكبر من المسموح', en: 'Request body is too large' },
  SERVICE_UNAVAILABLE: { status: 503, ar: 'الخدمة غير متاحة مؤقتاً', en: 'Service temporarily unavailable' },
  INTERNAL_ERROR: { status: 500, ar: 'حدث خطأ غير متوقع', en: 'Unexpected error' },
} as const satisfies Record<string, { status: number; ar: string; en: string }>;

export type ErrorCode = keyof typeof ERROR_DEFINITIONS;

export type Locale = 'ar' | 'en';

export function errorMessage(code: ErrorCode, locale: Locale): string {
  return ERROR_DEFINITIONS[code][locale];
}
