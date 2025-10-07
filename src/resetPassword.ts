// src/resetPassword.ts
import express from "express";
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import { Resend } from 'resend';

const router = express.Router();
const prisma = new PrismaClient();

// --- Configuración SMTP ---
// Recomendado: definir SMTP_USER (la cuenta real) y SMTP_PASS (App Password si es Gmail 2FA) y SMTP_FROM (cabecera From legible)
// Fallback: si no hay SMTP_USER, usamos SMTP_FROM como usuario.
const SMTP_USER = process.env.SMTP_USER || process.env.SMTP_FROM;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || SMTP_FROM; // Permitir un remitente distinto para Resend
const isProd = process.env.NODE_ENV === 'production';

let resend: Resend | null = null;
if(RESEND_API_KEY){
  resend = new Resend(RESEND_API_KEY);
  console.log('📧 Resend inicializado como proveedor de email');
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT||587) === 465, // true para 465, false para 587
  auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  logger: !isProd,
  debug: !isProd
});

// Log de configuración SMTP
if(!resend){
  if (!SMTP_USER || !SMTP_PASS) {
    console.warn("⚠️ Sin Resend y SMTP incompleto: faltan RESEND_API_KEY o SMTP_USER/SMTP_PASS. Se simularán envíos.");
  } else {
    transporter.verify().then(()=>{
      console.log('✅ SMTP verificado (fallback) como', SMTP_USER);
    }).catch(err=>{
      console.error('✖ Falló verificación SMTP fallback:', err?.message || err);
    });
  }
}

async function sendResetEmail(to: string, html: string){
  // Prioridad: Resend -> SMTP -> simulación
  if(resend){
    try {
      const r = await resend.emails.send({ from: RESEND_FROM || 'no-reply@sendix', to, subject: 'Recuperación de contraseña - SENDIX', html });
      if(!isProd) console.log('✅ Email (Resend) enviado id:', r.data?.id || r);
      return { provider: 'resend', id: r.data?.id };
    } catch(err:any){
      console.error('❌ Error Resend:', err?.message || err);
      // fallback a SMTP si existe
    }
  }
  if(SMTP_USER && SMTP_PASS){
    try {
      const info = await transporter.sendMail({ from: SMTP_FROM || 'no-reply@sendix', to, subject: 'Recuperación de contraseña - SENDIX', html });
      if(!isProd) console.log('✅ Email (SMTP) enviado id:', info.messageId);
      return { provider: 'smtp', id: info.messageId };
    } catch(err:any){
      console.error('❌ Error SMTP:', err?.message || err);
    }
  }
  // Simulación
  console.warn('⚠️ Simulando envío de reset (sin proveedor disponible)');
  return { provider: 'simulated' };
}

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

// --- Handler reutilizable para forgot ---
async function handleForgot(req: express.Request, res: express.Response){
  if(!req.is('application/json')){
    return res.status(415).json({ error: 'Content-Type debe ser application/json' });
  }
  if(!req.body || typeof req.body !== 'object'){
    return res.status(400).json({ error: 'Body JSON requerido' });
  }
  const { email } = req.body as any;
  if (!email || typeof email !== 'string') return res.status(400).json({ error: "Falta el email" });

  const user = await prisma.usuario.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) return res.status(200).json({ ok: true });

  const token = generateToken();
  const hash = await bcrypt.hash(token, 10);
  const expires = new Date(Date.now() + 1000 * 60 * 60);

  await prisma.passwordReset.create({
    data: {
      userId: user.id,
      tokenHash: hash,
      expiresAt: expires
    }
  });

  // Construcción dinámica del base URL
  const rawBase = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
  // Forzar https si estamos detrás de proxy en prod y base no especifica
  const appBase = (isProd && rawBase.startsWith('http://')) ? rawBase.replace('http://','https://') : rawBase;
  const resetLink = `${appBase.replace(/\/$/,'')}/reset-password?token=${token}&email=${encodeURIComponent(email)}`;

  const safeEmail = email.replace(/(.{2}).+(@.*)/,'$1***$2');
  if(!isProd){
    console.log('📤 Preparando envío reset');
    console.log('   To(ofuscado):', safeEmail);
    console.log('   From header:', SMTP_FROM);
    console.log('   SMTP user usado:', SMTP_USER);
    console.log('   Reset link:', resetLink);
  } else {
    console.log('📤 Solicitud de reset registrada para', safeEmail);
  }
  const html = `<p>Hola ${user.name || ''},</p>
    <p>Para restablecer tu contraseña, hacé clic en el siguiente enlace:</p>
    <p><a href="${resetLink}">${resetLink}</a></p>
    <p>Este enlace es válido por 1 hora.</p>`;
  const result = await sendResetEmail(email, html);
  if(result.provider === 'simulated'){
    return res.json({ ok: true, simulated: true });
  }
  return res.json({ ok: true, provider: result.provider });
}

// POST /api/forgot-password (ruta principal)
router.post("/forgot-password", handleForgot);
// Compat: antiguo endpoint /api/auth/forgot
router.post("/auth/forgot", handleForgot);

// --- Handler reutilizable para reset ---
async function handleReset(req: express.Request, res: express.Response){
  if(!req.is('application/json')){
    return res.status(415).json({ error: 'Content-Type debe ser application/json' });
  }
  if(!req.body || typeof req.body !== 'object'){
    return res.status(400).json({ error: 'Body JSON requerido' });
  }
  const { email, token, password } = req.body as any;
  if(!token || !password || typeof token!=='string' || typeof password!=='string'){
    return res.status(400).json({ error: 'Faltan token o password' });
  }
  let userId: string | null = null;
  let resetRecord: any = null;
  const now = new Date();

  if(email && typeof email === 'string'){
    const user = await prisma.usuario.findUnique({ where: { email: email.toLowerCase() } });
    if(!user) return res.status(400).json({ error: 'Usuario inválido' });
    const records = await prisma.passwordReset.findMany({ where: { userId: user.id, usedAt: null }, orderBy: { createdAt: 'desc' } });
    resetRecord = records.find(r => r.expiresAt > now && bcrypt.compareSync(token, r.tokenHash));
    if(resetRecord) userId = user.id;
  } else {
    // Compat: antiguo flujo no enviaba email de vuelta, buscábamos solo por token
    // Estrategia: escanear un número limitado de registros recientes (ej: 200) para evitar carga excesiva
    const candidates = await prisma.passwordReset.findMany({ where: { usedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' }, take: 200 });
    for(const r of candidates){
      if(bcrypt.compareSync(token, r.tokenHash)){ resetRecord = r; userId = r.userId; break; }
    }
  }

  if(!resetRecord || !userId) return res.status(400).json({ error: 'Token inválido o expirado' });
  if(resetRecord.usedAt){
    return res.status(400).json({ error: 'El enlace ya fue usado. Solicitá uno nuevo.' });
  }
  if(password.length < 8) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });

  const newHash = await bcrypt.hash(password, 10);
  await prisma.usuario.update({ where: { id: userId }, data: { passwordHash: newHash } });
  await prisma.passwordReset.update({ where: { id: resetRecord.id }, data: { usedAt: new Date() } });
  res.json({ ok: true });
}

// POST /api/reset-password (ruta principal)
router.post("/reset-password", handleReset);
// Compat: antiguo endpoint /api/auth/reset
router.post("/auth/reset", handleReset);

export default router;