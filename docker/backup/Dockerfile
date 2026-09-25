# syntax=docker/dockerfile:1.7
#
# Scheduled MySQL backups (build context: the backend folder). Uses the MySQL image for a
# mysqldump that matches the server version, and database/scripts for the logic (rotation,
# checksums, verification) that also works outside Docker.
ARG MYSQL_IMAGE=mysql:8.4
FROM ${MYSQL_IMAGE}
RUN microdnf install -y gzip findutils && microdnf clean all
COPY database/scripts/backup.sh database/scripts/restore.sh database/scripts/verify-backup.sh /opt/edu/
COPY deploy/backup/scheduler.sh /opt/edu/scheduler.sh
RUN chmod +x /opt/edu/*.sh
ENV BACKUP_DIR=/backups
ENTRYPOINT ["/opt/edu/scheduler.sh"]
