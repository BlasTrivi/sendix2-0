// Augment PrismaClient types to include PasswordReset delegate when the generated client types lag behind schema
import type { Prisma } from '@prisma/client'
declare module '@prisma/client' {
  interface PrismaClient {
    passwordReset: Prisma.PasswordResetDelegate<Prisma.DefaultArgs>
  }
}
