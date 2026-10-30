import { PrismaClient } from '@prisma/client';

/** The one Prisma client, shared by every service. (A subclass so tests can stand in a differently-built client.) */
export class PrismaService extends PrismaClient {}
