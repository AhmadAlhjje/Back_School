import { AuditAction, writeAudit, type AuditActor } from '../../core/audit/audit.js';
import { prisma, type Tx } from '../../core/database/prisma.js';
import { AppError, notFound } from '../../core/errors/app-error.js';
import { publishNotificationSafely } from '../notifications/notify.js';
import { activeGrantWhere } from './access-policy.js';

/**
 * Access management (spec §29, §111). Grants are rows with `revokedAt`; opening re-activates
 * the row, closing stamps `revokedAt`. Every change is audited.
 */

async function assertStudent(studentId: string) {
  const student = await prisma.user.findFirst({ where: { id: studentId, role: 'STUDENT' } });
  if (!student) throw notFound('student');
  if (student.archivedAt) throw new AppError('ITEM_ARCHIVED');
  return student;
}

function isActive(grant: { revokedAt: Date | null; expiresAt: Date | null } | null, now = new Date()) {
  return grant !== null && grant.revokedAt === null && (grant.expiresAt === null || grant.expiresAt > now);
}

/** Returns true when something changed. */
async function applySubjectGrant(
  tx: Tx,
  studentId: string,
  subjectId: string,
  open: boolean,
  actor: AuditActor,
) {
  const existing = await tx.studentSubjectAccess.findUnique({
    where: { studentId_subjectId: { studentId, subjectId } },
  });
  if (open === isActive(existing)) return false;
  if (open) {
    await tx.studentSubjectAccess.upsert({
      where: { studentId_subjectId: { studentId, subjectId } },
      create: { studentId, subjectId, source: 'MANUAL' },
      update: { revokedAt: null, expiresAt: null, grantedAt: new Date(), source: 'MANUAL' },
    });
  } else {
    await tx.studentSubjectAccess.update({
      where: { studentId_subjectId: { studentId, subjectId } },
      data: { revokedAt: new Date() },
    });
  }
  await writeAudit(tx, actor, {
    action: open ? AuditAction.OPEN_ACCESS : AuditAction.REVOKE_ACCESS,
    entityType: 'student_subject_access',
    entityId: studentId,
    metadata: { studentId, subjectId },
  });
  return true;
}

async function applyTeacherGrant(
  tx: Tx,
  studentId: string,
  assignment: { id: string; subjectId: string },
  open: boolean,
  actor: AuditActor,
) {
  const key = { studentId_subjectTeacherId: { studentId, subjectTeacherId: assignment.id } };
  const existing = await tx.studentTeacherAccess.findUnique({ where: key });
  let changed = false;
  if (open !== isActive(existing)) {
    if (open) {
      await tx.studentTeacherAccess.upsert({
        where: key,
        create: { studentId, subjectTeacherId: assignment.id, source: 'MANUAL' },
        update: { revokedAt: null, expiresAt: null, grantedAt: new Date(), source: 'MANUAL' },
      });
    } else {
      await tx.studentTeacherAccess.update({ where: key, data: { revokedAt: new Date() } });
    }
    await writeAudit(tx, actor, {
      action: open ? AuditAction.OPEN_ACCESS : AuditAction.REVOKE_ACCESS,
      entityType: 'student_teacher_access',
      entityId: studentId,
      metadata: { studentId, subjectTeacherId: assignment.id, subjectId: assignment.subjectId },
    });
    changed = true;
  }
  // Opening a teacher inside a closed subject opens the subject too — otherwise the grant
  // would be useless and the owner would see "open" while the student sees "locked".
  if (open) changed = (await applySubjectGrant(tx, studentId, assignment.subjectId, true, actor)) || changed;
  return changed;
}

async function loadSubject(subjectId: string) {
  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) throw notFound('subject');
  if (subject.archivedAt) throw new AppError('ITEM_ARCHIVED');
  return subject;
}

async function loadAssignment(subjectTeacherId: string) {
  const assignment = await prisma.subjectTeacher.findUnique({
    where: { id: subjectTeacherId },
    include: { subject: true, teacher: true },
  });
  if (!assignment) throw notFound('subject_teacher');
  if (assignment.archivedAt) throw new AppError('ITEM_ARCHIVED');
  return assignment;
}

export async function setSubjectAccess(
  studentId: string,
  subjectId: string,
  open: boolean,
  actor: AuditActor,
) {
  await assertStudent(studentId);
  const subject = await loadSubject(subjectId);
  const changed = await prisma.$transaction((tx) => applySubjectGrant(tx, studentId, subjectId, open, actor));
  if (changed && open) {
    await publishNotificationSafely({
      type: 'ACCOUNT',
      title: 'تم فتح مادة جديدة',
      body: `أصبحت مادة ${subject.name} متاحة لك`,
      data: { subjectId },
      audience: { kind: 'STUDENTS', studentIds: [studentId] },
      createdById: actor.userId,
    });
  }
  return getStudentAccessTree(studentId);
}

export async function setTeacherAccess(
  studentId: string,
  subjectTeacherId: string,
  open: boolean,
  actor: AuditActor,
) {
  await assertStudent(studentId);
  const assignment = await loadAssignment(subjectTeacherId);
  const changed = await prisma.$transaction((tx) =>
    applyTeacherGrant(tx, studentId, assignment, open, actor),
  );
  if (changed && open) {
    await publishNotificationSafely({
      type: 'ACCOUNT',
      title: 'تم فتح محتوى جديد',
      body: `أصبح محتوى الأستاذ ${assignment.teacher.name} في مادة ${assignment.subject.name} متاحاً لك`,
      data: { subjectId: assignment.subjectId, subjectTeacherId },
      audience: { kind: 'STUDENTS', studentIds: [studentId] },
      createdById: actor.userId,
    });
  }
  return getStudentAccessTree(studentId);
}

/** Open or close one subject / teacher for many students at once. */
export async function bulkSetAccess(
  input: {
    studentIds: string[];
    target: { type: 'SUBJECT'; id: string } | { type: 'SUBJECT_TEACHER'; id: string };
    open: boolean;
  },
  actor: AuditActor,
) {
  const studentIds = [...new Set(input.studentIds)];
  const students = await prisma.user.count({
    where: { id: { in: studentIds }, role: 'STUDENT', archivedAt: null },
  });
  if (students !== studentIds.length) throw notFound('student');

  let changedCount = 0;
  if (input.target.type === 'SUBJECT') {
    const subject = await loadSubject(input.target.id);
    await prisma.$transaction(async (tx) => {
      for (const studentId of studentIds) {
        if (await applySubjectGrant(tx, studentId, subject.id, input.open, actor)) changedCount += 1;
      }
    });
  } else {
    const assignment = await loadAssignment(input.target.id);
    await prisma.$transaction(async (tx) => {
      for (const studentId of studentIds) {
        if (await applyTeacherGrant(tx, studentId, assignment, input.open, actor)) changedCount += 1;
      }
    });
  }
  return { updated: changedCount, total: studentIds.length };
}

/**
 * Access tree for one student (spec §111):
 *   grade → subject (open?) → teachers (open?, effective?)
 * `effective` = what the student really gets (subject open AND teacher open).
 */
export async function getStudentAccessTree(studentId: string) {
  const student = await assertStudent(studentId);
  const now = new Date();
  const [grades, subjectGrants, teacherGrants] = await Promise.all([
    prisma.grade.findMany({
      where: { archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        subjects: {
          where: { archivedAt: null },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          include: {
            teachers: {
              where: { archivedAt: null, teacher: { archivedAt: null } },
              orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
              include: { teacher: { select: { id: true, name: true } } },
            },
          },
        },
      },
    }),
    prisma.studentSubjectAccess.findMany({
      where: { studentId, ...activeGrantWhere(now) },
      select: { subjectId: true },
    }),
    prisma.studentTeacherAccess.findMany({
      where: { studentId, ...activeGrantWhere(now) },
      select: { subjectTeacherId: true },
    }),
  ]);
  const openSubjects = new Set(subjectGrants.map((grant) => grant.subjectId));
  const openTeachers = new Set(teacherGrants.map((grant) => grant.subjectTeacherId));

  return {
    student: { id: student.id, name: student.name, phone: student.phone },
    grades: grades.map((grade) => ({
      id: grade.id,
      name: grade.name,
      subjects: grade.subjects.map((subject) => {
        const subjectOpen = openSubjects.has(subject.id);
        return {
          id: subject.id,
          name: subject.name,
          open: subjectOpen,
          teachers: subject.teachers.map((assignment) => ({
            subjectTeacherId: assignment.id,
            teacherId: assignment.teacher.id,
            name: assignment.teacher.name,
            open: openTeachers.has(assignment.id),
            effective: subjectOpen && openTeachers.has(assignment.id),
          })),
        };
      }),
    })),
  };
}
