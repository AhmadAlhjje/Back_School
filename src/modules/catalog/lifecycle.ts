import { AuditAction, writeAudit, type AuditActor } from '../../core/audit/audit.js';
import { prisma, type Tx } from '../../core/database/prisma.js';
import { AppError, notFound } from '../../core/errors/app-error.js';

/**
 * Shared soft-delete and ordering mechanics for catalog entities. Nothing is ever hard-deleted:
 * archiving stamps `archivedAt`, restoring clears it. Descendants are not touched; they become
 * invisible to students because every student query requires the whole ancestor chain to be active.
 */
interface LifecycleOptions {
  entityType: string;
  id: string;
  actor: AuditActor;
  load: (tx: Tx) => Promise<{ archivedAt: Date | null } | null>;
  save: (tx: Tx, archivedAt: Date | null) => Promise<unknown>;
  /** For restore: returns false when the parent is archived (restoring would be meaningless). */
  parentIsActive?: (tx: Tx) => Promise<boolean>;
}

export async function archiveEntity(options: LifecycleOptions): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const current = await options.load(tx);
    if (!current) throw notFound(options.entityType);
    if (current.archivedAt) return;
    await options.save(tx, new Date());
    await writeAudit(tx, options.actor, {
      action: AuditAction.ARCHIVE,
      entityType: options.entityType,
      entityId: options.id,
    });
  });
}

export async function restoreEntity(options: LifecycleOptions): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const current = await options.load(tx);
    if (!current) throw notFound(options.entityType);
    if (!current.archivedAt) return;
    if (options.parentIsActive && !(await options.parentIsActive(tx))) throw new AppError('PARENT_ARCHIVED');
    await options.save(tx, null);
    await writeAudit(tx, options.actor, {
      action: AuditAction.RESTORE,
      entityType: options.entityType,
      entityId: options.id,
    });
  });
}

/**
 * Applies a new order. `ids` must be exactly the set of siblings the caller is allowed to order
 * (validated by `siblingIds`), each gets `sortOrder = position`.
 */
export async function reorderEntities(options: {
  entityType: string;
  ids: string[];
  actor: AuditActor;
  parentId: string | null;
  siblingIds: (tx: Tx) => Promise<string[]>;
  setOrder: (tx: Tx, id: string, sortOrder: number) => Promise<unknown>;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const siblings = new Set(await options.siblingIds(tx));
    const unique = new Set(options.ids);
    if (unique.size !== options.ids.length || options.ids.some((id) => !siblings.has(id))) {
      throw new AppError('VALIDATION_ERROR', { details: { reason: 'IDS_DO_NOT_MATCH_SIBLINGS' } });
    }
    for (const [index, id] of options.ids.entries()) {
      await options.setOrder(tx, id, index + 1);
    }
    await writeAudit(tx, options.actor, {
      action: AuditAction.REORDER,
      entityType: options.entityType,
      entityId: options.parentId ?? undefined,
      metadata: { ids: options.ids },
    });
  });
}

/** Next sortOrder value at the end of a sibling list. */
export function nextSortOrder(current: { _max: { sortOrder: number | null } }): number {
  return (current._max.sortOrder ?? 0) + 1;
}

/** Audit metadata for an update: only the fields that actually changed. */
export function changedFields<T extends object>(before: T, patch: Partial<T>): Record<string, unknown> {
  const previous = before as Record<string, unknown>;
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && previous[key] !== value)
      changes[key] = { from: previous[key] ?? null, to: value };
  }
  return changes;
}
