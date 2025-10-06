// src/resetPassword.ts
import express from "express";
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";

const router = express.Router();
const prisma = new PrismaClient();

// --- Configuración SMTP ---
// Recomendado: definir SMTP_USER (la cuenta real) y SMTP_PASS (App Password si es Gmail 2FA) y SMTP_FROM (cabecera From legible)
// Fallback: si no hay SMTP_USER, usamos SMTP_FROM como usuario.
const SMTP_USER = process.env.SMTP_USER || process.env.SMTP_FROM;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT||587) === 465, // true para 465, false para 587
  auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  logger: true,
  debug: true
});

// Log de configuración SMTP
if (!SMTP_USER || !SMTP_PASS) {
  console.warn("⚠️ SMTP incompleto: faltan SMTP_USER/SMTP_FROM o SMTP_PASS. No se enviarán correos.");
} else {
  // Verificación asíncrona inicial (no bloqueante para la API, pero loggea resultado)
  transporter.verify().then(()=>{
    console.log('✅ SMTP verificado (resetPassword router) como', SMTP_USER);
  }).catch(err=>{
    console.error('✖ Falló verificación SMTP:', err?.message || err);
  });
}

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

// POST /api/forgot-password
router.post("/forgot-password", async (req, res) => {
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

  const resetLink = `https://sendix-web.onrender.com/reset-password?token=${token}&email=${encodeURIComponent(email)}`;

  console.log('📤 Preparando envío reset');
  console.log('   To:', email);
  console.log('   From header:', SMTP_FROM);
  console.log('   SMTP user usado:', SMTP_USER);
  console.log('   Reset link:', resetLink);
  if(!SMTP_USER || !SMTP_PASS){
    console.warn('   ⚠️ SMTP incompleto: se simula éxito sin enviar.');
    return res.json({ ok: true, simulated: true });
  }

  try {
    const info = await transporter.sendMail({
      from: SMTP_FROM,
      to: email,
      subject: "Recuperación de contraseña - SENDIX",
      html: `<p>Hola ${user.name || ''},</p>
             <p>Para restablecer tu contraseña, hacé clic en el siguiente enlace:</p>
             <p><a href="${resetLink}">${resetLink}</a></p>
             <p>Este enlace es válido por 1 hora.</p>`
    });
    console.log('✅ Email enviado. MessageID:', info.messageId, '| response:', info.response);
  } catch (err) {
    console.error("❌ Error al enviar el email:", (err as any)?.message || err);
    if((err as any)?.response){ console.error('   ↳ SMTP response:', (err as any).response); }
    if((err as any)?.code){ console.error('   ↳ Code:', (err as any).code); }
    return res.status(500).json({ error: "No se pudo enviar el mail de recuperación." });
  }

  res.json({ ok: true });
});

// POST /api/reset-password
router.post("/reset-password", async (req, res) => {
  if(!req.is('application/json')){
    return res.status(415).json({ error: 'Content-Type debe ser application/json' });
  }
  if(!req.body || typeof req.body !== 'object'){
    return res.status(400).json({ error: 'Body JSON requerido' });
  }
  const { email, token, password } = req.body as any;
  if (!email || !token || !password || typeof email!=='string' || typeof token!=='string' || typeof password!=='string') return res.status(400).json({ error: "Faltan campos" });

  const user = await prisma.usuario.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) return res.status(400).json({ error: "Usuario inválido" });

  const records = await prisma.passwordReset.findMany({
    where: { userId: user.id, usedAt: null },
    orderBy: { createdAt: "desc" }
  });

  const valid = records.find(r => r.expiresAt > new Date() && bcrypt.compareSync(token, r.tokenHash));
  if (!valid) return res.status(400).json({ error: "Token inválido o expirado" });

  const newHash = await bcrypt.hash(password, 10);
  await prisma.usuario.update({ where: { id: user.id }, data: { passwordHash: newHash } });
  await prisma.passwordReset.update({ where: { id: valid.id }, data: { usedAt: new Date() } });

  res.json({ ok: true });
});

export default router;