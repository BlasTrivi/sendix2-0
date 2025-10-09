#!/usr/bin/env node
// Renombra el enum Role de 'sendix' a 'micarga' si aplica y migra filas.
// Idempotente: detecta el estado actual y actúa en consecuencia.

const { PrismaClient } = require('@prisma/client');

async function getEnumState(prisma){
  const rows = await prisma.$queryRawUnsafe(`
    SELECT e.enumlabel
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'Role'
  `);
  const labels = new Set(rows.map(r=> String(r.enumlabel)));
  return { hasSendix: labels.has('sendix'), hasMicarga: labels.has('micarga') };
}

(async()=>{
  const prisma = new PrismaClient();
  try{
    const st = await getEnumState(prisma);
    console.log('[role-to-micarga] Enum Role:', st);
    if(st.hasSendix && !st.hasMicarga){
      // Caso común tras rollback: renombrar etiqueta
      await prisma.$executeRawUnsafe(`ALTER TYPE "Role" RENAME VALUE 'sendix' TO 'micarga'`);
      console.log('[role-to-micarga] ✅ ALTER TYPE Role: sendix -> micarga');
    } else if(st.hasSendix && st.hasMicarga){
      // Ambos existen: migrar filas a 'micarga' y (opcional) eliminar 'sendix'
      await prisma.$executeRawUnsafe(`UPDATE "Usuario" SET "role"='micarga' WHERE "role"::text='sendix'`);
      console.log('[role-to-micarga] ✅ UPDATE filas: sendix -> micarga');
      try{
        await prisma.$executeRawUnsafe(`ALTER TYPE "Role" DROP VALUE 'sendix'`);
        console.log('[role-to-micarga] ✅ DROP VALUE sendix');
      }catch(e){
        console.log('[role-to-micarga] ℹ️ No se pudo DROP VALUE sendix (versión de Postgres o uso residual). Continuo.');
      }
    } else {
      console.log('[role-to-micarga] ℹ️ Enum ya está en micarga o no requiere cambios.');
    }
  }catch(err){
    console.log('[role-to-micarga] ⚠️ Error no crítico:', err?.message||String(err));
  }finally{
    await prisma.$disconnect().catch(()=>{});
  }
})();
