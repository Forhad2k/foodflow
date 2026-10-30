import type { Prisma } from '@prisma/client';

/** Either the root client or a transaction client: services take this so they run in either context. */
export type Db = Prisma.TransactionClient;
