import fs from 'node:fs/promises';
import { prisma } from '../../core/database/prisma.js';
import { storageRoot } from '../../core/storage/storage.js';
import { toStaffVideoDto } from '../videos/videos.dto.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Institute overview shared by owner and super admin dashboards. */
export async function getInstituteStats() {
  // Day buckets are UTC days (start and keys computed the same way, including today).
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 13 * DAY_MS);
  const [
    students,
    disabledStudents,
    teachers,
    subjects,
    grades,
    topics,
    sessions,
    readyVideos,
    uploadingVideos,
    failedVideos,
    files,
    recentVideos,
    recentStudents,
    videosSince,
  ] = await Promise.all([
    prisma.user.count({ where: { role: 'STUDENT', archivedAt: null } }),
    prisma.user.count({ where: { role: 'STUDENT', archivedAt: null, status: 'DISABLED' } }),
    prisma.teacher.count({ where: { archivedAt: null } }),
    prisma.subject.count({ where: { archivedAt: null } }),
    prisma.grade.count({ where: { archivedAt: null } }),
    prisma.topic.count({ where: { archivedAt: null } }),
    prisma.session.count({ where: { archivedAt: null } }),
    prisma.video.count({ where: { archivedAt: null, status: 'READY' } }),
    prisma.video.count({ where: { archivedAt: null, status: { in: ['UPLOADING', 'PROCESSING'] } } }),
    prisma.video.count({ where: { archivedAt: null, status: 'FAILED' } }),
    prisma.contentFile.count({ where: { archivedAt: null } }),
    prisma.video.findMany({
      where: { archivedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 6,
      include: {
        uploadJobs: { orderBy: { createdAt: 'desc' }, take: 1 },
        session: { select: { title: true, topic: { select: { title: true } } } },
      },
    }),
    prisma.user.findMany({
      where: { role: 'STUDENT', archivedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, name: true, phone: true, createdAt: true, status: true },
    }),
    prisma.video.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
  ]);

  const uploadsPerDay: { date: string; count: number }[] = [];
  for (let i = 0; i < 14; i += 1) {
    const day = new Date(since.getTime() + i * DAY_MS);
    const key = day.toISOString().slice(0, 10);
    uploadsPerDay.push({
      date: key,
      count: videosSince.filter((v) => v.createdAt.toISOString().slice(0, 10) === key).length,
    });
  }

  return {
    counts: {
      students,
      disabledStudents,
      teachers,
      subjects,
      grades,
      topics,
      sessions,
      videos: readyVideos,
      videosInProgress: uploadingVideos,
      videosFailed: failedVideos,
      files,
    },
    recentVideos: recentVideos.map((video) => ({
      ...toStaffVideoDto(video),
      sessionTitle: video.session.title,
      topicTitle: video.session.topic.title,
    })),
    recentStudents,
    uploadsPerDay,
  };
}

/** System-level statistics for the super admin (spec §41). */
export async function getSystemStats() {
  const now = new Date();
  const [
    videoBytes,
    fileBytes,
    activeDevices,
    sessionsByPortal,
    jobsByStatus,
    failedJobs,
    recentActivity,
    disk,
  ] = await Promise.all([
    prisma.videoAsset.aggregate({ _sum: { sizeBytes: true } }),
    prisma.contentFile.aggregate({ _sum: { sizeBytes: true } }),
    prisma.device.count({ where: { status: 'ACTIVE' } }),
    prisma.authSession.groupBy({
      by: ['portal'],
      where: { revokedAt: null, expiresAt: { gt: now } },
      _count: { _all: true },
    }),
    prisma.uploadJob.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.uploadJob.findMany({
      where: { status: 'FAILED' },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        videoId: true,
        originalFileName: true,
        errorMessage: true,
        attempts: true,
        updatedAt: true,
        video: { select: { title: true } },
      },
    }),
    prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { actor: { select: { name: true, role: true } } },
    }),
    fs.statfs(storageRoot()).catch(() => null),
  ]);

  return {
    storage: {
      videosBytes: Number(videoBytes._sum.sizeBytes ?? 0n),
      filesBytes: Number(fileBytes._sum.sizeBytes ?? 0n),
      diskTotalBytes: disk ? disk.blocks * disk.bsize : null,
      diskFreeBytes: disk ? disk.bavail * disk.bsize : null,
    },
    activeDeviceBindings: activeDevices,
    activeSessions: Object.fromEntries(sessionsByPortal.map((row) => [row.portal, row._count._all])),
    uploadJobs: Object.fromEntries(jobsByStatus.map((row) => [row.status, row._count._all])),
    failedJobs,
    recentActivity,
  };
}
