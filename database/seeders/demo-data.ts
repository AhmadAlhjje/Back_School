import { prisma } from '../../src/core/database/prisma.js';
import { hashPassword } from '../../src/core/security/password.js';

/**
 * Development/demo data only — refused in production by seed.ts.
 * Idempotent: skipped entirely when grades already exist.
 *
 * Catalog: 4 grades; Baccalaureate → Mathematics (Ahmad, Mohammad), Physics (Ahmad), Chemistry;
 * Mathematics/Ahmad has 4 topics × 2 sessions. Media (video, PDFs) is added by demo-media.ts.
 *
 * Accounts:
 *   Owner    0911111111 / Owner12345
 *   Student  0933333333 / Student123 (Mathematics + Ahmad opened)
 *   Student  0944444444 / Student123 (nothing opened)
 */
export const DEMO_ACCOUNTS = {
  owner: { name: 'صاحب المعهد', phone: '0911111111', password: 'Owner12345' },
  students: [
    { name: 'أحمد الطالب', phone: '0933333333', password: 'Student123' },
    { name: 'سارة', phone: '0944444444', password: 'Student123' },
  ],
};

/** Ids the media seeder attaches content to. */
export interface DemoCatalog {
  ownerId: string;
  subjectId: string;
  subjectTeacherId: string;
  sessionId: string;
}

/** Creates the demo catalog and accounts; returns null when demo data already exists. */
export async function seedDemoData(): Promise<DemoCatalog | null> {
  if ((await prisma.grade.count()) > 0) return null;

  const [ownerHash, studentHash] = await Promise.all([
    hashPassword(DEMO_ACCOUNTS.owner.password),
    hashPassword(DEMO_ACCOUNTS.students[0]!.password),
  ]);

  return prisma.$transaction(async (tx) => {
    const owner =
      (await tx.user.findFirst({ where: { role: 'OWNER', archivedAt: null } })) ??
      (await tx.user.create({
        data: {
          role: 'OWNER',
          name: DEMO_ACCOUNTS.owner.name,
          phone: DEMO_ACCOUNTS.owner.phone,
          passwordHash: ownerHash,
        },
      }));

    const gradeNames = ['الصف التاسع', 'الصف العاشر', 'الصف الحادي عشر', 'البكالوريا'];
    const grades = [];
    for (const [index, name] of gradeNames.entries()) {
      grades.push(await tx.grade.create({ data: { name, sortOrder: index + 1 } }));
    }
    const bac = grades[3]!;

    const subjectNames = ['رياضيات', 'فيزياء', 'كيمياء'];
    const subjects = [];
    for (const [index, name] of subjectNames.entries()) {
      subjects.push(await tx.subject.create({ data: { gradeId: bac.id, name, sortOrder: index + 1 } }));
    }
    const [math, physics] = subjects;

    const ahmad = await tx.teacher.create({
      data: { name: 'أحمد', phone: '0955000001', description: 'مدرس رياضيات وفيزياء' },
    });
    const mohammad = await tx.teacher.create({ data: { name: 'محمد', phone: '0955000002' } });
    const mathAhmad = await tx.subjectTeacher.create({
      data: { subjectId: math!.id, teacherId: ahmad.id, sortOrder: 1 },
    });
    await tx.subjectTeacher.create({ data: { subjectId: math!.id, teacherId: mohammad.id, sortOrder: 2 } });
    await tx.subjectTeacher.create({ data: { subjectId: physics!.id, teacherId: ahmad.id, sortOrder: 1 } });

    const topicTitles = ['التفاضل', 'الاشتقاق', 'التكامل', 'النهايات'];
    let firstSessionId: string | null = null;
    for (const [index, title] of topicTitles.entries()) {
      const topic = await tx.topic.create({
        data: { subjectTeacherId: mathAhmad.id, title, sortOrder: index + 1 },
      });
      for (const [sIndex, sessionTitle] of ['الجلسة الأولى', 'الجلسة الثانية'].entries()) {
        const session = await tx.session.create({
          data: { topicId: topic.id, title: sessionTitle, sortOrder: sIndex + 1 },
        });
        firstSessionId ??= session.id;
      }
    }

    for (const account of DEMO_ACCOUNTS.students) {
      const student = await tx.user.create({
        data: {
          role: 'STUDENT',
          name: account.name,
          phone: account.phone,
          passwordHash: studentHash,
          studentProfile: { create: { gradeId: bac.id } },
        },
      });
      if (account.phone === DEMO_ACCOUNTS.students[0]!.phone) {
        await tx.studentSubjectAccess.create({ data: { studentId: student.id, subjectId: math!.id } });
        await tx.studentTeacherAccess.create({ data: { studentId: student.id, subjectTeacherId: mathAhmad.id } });
      }
    }

    return { ownerId: owner.id, subjectId: math!.id, subjectTeacherId: mathAhmad.id, sessionId: firstSessionId! };
  });
}
