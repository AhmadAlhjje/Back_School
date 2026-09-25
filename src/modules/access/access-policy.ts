import { prisma, type DbClient } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';

/**
 * The student content-access policy (spec §27–31, §112). This is the single place that decides
 * whether a student may open something. Rules:
 *
 *   1. Content is reachable only if its entire ancestor chain is active
 *      (grade → subject → subject-teacher → teacher → topic → session → item).
 *      Archived content behaves as if it did not exist (NOT_FOUND, never ACCESS_DENIED).
 *   2. Teacher content additionally requires BOTH an active subject grant and an active
 *      teacher grant for that subject-teacher. Grants are evaluated at request time against
 *      the hierarchy, so anything added later under an open teacher is open automatically.
 *   3. Subject-level files need only the subject grant.
 *   4. Videos must be READY.
 */

export function activeGrantWhere(now = new Date()) {
  return { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

export async function hasSubjectAccess(studentId: string, subjectId: string, db: DbClient = prisma) {
  const grant = await db.studentSubjectAccess.findFirst({
    where: { studentId, subjectId, ...activeGrantWhere() },
    select: { id: true },
  });
  return grant !== null;
}

export async function hasTeacherAccess(studentId: string, subjectTeacherId: string, db: DbClient = prisma) {
  const grant = await db.studentTeacherAccess.findFirst({
    where: { studentId, subjectTeacherId, ...activeGrantWhere() },
    select: { id: true },
  });
  return grant !== null;
}

/** Both grants required to open anything inside a teacher's space. */
export async function canOpenSubjectTeacher(
  studentId: string,
  assignment: { id: string; subjectId: string },
  db: DbClient = prisma,
): Promise<boolean> {
  const [subject, teacher] = await Promise.all([
    hasSubjectAccess(studentId, assignment.subjectId, db),
    hasTeacherAccess(studentId, assignment.id, db),
  ]);
  return subject && teacher;
}

/** Ancestor chain select used by every content lookup. */
const subjectTeacherChain = {
  select: {
    id: true,
    subjectId: true,
    archivedAt: true,
    teacher: { select: { id: true, name: true, archivedAt: true } },
    subject: {
      select: {
        id: true,
        name: true,
        archivedAt: true,
        grade: { select: { id: true, name: true, archivedAt: true } },
      },
    },
  },
} as const;

type ChainNode = { archivedAt: Date | null };
function chainActive(...nodes: ChainNode[]): boolean {
  return nodes.every((node) => node.archivedAt === null);
}

interface SubjectTeacherChain {
  id: string;
  subjectId: string;
  archivedAt: Date | null;
  teacher: ChainNode;
  subject: ChainNode & { grade: ChainNode };
}

function assignmentActive(assignment: SubjectTeacherChain): boolean {
  return chainActive(assignment, assignment.teacher, assignment.subject, assignment.subject.grade);
}

export async function assertSubjectTeacherAccess(studentId: string, subjectTeacherId: string) {
  const assignment = await prisma.subjectTeacher.findUnique({
    where: { id: subjectTeacherId },
    ...subjectTeacherChain,
  });
  if (!assignment || !assignmentActive(assignment)) throw new AppError('NOT_FOUND');
  if (!(await canOpenSubjectTeacher(studentId, assignment))) {
    throw new AppError('ACCESS_DENIED', { details: { reason: 'TEACHER_LOCKED', subjectTeacherId } });
  }
  return assignment;
}

export async function assertTopicAccess(studentId: string, topicId: string) {
  const topic = await prisma.topic.findUnique({
    where: { id: topicId },
    include: { subjectTeacher: subjectTeacherChain },
  });
  if (!topic || !chainActive(topic) || !assignmentActive(topic.subjectTeacher))
    throw new AppError('NOT_FOUND');
  if (!(await canOpenSubjectTeacher(studentId, topic.subjectTeacher))) {
    throw new AppError('ACCESS_DENIED', { details: { reason: 'TEACHER_LOCKED' } });
  }
  return topic;
}

export async function assertSessionAccess(studentId: string, sessionId: string) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { topic: { include: { subjectTeacher: subjectTeacherChain } } },
  });
  if (!session || !chainActive(session, session.topic) || !assignmentActive(session.topic.subjectTeacher)) {
    throw new AppError('NOT_FOUND');
  }
  if (!(await canOpenSubjectTeacher(studentId, session.topic.subjectTeacher))) {
    throw new AppError('ACCESS_DENIED', { details: { reason: 'TEACHER_LOCKED' } });
  }
  return session;
}

/** Full check before issuing any video playback / key / offline license. */
export async function assertVideoAccess(studentId: string, videoId: string) {
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    include: {
      asset: true,
      session: { include: { topic: { include: { subjectTeacher: subjectTeacherChain } } } },
    },
  });
  if (
    !video ||
    !chainActive(video, video.session, video.session.topic) ||
    !assignmentActive(video.session.topic.subjectTeacher)
  ) {
    throw new AppError('VIDEO_NOT_FOUND');
  }
  if (!(await canOpenSubjectTeacher(studentId, video.session.topic.subjectTeacher))) {
    throw new AppError('ACCESS_DENIED', { details: { reason: 'TEACHER_LOCKED' } });
  }
  if (video.status !== 'READY' || !video.asset) throw new AppError('VIDEO_NOT_READY');
  return { ...video, asset: video.asset };
}

/** Full check before issuing a file download token. */
export async function assertFileAccess(studentId: string, fileId: string) {
  const file = await prisma.contentFile.findUnique({
    where: { id: fileId },
    include: {
      subject: { select: { id: true, archivedAt: true, grade: { select: { archivedAt: true } } } },
      subjectTeacher: subjectTeacherChain,
      topic: { include: { subjectTeacher: subjectTeacherChain } },
      session: { include: { topic: { include: { subjectTeacher: subjectTeacherChain } } } },
    },
  });
  if (!file || file.archivedAt) throw new AppError('FILE_NOT_FOUND');

  if (file.scope === 'SUBJECT') {
    if (!file.subject || !chainActive(file.subject, file.subject.grade)) throw new AppError('FILE_NOT_FOUND');
    if (!(await hasSubjectAccess(studentId, file.subject.id))) {
      throw new AppError('ACCESS_DENIED', { details: { reason: 'SUBJECT_LOCKED' } });
    }
    return file;
  }

  let assignment: SubjectTeacherChain | null = null;
  if (file.scope === 'TEACHER') assignment = file.subjectTeacher;
  if (file.scope === 'TOPIC' && file.topic && chainActive(file.topic)) assignment = file.topic.subjectTeacher;
  if (file.scope === 'SESSION' && file.session && chainActive(file.session, file.session.topic)) {
    assignment = file.session.topic.subjectTeacher;
  }
  if (!assignment || !assignmentActive(assignment)) throw new AppError('FILE_NOT_FOUND');
  if (!(await canOpenSubjectTeacher(studentId, assignment))) {
    throw new AppError('ACCESS_DENIED', { details: { reason: 'TEACHER_LOCKED' } });
  }
  return file;
}
