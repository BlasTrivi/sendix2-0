#!/usr/bin/env node
// Limpia datos generados durante pruebas (cargas, propuestas, hilos, mensajes, comisiones, sesiones, etc.).
// Opcional: preservar un usuario admin MICARGA (KEEP_ADMIN_EMAIL).
// Uso:
//   DATABASE_URL=... KEEP_ADMIN_EMAIL=admin@micarga.com npm run wipe:db
// Sin KEEP_ADMIN_EMAIL, elimina todos los usuarios.

const readline = require('node:readline');
const { PrismaClient } = require('@prisma/client');

function ask(question){
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve)=> rl.question(question, (ans)=>{ rl.close(); resolve(ans); }));
}

function log(msg){ process.stdout.write(`[wipe-db] ${msg}\n`); }

(async()=>{
  if(!process.env.DATABASE_URL){
    log('ERROR: Definí DATABASE_URL para apuntar a la base a limpiar. Abortando.');
    process.exit(1);
  }
  const keepEmail = (process.env.KEEP_ADMIN_EMAIL||'').trim().toLowerCase();
  const prisma = new PrismaClient();
  try{
    log(`Base: ${process.env.DATABASE_URL.split('@').pop()}`);
    if(keepEmail){ log(`Preservar usuario con email: ${keepEmail}`); }
    const ans = (await ask('Esto borrará datos. Escribí "BORRAR" para confirmar: ')).trim();
    if(ans !== 'BORRAR'){
      log('Cancelado por el usuario.');
      process.exit(0);
    }

    // (1) Info previa
    const countsBefore = await prisma.$transaction([
      prisma.usuario.count(),
      prisma.load.count(),
      prisma.proposal.count(),
      prisma.thread.count(),
      prisma.message.count(),
      prisma.read.count(),
      prisma.commission.count(),
      prisma.passwordReset.count(),
      prisma.emailVerification.count(),
      prisma.session.count(),
    ]);
    log(`Antes: usuarios=${countsBefore[0]}, loads=${countsBefore[1]}, proposals=${countsBefore[2]}, threads=${countsBefore[3]}, messages=${countsBefore[4]}, reads=${countsBefore[5]}, commissions=${countsBefore[6]}, resets=${countsBefore[7]}, verifs=${countsBefore[8]}, sessions=${countsBefore[9]}`);

    // (2) Borrado en orden seguro (dependencias primero)
    await prisma.$transaction([
      prisma.message.deleteMany({}),
      prisma.read.deleteMany({}),
      prisma.thread.deleteMany({}),
      prisma.commission.deleteMany({}),
      prisma.proposal.deleteMany({}),
      prisma.load.deleteMany({}),
      prisma.passwordReset.deleteMany({}),
      prisma.emailVerification.deleteMany({}),
      prisma.session.deleteMany({}),
    ]);

    if(keepEmail){
      // Eliminar todos menos el admin MICARGA indicado
      await prisma.usuario.deleteMany({ where: { email: { not: keepEmail } } });
      // Normalizar rol a micarga si es necesario
      try{
        await prisma.usuario.updateMany({ where: { email: keepEmail }, data: { role: 'micarga' } });
      }catch{}
    } else {
      await prisma.usuario.deleteMany({});
    }

    // (3) Info posterior
    const countsAfter = await prisma.$transaction([
      prisma.usuario.count(),
      prisma.load.count(),
      prisma.proposal.count(),
      prisma.thread.count(),
      prisma.message.count(),
      prisma.read.count(),
      prisma.commission.count(),
      prisma.passwordReset.count(),
      prisma.emailVerification.count(),
      prisma.session.count(),
    ]);
    log(`Después: usuarios=${countsAfter[0]}, loads=${countsAfter[1]}, proposals=${countsAfter[2]}, threads=${countsAfter[3]}, messages=${countsAfter[4]}, reads=${countsAfter[5]}, commissions=${countsAfter[6]}, resets=${countsAfter[7]}, verifs=${countsAfter[8]}, sessions=${countsAfter[9]}`);
    log('✔ Limpieza completada.');
  }catch(err){
    console.error('[wipe-db] Error:', err?.message||err);
    process.exitCode = 1;
  }finally{
    await prisma.$disconnect().catch(()=>{});
  }
})();
