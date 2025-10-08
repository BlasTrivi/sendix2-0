#!/usr/bin/env node
// Ejecuta prisma db push solo si DATABASE_URL está definida y accesible.
// Evita fallar el build por ausencia de la variable en entornos donde
// solo se necesita compilar TypeScript.

const { execSync } = require('node:child_process');

function log(msg){ process.stdout.write(`[ensure-db] ${msg}\n`); }

const url = process.env.DATABASE_URL;
if(!url){
  log('DATABASE_URL no definida. Omitiendo prisma db push.');
  process.exit(0);
}
try {
  log('Ejecutando prisma db push...');
  execSync('npx prisma db push', { stdio: 'inherit' });
  log('Listo.');
} catch (e) {
  log('Fallo prisma db push (no crítico para arrancar si schema sin cambios).');
  // No forzamos exit code 1 para no romper el arranque si es transitorio
  process.exit(0);
}
