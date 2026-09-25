# Backend — خادم المنصة التعليمية

الـ API وقاعدة البيانات (التهجيرات والبيانات التجريبية) ومعالجة الفيديو في مشروع واحد.
Node 22+ · TypeScript · Express 5 · Prisma 7 · MariaDB/MySQL · FFmpeg.

## التشغيل المحلي

المتطلبات: Node.js 22 أو أحدث، و XAMPP (MySQL)، و FFmpeg على الـ PATH (لمعالجة الفيديو).

1. شغّل **MySQL** من لوحة XAMPP.
2. داخل مجلد `backend`:

```bash
npm install      # مرة واحدة فقط
npm run dev
```

`npm run dev` يقوم تلقائياً بـ:

- إنشاء قاعدة البيانات المكتوبة في `.env` (`DB_DATABASE`) إن لم تكن موجودة.
- تطبيق كل التهجيرات (migrations).
- تشغيل الـ seeders إذا كانت القاعدة فارغة: مدير النظام، وبيانات تجريبية كاملة (صفوف، مواد، مدرسون، دروس، جلسات، ملفات PDF، وفيديو تجريبي مشفّر جاهز للتشغيل).
- تشغيل الـ API على http://localhost:4000 (والتوثيق على http://localhost:4000/api/docs).

لا حاجة لـ Redis محلياً: معالجة الفيديو والإشعارات تعمل داخل الخادم نفسه.

## الرفع على السيرفر (VPS) بـ Docker

كل شيء داخل Docker: قاعدة البيانات، التهجير، الـ API على المنفذ **6000**، معالج الفيديو، Redis،
والنسخ الاحتياطي اليومي. داخل مجلد `backend` على السيرفر:

```bash
bash docker/init-env.sh          # مرة واحدة: ينشئ .env بكلمات سر عشوائية ويسأل عن حساب المشرف العام
docker compose up -d --build     # ينشئ القاعدة ويهجّرها ويشغّل كل شيء
```

للتحديث بعد `git pull`: نفس الأمر `docker compose up -d --build` (التهجيرات الجديدة تُطبّق تلقائياً).
الخطوات الكاملة (والمواقع على 6001 و 6002): [docs/deployment.md](docs/deployment.md).

## الحسابات التجريبية

| الدور                                   | الهاتف       | كلمة المرور  |
| --------------------------------------- | ------------ | ------------ |
| مدير النظام                             | `0900000000` | `Admin12345` |
| صاحب المعهد                             | `0911111111` | `Owner12345` |
| طالب (الرياضيات + الأستاذ أحمد مفتوحان) | `0933333333` | `Student123` |
| طالب (لا شيء مفتوح)                     | `0944444444` | `Student123` |

## ملف `.env`

| المتغير                      | المعنى                                                          |
| ---------------------------- | --------------------------------------------------------------- |
| `DB_HOST`, `DB_PORT`         | عنوان MySQL (XAMPP: `127.0.0.1`, `3306`)                        |
| `DB_DATABASE`                | اسم قاعدة البيانات — اكتب أي اسم وستُنشأ وتُهجَّر تلقائياً      |
| `DB_USERNAME`, `DB_PASSWORD` | XAMPP: `root` وكلمة مرور فارغة                                  |
| `API_BASE_URL`               | عنوان الـ API (يُستخدم في روابط الفيديو والملفات)               |
| `CORS_ORIGINS`               | لوحتا التحكم المسموح لهما (5173 و 5174)                         |
| `REDIS_URL`                  | فارغ محلياً؛ في السيرفر `redis://...` مع تشغيل `npm run worker` |
| `SEED_DEMO_DATA`             | `true` لإضافة البيانات التجريبية عند أول تشغيل                  |

إن حُذف `.env` يُنشأ تلقائياً من `.env.example` بمفاتيح سرية جديدة عند `npm run dev`.

## أوامر قاعدة البيانات

| الأمر                                       | ماذا يفعل                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run db:migrate`                        | إنشاء القاعدة إن لزم + تطبيق التهجيرات الجديدة                                |
| `npm run db:seed`                           | تشغيل الـ seeders                                                             |
| `npm run db:fresh`                          | حذف القاعدة وإعادة إنشائها + تهجير + seed (للتطوير فقط، يمسح `storage` أيضاً) |
| `npm run db:make-migration -- --name <اسم>` | بعد تعديل `database/schema.prisma`: إنشاء تهجير جديد                          |
| `npm run admin:create`                      | إنشاء مدير النظام من `SEED_SUPER_ADMIN_*` (للسيرفر)                           |

## أوامر أخرى

| الأمر                                                  | ماذا يفعل                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| `npm test`                                             | الاختبارات (قاعدة اختبار منفصلة `edu_platform_test` تُنشأ تلقائياً) |
| `npm run lint` · `npm run typecheck` · `npm run build` | الفحص والبناء                                                       |
| `npm start`                                            | تشغيل النسخة المبنية (`dist/`)                                      |
| `npm run worker`                                       | عامل الخلفية المنفصل (فقط عند ضبط `REDIS_URL` في السيرفر)           |
| `npm run e2e`                                          | تجربة المسار الكامل على الخادم الشغّال                              |

## بنية المشروع

```
src/                 الكود: config, core (http, auth, security, queue, storage...), modules, workers
database/            schema.prisma · migrations/ · seeders/ · scripts/ (نسخ احتياطي/استعادة) · cli.ts
tests/               اختبارات تكامل على MySQL حقيقية
scripts/             e2e-flow.ts · create-super-admin.ts · app-live-setup.ts
docker/              ملفات الرفع على VPS: init-env.sh، إعداد MariaDB، النسخ الاحتياطي
docker-compose.yml   تشغيل الباك على السيرفر بأمر واحد (الـ API على 6000)
docs/                التوثيق التفصيلي
storage/             الفيديوهات والملفات (خاص، لا يُخدم مباشرة)
```

## التوثيق

[architecture](docs/architecture.md) · [api](docs/api.md) · [database](docs/database.md) ·
[video-system](docs/video-system.md) · [security](docs/security.md) ·
[deployment (VPS)](docs/deployment.md) · [backup](docs/backup.md) ·
[development](docs/development.md) · [internals](docs/internals.md)
