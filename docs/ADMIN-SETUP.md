# دليل إعداد الإدارة والنشر

هذا المستودع لا يحتوي على مشروع Supabase/Vercel أو أسرار إنتاج. أكمل الخطوات في حسابك؛ لا ترسل المفاتيح أو كلمات المرور عبر المحادثة أو Git.

## 1. إنشاء مشروع Supabase

1. أنشئ مشروع PostgreSQL جديداً في Supabase، وحدد كلمة مرور قوية لقاعدة البيانات.
2. من **Project Settings → API** سجّل Project URL و`anon` key و`service_role` key في مدير أسرارك.
3. من **Project Settings → Storage → S3 Connection** أنشئ Access Key ID وSecret Access Key. استخدم endpoint بالشكل:
   `https://<project-ref>.supabase.co/storage/v1/s3`
   والمنطقة `us-east-1` ما لم تعرض صفحة مشروعك إعداداً مختلفاً.
4. في Supabase Auth، فعّل كلمة المرور، وأوقف التسجيل الذاتي. أضف حسابات الإدارة يدوياً أو عبر دعوة موثوقة.

## 2. تطبيق قاعدة البيانات

باستخدام Supabase CLI:

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

أو افتح SQL Editor وشغّل الملف كاملاً:
`supabase/migrations/20261007000000_initial.sql`

تُنشئ الهجرة الجداول والفهارس والدوال، RLS، وسياسة الملف الخاص/دلو `signage-media`. لا تنشئ Storage policy عامة. مفاتيح S3 الخادمية تتجاوز RLS الخاصة بجداول التطبيق وتُستخدم حصراً من Route Handlers.

### منح صلاحية مدير

أنشئ مستخدم Auth أولاً من لوحة Supabase. ينشئ trigger صف `profiles` بدور `viewer`. نفّذ SQL التالي بعد استبدال البريد:

```sql
update public.profiles p
set role = 'admin', updated_at = now()
from auth.users u
where p.id = u.id
  and lower(u.email) = lower('admin@example.org');
```

الأدوار المقبولة `admin`, `operator`, `viewer`. لا تمنح صلاحية المدير لأي مستخدم غير موثوق. لا يسمح التطبيق للمستخدم بتعديل دوره بنفسه.

## 3. إعداد البيئة المحلية

```bash
cp .env.example .env.local
```

املأ القيم محلياً، ولا تضع أسراراً في `NEXT_PUBLIC_*` إلا URL ومفتاح anon:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_S3_ENDPOINT=https://YOUR_PROJECT_REF.supabase.co/storage/v1/s3
SUPABASE_S3_REGION=us-east-1
SUPABASE_S3_ACCESS_KEY_ID=...
SUPABASE_S3_SECRET_ACCESS_KEY=...
SIGNAGE_STORAGE_BUCKET=signage-media
PAIRING_RATE_LIMIT_SALT=<random 32+ bytes>
CRON_SECRET=<different random 32+ bytes>
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

القيمة الافتراضية للدلو `signage-media`. إذا اخترت اسماً آخر، غيّر/أعد تطبيق اسم الدلو في migration و`SIGNAGE_STORAGE_BUCKET` معاً.

```bash
npm ci
npm run dev
```

افتح `/login`. تأكد أن دور المستخدم `admin` أو `operator`.

## 4. ضبط CORS لتخزين S3

الرفع والتنزيل المباشران يستخدمان روابط S3 موقّعة. من إعداد Storage/S3 في مشروعك، اسمح بأصل التطبيق المحلي وأصل الإنتاج المحددين فقط. اسمح بطلبات `GET`, `HEAD`, `PUT`, وheader `Range` للتنزيل؛ وسيحتاج المتصفح `PUT` للـ multipart upload. تحقّق من أن استجابات تنزيل Range تعيد `206 Partial Content` وأن CORS يسمح للمتصفح بقراءة الاستجابة. لا تسمح بأصل wildcard في بيئة الإنتاج إن أمكن.

اختبر من متصفح فعلي:

- طلب `PUT` لكل جزء إلى URL موقّع، ثم `ListParts`/إكمال الرفع.
- طلب `GET` موقّع برأس `Range: bytes=0-4194303`، وتحقق من `206` والحجم الصحيح.
- تحميل الفيديو في `/player` بعد فصل الشبكة؛ لا يكفي نجاح رابط المعاينة الإدارية.

## 5. نشر Vercel

1. أنشئ مشروع Vercel واربطه بالمستودع والفرع الذي تريد نشره.
2. اضبط أوامر المشروع: Install `npm ci`, Build `npm run build`, وOutput الافتراضي Next.js.
3. أضف كل قيم الإنتاج من قسم البيئة أعلاه إلى Production Environment. استخدم `CRON_SECRET` مختلفاً وطويلاً.
4. انشر، ثم أضف أصل Vercel (والنطاق المخصص إن وجد) إلى Supabase Auth Site URL/Redirect URLs وإلى CORS الخاص بالتخزين.
5. إذا لم يكن `vercel.json` Cron متاحاً في خطتك، شغّل `/api/cron/cleanup` يومياً من scheduler موثوق مع header `Authorization: Bearer <CRON_SECRET>`.
6. اختبر إنشاء مستخدم، الدخول، إنشاء شاشة، رفع ملف، وإكمال الاقتران من أصل الإنتاج.

GitHub Actions يشغّل lint/typecheck/unit tests/build، ولا يحتاج مفاتيح إنتاج. لا يجري workflow نشر Vercel تلقائياً؛ اربط Vercel من حسابك وأدخل أسراره في إعدادات Vercel.

## 6. أول استخدام للإدارة

1. افتح `/screens` وأضف شاشة. يظهر رمز مؤقت صالح 15 دقيقة.
2. افتح `/media` وارفع صوراً وفيديو MP4. يعرض الفحص توافقاً مرشحاً فقط؛ لا يعتبره إثباتاً لتوافق LG.
3. أنشئ قائمة في `/playlists`، أضف المحتوى، رتب بالسحب أو الأسهم، عيّن زمن الصور، واضبط تكرار الفيديو. انشر النسخة.
4. افتح رمز الاقتران على التلفاز عند `/player`.
5. عيّن القائمة للشاشة. للتحكم الزمني أضف صفوفاً في `/schedule`.

## 7. صيانة وتشغيل

- مهمة cron اليومية تُبطل جلسات multipart التي انتهت صلاحيتها وتحذف سجلات heartbeat الأقدم من 30 يوماً. لا تحذف أي سجل وسائط منشور.
- أدوار Supabase Auth والدلو الخاص ومفاتيح S3 ومفتاح service-role أسرار إنتاج. دوّرها عند الاشتباه بالتسرب.
- أزل ملفاً من قائمة وانشر النسخة الجديدة قبل حذفه من المكتبة. إذا كان الملف مستخدماً في القائمة الحالية، سيرفض API الحذف.
- لا تغيّر أصل التطبيق بعد نشر المحتوى؛ تخزين IndexedDB مرتبط بالأصل (scheme/host/port).
- تغييرات manifest لا تُنفّذ فورياً على شاشة غير متصلة. عند عودة الاتصال يتحقق اللاعب، ينزل التغييرات فقط، ويفعّل النسخة بعد اكتمالها.
