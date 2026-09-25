import { z } from 'zod';
import { paginationQuery } from './pagination.js';

/** Reusable Zod building blocks for request validation. */

export const uuid = z.uuid();

export const idParams = z.object({ id: uuid });

/** Trimmed, whitespace-collapsed, non-empty display text. */
export const name = (max = 120) =>
  z
    .string()
    .transform((value) => value.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1).max(max));

/** Optional free text: empty strings become null. */
export const optionalText = (max = 5000) =>
  z
    .string()
    .max(max)
    .transform((value) => value.trim() || null)
    .nullish()
    .transform((value) => value ?? null);

/** Lifecycle filter shared by all archivable lists. */
export const lifecycleFilter = z.enum(['active', 'archived', 'all']).default('active');
export type LifecycleFilter = z.infer<typeof lifecycleFilter>;

export function archivedWhere(filter: LifecycleFilter) {
  if (filter === 'active') return { archivedAt: null };
  if (filter === 'archived') return { archivedAt: { not: null } };
  return {};
}

export const searchTerm = z
  .string()
  .max(100)
  .transform((value) => value.trim())
  .optional();

export const listQuery = paginationQuery.extend({
  search: searchTerm,
  status: lifecycleFilter,
});

/** Body for reorder endpoints: ids in their new order. */
export const reorderBody = z.object({
  ids: z.array(uuid).min(1).max(1000),
});
