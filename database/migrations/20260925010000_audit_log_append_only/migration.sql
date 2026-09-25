-- Audit logs are append-only (spec: immutable audit trail). The application never updates or
-- deletes them; these triggers make the database refuse it too, whoever connects.
-- Prisma does not model triggers, so later schema diffs leave them untouched.

CREATE TRIGGER `audit_logs_block_update` BEFORE UPDATE ON `audit_logs`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';

CREATE TRIGGER `audit_logs_block_delete` BEFORE DELETE ON `audit_logs`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';
