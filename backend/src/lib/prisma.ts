import { PrismaClient } from '@prisma/client';

// Query errors surface as thrown exceptions and are logged by the app's
// structured logger (expected ones, e.g. idempotency-race P2002, are handled).
export const prisma = new PrismaClient();
