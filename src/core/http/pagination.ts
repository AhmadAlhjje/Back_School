import { z } from 'zod';

export const MAX_PAGE_SIZE = 100;

/** Standard `page` / `limit` query parameters. */
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
});

export type PaginationQuery = z.infer<typeof paginationQuery>;

export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function paginated<T>(items: T[], total: number, { page, limit }: PaginationQuery): Paginated<T> {
  return { items, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

export function skipTake({ page, limit }: PaginationQuery) {
  return { skip: (page - 1) * limit, take: limit };
}
