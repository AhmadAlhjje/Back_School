import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/core/database/prisma.js';
import { hashPassword } from '../../src/core/security/password.js';
import type { UserRole } from '../../src/generated/prisma/enums.js';

export const DEFAULT_PASSWORD = 'Passw0rd123';

let passwordHashPromise: Promise<string> | null = null;
const defaultHash = () => (passwordHashPromise ??= hashPassword(DEFAULT_PASSWORD));

let phoneCounter = 0;
/** Unique, valid phone number per call. */
export function uniquePhone(): string {
  phoneCounter += 1;
  return `09${String(Date.now() % 1_000_000).padStart(6, '0')}${String(phoneCounter % 100).padStart(2, '0')}`;
}

export async function createUser(
  role: UserRole,
  overrides: { name?: string; phone?: string; status?: 'ACTIVE' | 'DISABLED' } = {},
) {
  return prisma.user.create({
    data: {
      role,
      name: overrides.name ?? `${role.toLowerCase()} ${randomUUID().slice(0, 6)}`,
      phone: overrides.phone ?? uniquePhone(),
      passwordHash: await defaultHash(),
      status: overrides.status ?? 'ACTIVE',
      ...(role === 'STUDENT' ? { studentProfile: { create: {} } } : {}),
    },
  });
}

export async function createCatalog() {
  const grade = await prisma.grade.create({ data: { name: 'البكالوريا', sortOrder: 1 } });
  const math = await prisma.subject.create({ data: { gradeId: grade.id, name: 'رياضيات', sortOrder: 1 } });
  const physics = await prisma.subject.create({ data: { gradeId: grade.id, name: 'فيزياء', sortOrder: 2 } });
  const ahmad = await prisma.teacher.create({ data: { name: 'أحمد' } });
  const mohammad = await prisma.teacher.create({ data: { name: 'محمد' } });
  const mathAhmad = await prisma.subjectTeacher.create({ data: { subjectId: math.id, teacherId: ahmad.id } });
  const mathMohammad = await prisma.subjectTeacher.create({
    data: { subjectId: math.id, teacherId: mohammad.id },
  });
  const physicsAhmad = await prisma.subjectTeacher.create({
    data: { subjectId: physics.id, teacherId: ahmad.id },
  });
  const topic = await prisma.topic.create({ data: { subjectTeacherId: mathAhmad.id, title: 'التفاضل' } });
  const session = await prisma.session.create({ data: { topicId: topic.id, title: 'الجلسة الأولى' } });
  const lockedTopic = await prisma.topic.create({
    data: { subjectTeacherId: mathMohammad.id, title: 'الجبر' },
  });
  const lockedSession = await prisma.session.create({
    data: { topicId: lockedTopic.id, title: 'جلسة الجبر' },
  });
  return {
    grade,
    math,
    physics,
    ahmad,
    mohammad,
    mathAhmad,
    mathMohammad,
    physicsAhmad,
    topic,
    session,
    lockedTopic,
    lockedSession,
  };
}

export async function grantSubject(studentId: string, subjectId: string) {
  return prisma.studentSubjectAccess.create({ data: { studentId, subjectId } });
}

export async function grantTeacher(studentId: string, subjectTeacherId: string) {
  return prisma.studentTeacherAccess.create({ data: { studentId, subjectTeacherId } });
}
