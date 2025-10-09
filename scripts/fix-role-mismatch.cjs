#!/usr/bin/env node
// Corrige enum/datos: vuelve de 'micarga' -> 'sendix' según el estado del tipo en Postgres.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function getEnumState(){
  const rows = await prisma.$queryRawUnsafe(`
    SELECT e.enumlabel AS label
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'Role'
  `);
  const labels = new Set((rows||[]).map(r=>r.label));
  return { hasSendix: labels.has('sendix'), hasMicarga: labels.has('micarga') };
}

async function countMicarga(){
  const row = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS c FROM "Usuario" WHERE "role"::text = 'micarga'`);
  return row && row[0] ? row[0].c : 0;
}

(async()=>{
  try{
    const st = await getEnumState();
    console.log('Enum Role:', st);
    if(st.hasMicarga && !st.hasSendix){
      // El tipo solo tiene 'micarga' (renombre previo). Volver a 'sendix'.
      await prisma.$executeRawUnsafe(`ALTER TYPE "Role" RENAME VALUE 'micarga' TO 'sendix'`);
      console.log('✅ ALTER TYPE Role: micarga -> sendix');
      return;
    }
    if(st.hasMicarga && st.hasSendix){
      // Ambos existen: mover filas a sendix.
      const before = await countMicarga();
      console.log(`Micarga rows antes: ${before}`);
      if(before>0){
        await prisma.$executeRawUnsafe(`UPDATE "Usuario" SET "role"='sendix' WHERE "role"::text='micarga'`);
        const after = await countMicarga();
        console.log(`Micarga rows después: ${after}`);
        console.log(`Actualizadas: ${before - after}`);
      } else {
        console.log('No hay filas con role=micarga. Nada que hacer.');
      }
      return;
    }
    console.log('ℹ️ Enum no tiene micarga; no hay nada que revertir.');
  } catch(e){
    console.error('Error corrigiendo roles:', e?.message || e);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
