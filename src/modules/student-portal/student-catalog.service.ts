import type { AuthContext } from '../../core/auth/auth-context.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import {
  activeGrantWhere,
  assertSessionAccess,
  assertSubjectTeacherAccess,
  assertTopicAccess,
} from '../access/access-policy.js';
import { toStudentFileDto } from '../files/files.dto.js';
import { unreadCount } from '../notifications/notifications.service.js';
import { getSettings } from '../settings/settings.service.js';

/**
 * Read models for the student app. Locked items are listed with `locked: true` so the app can
 * show them with a lock, but every endpoint that returns content goes through the access policy.
 */

const byOrder = [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }];
const activeFiles = { where: { archivedAt: null }, orderBy: byOrder };
const readyVideos = { archivedAt: null, status: 'READY' as const };

interface Grants {
  subjects: Set<string>;
  teachers: Set<string>;
}

async function loadGrants(studentId: string): Promise<Grants> {
  const now = new Date();
  const [subjects, teachers] = await Promise.all([
    prisma.studentSubjectAccess.findMany({
      where: { studentId, ...activeGrantWhere(now) },
      select: { subjectId: true },
    }),
    prisma.studentTeacherAccess.findMany({
      where: { studentId, ...activeGrantWhere(now) },
      select: { subjectTeacherId: true },
    }),
  ]);
  return {
    subjects: new Set(subjects.map((row) => row.subjectId)),
    teachers: new Set(teachers.map((row) => row.subjectTeacherId)),
  };
}

function teacherImageUrl(teacher: { id: string; imageKey: string | null; updatedAt: Date }) {
  return teacher.imageKey
    ? `/api/v1/media/teachers/${teacher.id}/image?v=${teacher.updatedAt.getTime()}`
    : null;
}

const activeSubjectWhere = { archivedAt: null, grade: { archivedAt: null } };

function subjectCard(
  subject: { id: string; name: string; description: string | null; gradeId: string; grade: { name: string } },
  grants: Grants,
  teachersCount: number,
) {
  return {
    id: subject.id,
    name: subject.name,
    description: subject.description,
    gradeId: subject.gradeId,
    gradeName: subject.grade.name,
    teachersCount,
    locked: !grants.subjects.has(subject.id),
  };
}

const teacherCountSelect = {
  _count: { select: { teachers: { where: { archivedAt: null, teacher: { archivedAt: null } } } } },
};

export async function getHome(auth: AuthContext) {
  const [student, grants, settings, unread, grades] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, include: { studentProfile: true } }),
    loadGrants(auth.userId),
    getSettings(),
    unreadCount(auth.userId),
    prisma.grade.findMany({
      where: { archivedAt: null },
      orderBy: byOrder,
      include: { _count: { select: { subjects: { where: { archivedAt: null } } } } },
    }),
  ]);
  const gradeId = student.studentProfile?.gradeId ?? null;
  // "Your subjects": the student's grade plus anything opened from other grades.
  const subjects = await prisma.subject.findMany({
    where: {
      ...activeSubjectWhere,
      OR: [...(gradeId ? [{ gradeId }] : []), { id: { in: [...grants.subjects] } }],
    },
    orderBy: [{ grade: { sortOrder: 'asc' } }, ...byOrder],
    include: { grade: { select: { name: true } }, ...teacherCountSelect },
  });
  return {
    student: { id: student.id, name: student.name, gradeId },
    institute: { name: settings.instituteName },
    unreadNotifications: unread,
    subjects: subjects.map((subject) => subjectCard(subject, grants, subject._count.teachers)),
    grades: grades.map((grade) => ({ id: grade.id, name: grade.name, subjectsCount: grade._count.subjects })),
  };
}

export async function listGrades() {
  const grades = await prisma.grade.findMany({
    where: { archivedAt: null },
    orderBy: byOrder,
    include: { _count: { select: { subjects: { where: { archivedAt: null } } } } },
  });
  return grades.map((grade) => ({
    id: grade.id,
    name: grade.name,
    description: grade.description,
    subjectsCount: grade._count.subjects,
  }));
}

export async function listGradeSubjects(studentId: string, gradeId: string) {
  const grade = await prisma.grade.findFirst({ where: { id: gradeId, archivedAt: null } });
  if (!grade) throw new AppError('NOT_FOUND');
  const [grants, subjects] = await Promise.all([
    loadGrants(studentId),
    prisma.subject.findMany({
      where: { gradeId, archivedAt: null },
      orderBy: byOrder,
      include: { grade: { select: { name: true } }, ...teacherCountSelect },
    }),
  ]);
  return {
    grade: { id: grade.id, name: grade.name },
    subjects: subjects.map((subject) => subjectCard(subject, grants, subject._count.teachers)),
  };
}

/** Subject page: visible even when locked (teachers are listed with locks); files only when open. */
export async function getSubjectForStudent(studentId: string, subjectId: string) {
  const [grants, subject] = await Promise.all([
    loadGrants(studentId),
    prisma.subject.findFirst({
      where: { id: subjectId, ...activeSubjectWhere },
      include: {
        grade: { select: { id: true, name: true } },
        teachers: {
          where: { archivedAt: null, teacher: { archivedAt: null } },
          orderBy: byOrder,
          include: {
            teacher: true,
            _count: { select: { topics: { where: { archivedAt: null } } } },
          },
        },
        files: activeFiles,
      },
    }),
  ]);
  if (!subject) throw new AppError('NOT_FOUND');
  const subjectOpen = grants.subjects.has(subject.id);
  return {
    subject: {
      id: subject.id,
      name: subject.name,
      description: subject.description,
      grade: subject.grade,
      locked: !subjectOpen,
    },
    teachers: subject.teachers.map((assignment) => ({
      subjectTeacherId: assignment.id,
      teacher: {
        id: assignment.teacher.id,
        name: assignment.teacher.name,
        description: assignment.teacher.description,
        imageUrl: teacherImageUrl(assignment.teacher),
      },
      topicsCount: assignment._count.topics,
      locked: !(subjectOpen && grants.teachers.has(assignment.id)),
    })),
    files: subjectOpen ? subject.files.map(toStudentFileDto) : [],
  };
}

/** A teacher's space in a subject: requires subject + teacher access. */
export async function getTeacherSpace(studentId: string, subjectTeacherId: string) {
  await assertSubjectTeacherAccess(studentId, subjectTeacherId);
  const assignment = await prisma.subjectTeacher.findUniqueOrThrow({
    where: { id: subjectTeacherId },
    include: {
      subject: { select: { id: true, name: true } },
      teacher: true,
      topics: {
        where: { archivedAt: null },
        orderBy: byOrder,
        include: { _count: { select: { sessions: { where: { archivedAt: null } } } } },
      },
      files: activeFiles,
    },
  });
  return {
    subjectTeacherId: assignment.id,
    subject: assignment.subject,
    teacher: {
      id: assignment.teacher.id,
      name: assignment.teacher.name,
      description: assignment.teacher.description,
      imageUrl: teacherImageUrl(assignment.teacher),
    },
    topics: assignment.topics.map((topic) => ({
      id: topic.id,
      title: topic.title,
      description: topic.description,
      sessionsCount: topic._count.sessions,
    })),
    files: assignment.files.map(toStudentFileDto),
  };
}

export async function getTopicForStudent(studentId: string, topicId: string) {
  await assertTopicAccess(studentId, topicId);
  const topic = await prisma.topic.findUniqueOrThrow({
    where: { id: topicId },
    include: {
      subjectTeacher: {
        select: {
          id: true,
          subject: { select: { id: true, name: true } },
          teacher: { select: { id: true, name: true } },
        },
      },
      sessions: {
        where: { archivedAt: null },
        orderBy: byOrder,
        include: {
          _count: { select: { videos: { where: readyVideos }, files: { where: { archivedAt: null } } } },
        },
      },
      files: activeFiles,
    },
  });
  return {
    topic: { id: topic.id, title: topic.title, description: topic.description },
    subjectTeacherId: topic.subjectTeacher.id,
    subject: topic.subjectTeacher.subject,
    teacher: topic.subjectTeacher.teacher,
    sessions: topic.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      description: session.description,
      videosCount: session._count.videos,
      filesCount: session._count.files,
    })),
    files: topic.files.map(toStudentFileDto),
  };
}

export async function getSessionForStudent(studentId: string, sessionId: string) {
  await assertSessionAccess(studentId, sessionId);
  const session = await prisma.session.findUniqueOrThrow({
    where: { id: sessionId },
    include: {
      topic: { select: { id: true, title: true } },
      videos: { where: readyVideos, orderBy: byOrder },
      files: activeFiles,
    },
  });
  return {
    session: { id: session.id, title: session.title, description: session.description },
    topic: session.topic,
    videos: session.videos.map((video) => ({
      id: video.id,
      title: video.title,
      description: video.description,
      durationSeconds: video.durationSeconds,
      sortOrder: video.sortOrder,
    })),
    files: session.files.map(toStudentFileDto),
  };
}

/**
 * Search (spec §115). Subjects and teachers are searched across the catalog (with lock state);
 * topics, sessions and videos only inside teacher spaces the student can open, so the titles
 * of locked content are not revealed.
 */
export async function searchCatalog(studentId: string, term: string) {
  const grants = await loadGrants(studentId);
  const openAssignments = await prisma.subjectTeacher.findMany({
    where: {
      id: { in: [...grants.teachers] },
      subjectId: { in: [...grants.subjects] },
      archivedAt: null,
      teacher: { archivedAt: null },
      subject: activeSubjectWhere,
    },
    select: { id: true },
  });
  const openIds = openAssignments.map((row) => row.id);
  const LIMIT = 15;

  const [subjects, teachers, topics, sessions, videos] = await Promise.all([
    prisma.subject.findMany({
      where: { ...activeSubjectWhere, name: { contains: term } },
      include: { grade: { select: { name: true } }, ...teacherCountSelect },
      take: LIMIT,
    }),
    prisma.subjectTeacher.findMany({
      where: {
        archivedAt: null,
        subject: activeSubjectWhere,
        teacher: { archivedAt: null, name: { contains: term } },
      },
      include: { teacher: true, subject: { select: { id: true, name: true } } },
      take: LIMIT,
    }),
    prisma.topic.findMany({
      where: { archivedAt: null, subjectTeacherId: { in: openIds }, title: { contains: term } },
      select: { id: true, title: true, subjectTeacherId: true },
      take: LIMIT,
    }),
    prisma.session.findMany({
      where: {
        archivedAt: null,
        title: { contains: term },
        topic: { archivedAt: null, subjectTeacherId: { in: openIds } },
      },
      select: { id: true, title: true, topic: { select: { id: true, title: true } } },
      take: LIMIT,
    }),
    prisma.video.findMany({
      where: {
        ...readyVideos,
        title: { contains: term },
        session: { archivedAt: null, topic: { archivedAt: null, subjectTeacherId: { in: openIds } } },
      },
      select: {
        id: true,
        title: true,
        durationSeconds: true,
        session: { select: { id: true, title: true } },
      },
      take: LIMIT,
    }),
  ]);

  return {
    subjects: subjects.map((subject) => subjectCard(subject, grants, subject._count.teachers)),
    teachers: teachers.map((assignment) => ({
      subjectTeacherId: assignment.id,
      subject: assignment.subject,
      teacher: {
        id: assignment.teacher.id,
        name: assignment.teacher.name,
        imageUrl: teacherImageUrl(assignment.teacher),
      },
      locked: !(grants.subjects.has(assignment.subjectId) && grants.teachers.has(assignment.id)),
    })),
    topics,
    sessions,
    videos,
  };
}

export async function getStudentProfile(auth: AuthContext) {
  const [user, grants] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      include: { studentProfile: { include: { grade: { select: { id: true, name: true } } } } },
    }),
    loadGrants(auth.userId),
  ]);
  const device = auth.deviceId
    ? await prisma.device.findUnique({
        where: { id: auth.deviceId },
        select: { platform: true, model: true, firstSeenAt: true, appVersion: true },
      })
    : null;
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    grade: user.studentProfile?.grade ?? null,
    device,
    openSubjectsCount: grants.subjects.size,
    openTeachersCount: grants.teachers.size,
  };
}
