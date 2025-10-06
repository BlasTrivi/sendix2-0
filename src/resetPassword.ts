// src/resetPassword.ts
import express from "express";
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";

const router = express.Router();
const prisma = new PrismaClient();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_FROM, // ej: blastrivi@gmail.com
    pass: process.env.SMTP_PASS  // clave de app de Gmail
  }
});

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

// POST /api/forgot-password
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Falta el email" });

  const user = await prisma.usuario.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) return res.status(200).json({ ok: true }); // no revela si existe

  const token = generateToken();
  const hash = await bcrypt.hash(token, 10);
  const expires = new Date(Date.now() + 1000 * 60 * 60); // 1 hora

  await prisma.passwordReset.create({
    data: {
      userId: user.id,
      tokenHash: hash,
      expiresAt: expires
    }
  });

  const resetLink = `https://sendix-web.onrender.com/reset-password?token=${token}&email=${encodeURIComponent(email)}`;
  await transporter.sendMail({
    to: email,
    subject: "Recuperación de contraseña - SENDIX",
    html: `<p>Hola ${user.name || ""},</p>
           <p>Para restablecer tu contraseña, hacé clic en el siguiente enlace:</p>
           <p><a href="${resetLink}">${resetLink}</a></p>
           <p>Este enlace es válido por 1 hora.</p>`
  });

  res.json({ ok: true });
});

// POST /api/reset-password
router.post("/reset-password", async (req, res) => {
  const { email, token, password } = req.body;
  if (!email || !token || !password) return res.status(400).json({ error: "Faltan campos" });

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
