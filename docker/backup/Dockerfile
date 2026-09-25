# syntax=docker/dockerfile:1.7
#
# Scheduled database backups (build context: the backend folder), used by docker-compose.yml.
# Uses the MariaDB image for a dump tool that matches the server version, and database/scripts
# for the logic (rotation, checksums, verification) that also works outside Docker.
ARG MARIADB_IMAGE=mariadb:11.4
FROM ${MARIADB_IMAGE}
COPY database/scripts/backup.sh database/scripts/restore.sh database/scripts/verify-backup.sh /opt/edu/
COPY docker/backup/scheduler.sh /opt/edu/scheduler.sh
RUN chmod +x /opt/edu/*.sh
ENV BACKUP_DIR=/backups \
    MYSQLDUMP=mariadb-dump \
    MYSQL=mariadb
ENTRYPOINT ["/opt/edu/scheduler.sh"]
