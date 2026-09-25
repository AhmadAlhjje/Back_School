# Video system

From the owner's upload to a student watching (online or offline). Code:
`src/modules/videos` (upload API), `src/workers/video` (processing), `src/modules/media`
(delivery) in this backend, and `lib/features/videos` (player, offline) in the Flutter app.

## 1. States

What the dashboards show is deliberately simple:

| Shown                         | Internal                                                              |
| ----------------------------- | --------------------------------------------------------------------- |
| **جاري الرفع X%** (uploading) | chunks arriving (`UploadJob.UPLOADING`), then `QUEUED` / `PROCESSING` |
| **جاهز** (ready)              | `Video.READY`                                                         |
| **فشل** (failed) + retry      | `Video.FAILED` with a stored reason                                   |

Students only ever see `READY`, non-archived videos under open subject + teacher.

## 2. Upload (resumable, chunked)

```
POST /videos                          {sessionId, title, fileName, sizeBytes}  → video + upload job + chunk size
PUT  /videos/:id/upload/chunks/:index application/octet-stream (exact chunk size, last may be shorter)
GET  /videos/:id/upload               → received chunk indexes (resume after a network drop / page reload)
POST /videos/:id/upload/complete      → verifies every chunk is present, queues processing
POST /videos/:id/upload/restart       → new upload for a failed/abandoned video
```

- Chunks (default 8 MB, `UPLOAD_CHUNK_SIZE_MB`) stream straight to `tmp/uploads/<job>/` — a
  multi-hour lesson never sits in memory or in one giant HTTP request.
- Wrong chunk sizes, out-of-range indexes, non-video extensions and oversize totals
  (`MAX_VIDEO_SIZE_GB`) are rejected. Uploads idle for 3 days are cancelled and cleaned up.
- The dashboard upload manager sends chunks one after another, retries a failed chunk with
  exponential backoff, resumes from the server's list of received chunks, and warns before the
  page is closed while uploads are running.

## 3. Processing (worker)

Queue `video`, `VIDEO_WORKER_CONCURRENCY` jobs at a time, 2 attempts with exponential backoff;
permanent errors (not a video, no video stream) fail immediately. With `REDIS_URL` (production)
it is a BullMQ queue consumed by the worker process (`npm run worker`); without it (local
development) the API process runs the same handlers itself and resumes interrupted uploads
from the database when it restarts.

1. **Assemble** chunks into one source file (private work dir).
2. **Probe** with `ffprobe`: duration, resolution, audio presence.
3. **Key**: 16 random bytes + random IV per video; the key file exists only in the work dir.
4. **Transcode + segment + encrypt** in one FFmpeg run: H.264/AAC renditions from
   `HLS_RENDITIONS` (default 360p/720p/1080p, never above the source height), `HLS_SEGMENT_SECONDS`
   (default 6 s) segments, AES-128 via `-hls_key_info_file`, master playlist.
5. **Publish atomically**: the output directory is renamed into `videos/<videoId>/`; the
   content key is stored **sealed with AES-256-GCM** (`MEDIA_KEY_ENCRYPTION_KEY`) in
   `video_assets`; the video becomes `READY` with its duration.
6. **Cleanup** chunks and work files (the original is kept only with `KEEP_ORIGINAL_VIDEOS=true`).
7. **Notify** students who can open this teacher's content (`NEW_LESSON` for the first video of a
   session, `NEW_VIDEO` afterwards), fanned out by the notifications queue.

A maintenance scheduler (same worker) re-queues jobs stuck in `QUEUED` (e.g. Redis flushed),
cancels abandoned uploads, removes orphan temp files, and purges expired auth/offline data.

## 4. Streaming

```
App ── POST /student/videos/:id/playback ──► API
        checks: token → session alive → device bound → student active →
                subject+teacher access → nothing archived → READY
     ◄── { manifestUrl: /media/videos/:id/master.m3u8?token=…, expiresAt }

Player ── master.m3u8?token ──► API (rewrites variant URLs with the same token)
       ── 720p/index.m3u8?token ──► API (rewrites segment URLs + key URI with the token)
       ── key?token ──► API: FULL authorization again, returns the 16-byte key (rate-limited)
       ── seg_00001.ts?token ──► API verifies the token → streams the file (Range support)
```

- The media token (JWT, audience `edu-media`) is bound to video, user, auth session and device;
  its lifetime is `2 × duration + 30 min` (30 min – 12 h). Closing access, disabling the student,
  resetting the device or logging out stops the key endpoint at once, so playback stops at the
  next key/playlist request.
- Segments are useless without the key, and the key is never cached (`Cache-Control: no-store`).
- Staff preview (`POST /videos/:id/preview`) uses the same pipeline without a device binding.

## 5. Offline viewing

```
App ── POST /student/videos/:id/offline-license ──► API (settings.offlineDownloadsEnabled,
                                                     same access checks, device-bound license,
                                                     expires after offlineLicenseDays —
                                                     default 365 = one year, maximum 365)
     ◄── { licenseId, expiresAt, path: {subject, teacher, topic, session},
           renditions: [{height, playlistUrl?token}] }
App downloads: the ~360p playlist, the key (once), every encrypted segment
App stores:   segments as served (still encrypted) in app-private storage,
              the key only in Keychain/Keystore, a playlist rewritten to local names
Playback:     loopback HTTP server on 127.0.0.1:<random>/<random nonce>/ serving playlist,
              key (from memory) and segments; running only while the player is open
Sync:         GET /student/offline-licenses when online → local copies not listed are deleted
```

The app has no separate downloads screen: a downloaded video stays in its place inside its
session (marked "على الجهاز" and played from the device). Without a connection the home screen
lists the downloads grouped by subject and teacher, using the stored `path`.

Revocation paths: owner closes access, super admin resets the device, license expiry, student
deletes the download — all remove the license server-side; the app purges on the next sync and
refuses expired copies even offline.

## 6. Player protection (app)

`FLAG_SECURE` and no audio capture by other apps on Android (recordings are black and silent;
Android 15+ stops the video while recording),
video hidden during screen recording/mirroring on iOS, screenshot notice on iOS, wakelock only
while playing, no background playback. See [security.md](security.md) §4 for limits.

## 7. Tuning

| Setting                                   | Effect                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `FFMPEG_PRESET`                           | `veryfast` default; `faster/fast/medium` = smaller files, more CPU time |
| `HLS_RENDITIONS`                          | fewer renditions = faster processing, less storage                      |
| `VIDEO_WORKER_CONCURRENCY`, `WORKER_CPUS` | parallelism vs. API responsiveness                                      |
| `KEEP_ORIGINAL_VIDEOS`                    | keep sources for future re-encodes (doubles storage)                    |

Storage and processing time depend on the source and the CPU; estimate them by uploading one
typical lesson and reading `du -sh` of its `videos/<id>` folder and the job duration in the worker
logs before sizing the server.
