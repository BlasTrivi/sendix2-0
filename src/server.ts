import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient, Prisma } from '@prisma/client';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import http from 'node:http';
import { Server as SocketIOServer } from 'socket.io';

const app = express();
const prisma = new PrismaClient();

// Middlewares
// Confiar en el proxy (Heroku/Render/Vercel/Nginx) para que req.protocol refleje HTTPS
// y las cookies 'secure' funcionen correctamente detrás de un proxy TLS
app.set('trust proxy', 1);
app.use(express.json());
app.use(cookieParser());

// CORS configurable por variable de entorno (lista separada por comas)
const rawOrigins = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const corsOrigins = rawOrigins.length > 0 ? rawOrigins : undefined;
// Si no hay orígenes configurados, reflejamos el Origin del request (origin:true) para permitir credenciales en dev
app.use(corsOrigins ? cors({ origin: corsOrigins, credentials: true }) : cors({ origin: true, credentials: true }));
// Refuerzo: indicar explícitamente que permitimos credenciales en todas las respuestas
app.use((req, res, next)=>{
  if(req.headers.origin && (corsOrigins ? corsOrigins.includes(req.headers.origin) : true)){
    res.header('Access-Control-Allow-Credentials', 'true');
  }
  next();
});

// ---- API ----
// ---- Auth (opcional) ----
type JwtUser = { id: string; email: string; name: string; role: 'empresa'|'transportista'|'sendix' };
declare global {
  namespace Express { interface Request { user?: JwtUser | null; } }
}

// Aceptar JWT_SECRET o JWT_ACCESS_SECRET (compatibilidad con .env existente)
const JWT_SECRET = process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET || 'dev-secret';
const AUTH_REQUIRED = (process.env.AUTH_REQUIRED || 'false').toLowerCase() === 'true';
// Cookie SameSite configurable: lax | none | strict
// Si se configura CORS_ORIGIN (frontend distinto dominio), por defecto usamos 'none' para que el navegador envíe cookies cross-site.
const DEFAULT_SAMESITE = (process.env.COOKIE_SAMESITE
  || (rawOrigins.length > 0 ? 'none' : 'lax'))
  .toLowerCase();
const COOKIE_SAMESITE = DEFAULT_SAMESITE;
type SameSiteOpt = 'lax' | 'none' | 'strict';
function getCookieOpts(){
  const sameSite = (['lax','none','strict'].includes(COOKIE_SAMESITE) ? COOKIE_SAMESITE : 'lax') as SameSiteOpt;
  const secure = (process.env.NODE_ENV === 'production') || sameSite === 'none';
  return { httpOnly: true, sameSite, secure, maxAge: 7*24*60*60*1000 } as const;
}

function signToken(u: JwtUser){
  return jwt.sign(u, JWT_SECRET, { expiresIn: '7d' });
}

function decodeAuth(req: express.Request, _res: express.Response, next: express.NextFunction){
  try{
    const h = req.headers['authorization'] || '';
    let token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if(!token){
      const fromCookie = (req as any).cookies?.token;
      if(fromCookie && typeof fromCookie === 'string') token = fromCookie;
    }
    if(token){
      const payload = jwt.verify(token, JWT_SECRET) as JwtUser;
      req.user = payload;
    } else req.user = null;
  }catch{ req.user = null; }
  next();
}

function requireRole(role: JwtUser['role']){
  return (req: express.Request, res: express.Response, next: express.NextFunction)=>{
    if(!AUTH_REQUIRED) return next();
    if(!req.user) return res.status(401).json({ error: 'Auth required' });
    if(req.user.role !== role) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

app.use(decodeAuth);

// --- Socket.IO ---
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: corsOrigins ? { origin: corsOrigins, credentials: true } : { origin: true, credentials: true }
});

function parseCookieHeader(cookieHeader?: string){
  const out: Record<string,string> = {};
  if(!cookieHeader) return out;
  cookieHeader.split(';').forEach(part=>{
    const idx = part.indexOf('=');
    if(idx>0){ const k = part.slice(0,idx).trim(); const v = decodeURIComponent(part.slice(idx+1).trim()); out[k]=v; }
  });
  return out;
}

io.use((socket, next)=>{
  try{
    const cookies = parseCookieHeader(socket.handshake.headers.cookie as string|undefined);
    const token = cookies['token'];
    if(token){
      const payload = jwt.verify(token, JWT_SECRET) as JwtUser;
      (socket.data as any).user = payload;
    }
    next();
  }catch(err){ next(); }
});

io.on('connection', (socket)=>{
  const u = (socket.data as any).user as JwtUser | undefined;
  socket.on('chat:join', async (payload: { proposalId: string })=>{
    try{
      const id = String(payload?.proposalId||'');
      if(!id) return;
      const p = await prisma.proposal.findUnique({ where: { id }, include: { load: true } });
      if(!p) return;
      if(!userCanAccessProposal(u, p as any)) return;
      socket.join(`proposal:${id}`);
    }catch{}
  });
  socket.on('chat:joinMany', async (payload: { proposalIds: string[] })=>{
    try{
      const ids = Array.isArray(payload?.proposalIds) ? payload.proposalIds : [];
      if(!ids.length) return;
      const rows = await prisma.proposal.findMany({ where: { id: { in: ids } }, include: { load: true } });
      rows.forEach(p=>{ if(userCanAccessProposal(u, p as any)) socket.join(`proposal:${p.id}`); });
    }catch{}
  });
});

// Validaciones comunes (datos de perfil)
const PhoneSchema = z.string().trim().min(6).max(32).regex(/^[+0-9()\-\s]+$/, 'Formato de teléfono inválido');
const TaxIdSchema = z.string().trim().min(6).max(32).regex(/^[0-9A-Za-z.\-]+$/, 'Formato de documento inválido');
const DniSchema = z.string().trim().min(6).max(20).regex(/^[0-9A-Za-z.\-]+$/, 'Formato de DNI inválido');
const CARGAS = ['Contenedor','Granel','Carga general','Flete'] as const;
const VEHICULOS = ['Liviana','Mediana','Pesada'] as const;
const TransportistaPerfilSchema = z.object({
  cargas: z.array(z.enum(CARGAS)).nonempty('Elegí al menos un tipo de carga'),
  vehiculos: z.array(z.enum(VEHICULOS)).nonempty('Elegí al menos un tipo de vehículo'),
  alcance: z.string().trim().max(200).optional().nullable(),
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  dni: DniSchema,
  seguroOk: z.boolean().optional(),
  tipoSeguro: z.string().trim().max(120).optional().nullable(),
  senasa: z.boolean().optional(),
  imo: z.boolean().optional(),
});
const TransportistaPerfilPartialSchema = TransportistaPerfilSchema.partial();

const strongPassword = z.string().min(8)
  .refine(v=> /[A-Z]/.test(v), 'Debe incluir al menos una mayúscula')
  .refine(v=> /[a-z]/.test(v), 'Debe incluir al menos una minúscula')
  .refine(v=> /[0-9]/.test(v), 'Debe incluir al menos un número');
const RegisterSchema = z.object({
  email: z.string().email(),
  password: strongPassword,
  role: z.enum(['empresa','transportista']).default('empresa'),
  name: z.string().min(1),
  phone: PhoneSchema.optional().nullable(),
  taxId: TaxIdSchema.optional().nullable(),
  perfil: z.any().optional()
}).superRefine((val, ctx)=>{
  if(val.role === 'transportista'){
    const res = TransportistaPerfilSchema.safeParse(val.perfil);
    if(!res.success){ res.error.issues.forEach(i=> ctx.addIssue({ ...i })); }
  }
});
app.post('/api/auth/register', async (req, res)=>{
  try{
    const body = RegisterSchema.parse(req.body);
    const exists = await prisma.usuario.findUnique({ where: { email: body.email.toLowerCase() } });
    if(exists) return res.status(409).json({ error: 'Email ya registrado' });
    const hash = await bcrypt.hash(body.password, 10);
  const phoneNorm = (body.phone ?? undefined) ? String(body.phone).trim() : undefined;
  const taxNorm = (body.taxId ?? undefined) ? String(body.taxId).trim() : undefined;
  const user = await prisma.usuario.create({ data: { email: body.email.toLowerCase(), passwordHash: hash, role: body.role, name: body.name.trim(), phone: phoneNorm || undefined, taxId: taxNorm || undefined, perfilJson: body.perfil ?? undefined } });
  const token = signToken({ id: user.id, email: user.email, name: user.name, role: user.role as any });
  res.cookie('token', token, getCookieOpts());
    res.status(201).json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, phone: user.phone, taxId: user.taxId, perfil: user.perfilJson } });
  }catch(err:any){ res.status(400).json({ error: err?.message || String(err) }); }
});

const LoginSchema = z.object({ email: z.string().email(), password: z.string().min(6) });
app.post('/api/auth/login', async (req, res)=>{
  try{
    const { email, password } = LoginSchema.parse(req.body);
    const user = await prisma.usuario.findUnique({ where: { email: email.toLowerCase() } });
    if(!user) return res.status(401).json({ error: 'Credenciales inválidas' });
    const ok = await bcrypt.compare(password, user.passwordHash || '');
    if(!ok) return res.status(401).json({ error: 'Credenciales inválidas' });
  const token = signToken({ id: user.id, email: user.email, name: user.name, role: user.role as any });
  res.cookie('token', token, getCookieOpts());
    res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, phone: user.phone, taxId: user.taxId, perfil: user.perfilJson } });
  }catch(err:any){ res.status(400).json({ error: err?.message || String(err) }); }
});

app.post('/api/auth/logout', (_req, res)=>{
  const opts = getCookieOpts();
  res.clearCookie('token', { httpOnly: true, sameSite: opts.sameSite, secure: opts.secure });
  res.json({ ok: true });
});

app.get('/api/me', async (req, res)=>{
  if(!req.user) return res.status(200).json({ user: null });
  const db = await prisma.usuario.findUnique({ where: { id: req.user.id } });
  if(!db) return res.status(200).json({ user: null });
  res.json({ user: { id: db.id, email: db.email, name: db.name, role: db.role, phone: db.phone, taxId: db.taxId, perfil: db.perfilJson } });
});

// Actualizar perfil (validación por rol)
const ProfileUpdateBase = z.object({ name: z.string().min(1).optional() });
const EmpresaProfileUpdate = ProfileUpdateBase.extend({
  phone: PhoneSchema.optional().nullable(),
  taxId: TaxIdSchema.optional().nullable(),
});
const TransportistaProfileUpdate = ProfileUpdateBase.extend({
  perfil: TransportistaPerfilPartialSchema.optional(),
});
app.patch('/api/profile', async (req, res)=>{
  if(!req.user) return res.status(401).json({ error: 'Auth required' });
  try{
    const role = req.user.role;
    let data: any = {};
    if(role === 'empresa'){
      const body = EmpresaProfileUpdate.parse(req.body);
      const phoneNorm = body.phone===null ? null : (body.phone ? String(body.phone).trim() : undefined);
      const taxNorm = body.taxId===null ? null : (body.taxId ? String(body.taxId).trim() : undefined);
      data = { name: body.name ?? undefined, phone: phoneNorm, taxId: taxNorm };
    } else if(role === 'transportista'){
      const body = TransportistaProfileUpdate.parse(req.body);
      data = { name: body.name ?? undefined, perfilJson: body.perfil ?? undefined };
    } else {
      const body = ProfileUpdateBase.parse(req.body);
      data = { name: body.name ?? undefined };
    }
    const upd = await prisma.usuario.update({ where: { id: req.user.id }, data });
    res.json({ user: { id: upd.id, email: upd.email, name: upd.name, role: upd.role, phone: upd.phone, taxId: upd.taxId, perfil: upd.perfilJson } });
  }catch(err:any){ res.status(400).json({ error: err?.message || String(err) }); }
});

// Recuperación de contraseña
const ForgotSchema = z.object({ email: z.string().email() });
app.post('/api/auth/forgot', async (req, res)=>{
  try{
    const { email } = ForgotSchema.parse(req.body);
    const user = await prisma.usuario.findUnique({ where: { email: email.toLowerCase() } });
    if(!user){ return res.json({ ok: true }); }
    // Invalida tokens anteriores
    await prisma.passwordReset.updateMany({ where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 60*60*1000);
  // TS puede no ver el delegado si el cliente no se regeneró aún; usar any para evitar error de tipo
    await prisma.passwordReset.create({ data: { userId: user.id, tokenHash, expiresAt } });
    const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const resetUrl = `${base}/reset-password?token=${token}`;

    // Envío de email
    try{
      const smtpHost = process.env.SMTP_HOST;
      const smtpPort = Number(process.env.SMTP_PORT||'0') || 587;
      const smtpUser = process.env.SMTP_USER;
      const smtpPass = process.env.SMTP_PASS;
      if(smtpHost && smtpUser && smtpPass){
        const transporter = nodemailer.createTransport({ host: smtpHost, port: smtpPort, secure: smtpPort===465, auth: { user: smtpUser, pass: smtpPass } });
        await transporter.sendMail({ from: process.env.SMTP_FROM || 'no-reply@sendix', to: user.email, subject: 'Recuperar contraseña', text: `Para restablecer tu contraseña, visitá: ${resetUrl}`, html: `<p>Para restablecer tu contraseña, hacé clic: <a href="${resetUrl}">Restablecer</a></p>` });
      } else {
        console.log('⚠️ SMTP no configurado. Link de reset:', resetUrl);
      }
    }catch(err){ console.error('Error enviando email de reset', err); }
    res.json({ ok: true });
  }catch(err:any){ res.status(400).json({ error: err?.message || String(err) }); }
});

const ResetSchema = z.object({ token: z.string().min(10), password: z.string().min(6) });
app.post('/api/auth/reset', async (req, res)=>{
  try{
    const { token, password } = ResetSchema.parse(req.body);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const now = new Date();
    const rec = await prisma.passwordReset.findFirst({ where: { tokenHash, usedAt: null, expiresAt: { gt: now } }, include: { user: true } });
    if(!rec) return res.status(400).json({ error: 'Token inválido o expirado' });
    // Reforzar política aquí también
    if(password.length < 8) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
    const hash = await bcrypt.hash(password, 10);
    await prisma.$transaction([
      prisma.usuario.update({ where: { id: rec.userId }, data: { passwordHash: hash } }),
      prisma.passwordReset.update({ where: { id: rec.id }, data: { usedAt: now } })
    ]);
    // Auto-login tras reset: emitir cookie
    const u = rec.user;
    const tokenJwt = signToken({ id: u.id, email: u.email, name: u.name, role: u.role as any });
    res.cookie('token', tokenJwt, getCookieOpts());
    res.json({ ok: true, user: { id: u.id, email: u.email, name: u.name, role: u.role, phone: u.phone, taxId: u.taxId, perfil: u.perfilJson } });
  }catch(err:any){ res.status(400).json({ error: err?.message || String(err) }); }
});
// Health: siempre 200. Indica dbOk para readiness real
app.get('/health', async (_req, res) => {
  try {
    const now = await prisma.$queryRaw`SELECT NOW()`;
    res.status(200).json({ ok: true, dbOk: true, dbTime: now, serverTime: new Date().toISOString() });
  } catch (err) {
    res.status(200).json({ ok: true, dbOk: false, error: String(err), serverTime: new Date().toISOString() });
  }
});

// Liveness puro (sin tocar DB)
app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, serverTime: new Date().toISOString() });
});

// ---- API: Loads ----
const LoadCreateSchema = z.object({
  ownerEmail: z.string().email(),
  ownerName: z.string().min(1),
  origen: z.string().min(1),
  destino: z.string().min(1),
  tipo: z.string().min(1),
  cantidad: z.number().nullable().optional(),
  unidad: z.string().optional().default(''),
  dimensiones: z.string().optional().default(''),
  peso: z.number().nullable().optional(),
  volumen: z.number().nullable().optional(),
  fechaHora: z.string().nullable().optional(),
  descripcion: z.string().optional().default(''),
  attachments: z.any().optional()
});

const LoadUpdateSchema = LoadCreateSchema.partial().omit({ ownerEmail: true, ownerName: true });

async function ensureEmpresaUser(email: string, name: string){
  const byEmail = await prisma.usuario.findUnique({ where: { email } });
  if(byEmail) return byEmail;
  // Usuario mínimo para relacionar cargas (demo)
  return prisma.usuario.create({
    data: {
      email,
      name,
      role: 'empresa',
      passwordHash: 'demo',
    }
  });
}

async function ensureCarrierUser(email: string, name: string){
  const byEmail = await prisma.usuario.findUnique({ where: { email } });
  if(byEmail) return byEmail;
  return prisma.usuario.create({
    data: {
      email,
      name,
      role: 'transportista',
      passwordHash: 'demo',
    }
  });
}

// Crear carga
app.post('/api/loads', requireRole('empresa'), async (req, res) => {
  try {
    const body = LoadCreateSchema.parse(req.body);
    const owner = await ensureEmpresaUser(body.ownerEmail.toLowerCase(), body.ownerName);
    const created = await prisma.load.create({
      data: {
        ownerId: owner.id,
        origen: body.origen,
        destino: body.destino,
        tipo: body.tipo,
        cantidad: body.cantidad ?? undefined,
        unidad: body.unidad || undefined,
        dimensiones: body.dimensiones || undefined,
        peso: body.peso ?? undefined,
        volumen: body.volumen ?? undefined,
        fechaHora: body.fechaHora ? new Date(body.fechaHora) : undefined,
        descripcion: body.descripcion || undefined,
        attachments: body.attachments ?? undefined
      },
      include: { owner: { select: { id: true, name: true, email: true } } }
    });
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

// Listar cargas (opcional filtro por ownerEmail)
app.get('/api/loads', async (req, res) => {
  try {
    const ownerEmail = String(req.query.ownerEmail || '').toLowerCase();
    const where = ownerEmail ? { owner: { email: ownerEmail } } : {};
    const rows = await prisma.load.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { owner: { select: { id: true, name: true, email: true } } }
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Obtener carga por id
app.get('/api/loads/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    const row = await prisma.load.findUnique({ where: { id }, include: { owner: { select: { id: true, name: true, email: true } } } });
    if(!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Actualizar carga
app.patch('/api/loads/:id', requireRole('empresa'), async (req, res) => {
  try {
    const id = String(req.params.id);
    const data = LoadUpdateSchema.parse(req.body);
    const updated = await prisma.load.update({
      where: { id },
      data: {
        origen: data.origen ?? undefined,
        destino: data.destino ?? undefined,
        tipo: data.tipo ?? undefined,
        cantidad: data.cantidad ?? undefined,
        unidad: data.unidad ?? undefined,
        dimensiones: data.dimensiones ?? undefined,
        peso: data.peso ?? undefined,
        volumen: data.volumen ?? undefined,
        fechaHora: data.fechaHora ? new Date(data.fechaHora) : undefined,
        descripcion: data.descripcion ?? undefined,
        attachments: data.attachments ?? undefined,
      },
      include: { owner: { select: { id: true, name: true, email: true } } }
    });
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

// Borrar carga
app.delete('/api/loads/:id', requireRole('empresa'), async (req, res) => {
  try {
    const id = String(req.params.id);
    await prisma.load.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// ---- API: Proposals ----
const ProposalCreateSchema = z.object({
  loadId: z.string().min(1),
  carrierEmail: z.string().email(),
  carrierName: z.string().min(1),
  vehicle: z.string().optional(),
  price: z.number().int().nonnegative().optional()
});

const ProposalUpdateSchema = z.object({
  vehicle: z.string().optional(),
  price: z.number().int().nonnegative().optional(),
  status: z.enum(['pending','filtered','approved','rejected']).optional(),
  shipStatus: z.enum(['pendiente','en_carga','en_camino','entregado']).optional()
});

// Crear propuesta
app.post('/api/proposals', requireRole('transportista'), async (req, res) => {
  try{
    const body = ProposalCreateSchema.parse(req.body);
    const load = await prisma.load.findUnique({ where: { id: body.loadId } });
    if(!load) return res.status(404).json({ error: 'Load not found' });
    const carrier = await ensureCarrierUser(body.carrierEmail.toLowerCase(), body.carrierName);
    const created = await prisma.proposal.create({
      data: {
        loadId: load.id,
        carrierId: carrier.id,
        vehicle: body.vehicle,
        price: body.price,
        status: 'pending',
        shipStatus: 'pendiente'
      },
      include: {
        load: { include: { owner: { select: { id:true, name:true, email:true } } } },
        carrier: { select: { id:true, name:true, email:true } }
      }
    });
    res.status(201).json(created);
  }catch(err:any){
    res.status(400).json({ error: err?.message || String(err) });
  }
});

// Listar propuestas (filtros: loadId, ownerEmail, carrierEmail, status)
app.get('/api/proposals', async (req, res) => {
  try{
    const { loadId, ownerEmail, carrierEmail, status } = req.query as Record<string,string>;
    const where:any = {};
    if(loadId) where.loadId = String(loadId);
    if(ownerEmail) where.load = { owner: { email: String(ownerEmail).toLowerCase() } };
    if(carrierEmail) where.carrier = { email: String(carrierEmail).toLowerCase() };
    if(status) where.status = status;
    const rows = await prisma.proposal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        load: { include: { owner: { select: { id:true, name:true, email:true } } } },
        carrier: { select: { id:true, name:true, email:true, phone:true, perfilJson:true } },
        commission: true,
        thread: { select: { id:true } }
      }
    });
    res.json(rows);
  }catch(err){
    res.status(500).json({ error: String(err) });
  }
});

// Actualizar propuesta
app.patch('/api/proposals/:id', async (req, res) => {
  try{
    const id = String(req.params.id);
    const data = ProposalUpdateSchema.parse(req.body);
    const upd = await prisma.proposal.update({
      where: { id },
      data: {
        vehicle: data.vehicle ?? undefined,
        price: data.price ?? undefined,
        status: data.status ?? undefined,
        shipStatus: data.shipStatus ?? undefined
      },
      include: {
        load: { include: { owner: { select: { id:true, name:true, email:true } } } },
        carrier: { select: { id:true, name:true, email:true } },
        commission: true
      }
    });
    res.json(upd);
  }catch(err:any){
    res.status(400).json({ error: err?.message || String(err) });
  }
});

// Moderación rápida: filtrar
app.post('/api/proposals/:id/filter', requireRole('sendix'), async (req, res) => {
  try{
    const id = String(req.params.id);
    const upd = await prisma.proposal.update({ where: { id }, data: { status: 'filtered' } });
    res.json(upd);
  }catch(err){ res.status(400).json({ error: String(err) }); }
});

// Rechazar
app.post('/api/proposals/:id/reject', requireRole('sendix'), async (req, res) => {
  try{
    const id = String(req.params.id);
    const upd = await prisma.proposal.update({ where: { id }, data: { status: 'rejected' } });
    res.json(upd);
  }catch(err){ res.status(400).json({ error: String(err) }); }
});

// Seleccionar ganadora: aprueba ésta y rechaza el resto del mismo load; crea comisión si no existe
app.post('/api/proposals/:id/select', requireRole('empresa'), async (req, res) => {
  try{
    const id = String(req.params.id);
    const winner = await prisma.proposal.findUnique({ where: { id }, include: { load: true, thread: true } });
    if(!winner) return res.status(404).json({ error: 'Not found' });
    await prisma.$transaction([
      prisma.proposal.update({ where: { id }, data: { status: 'approved', shipStatus: winner.shipStatus ?? 'pendiente' } }),
      prisma.proposal.updateMany({ where: { loadId: winner.loadId, NOT: { id } }, data: { status: 'rejected' } })
    ]);
    // Asegurar que exista un Thread para esta propuesta seleccionada
    try{
      if(!winner.thread){
        // Buscar thread existente por (loadId, carrierId) o crearlo y vincularlo a la propuesta
        const existing = await prisma.thread.findFirst({ where: { loadId: winner.loadId, carrierId: winner.carrierId } });
        if(existing){
          await prisma.thread.update({ where: { id: existing.id }, data: { proposalId: id } });
        } else {
          await prisma.thread.create({ data: { loadId: winner.loadId, carrierId: winner.carrierId, proposalId: id } });
        }
      }
    }catch(err){
      console.warn('No se pudo asegurar Thread al seleccionar propuesta:', err);
    }
    // Comisión (10%) si no existe
    const COMM_RATE = 0.10;
    const existing = await prisma.commission.findUnique({ where: { proposalId: id } });
    if(!existing){
      await prisma.commission.create({
        data: {
          proposalId: id,
          rate: new Prisma.Decimal(COMM_RATE),
          amount: winner.price ? Math.round((winner.price as unknown as number) * COMM_RATE) : 0,
          status: 'pending'
        }
      });
    }
    const updated = await prisma.proposal.findUnique({ where: { id }, include: { commission: true } });
    res.json(updated);
  }catch(err:any){ res.status(400).json({ error: err?.message || String(err) }); }
});

// ---- API: Chat (Threads/Messages/Reads) ----

async function ensureThreadForProposal(proposalId: string){
  const p = await prisma.proposal.findUnique({ where: { id: proposalId }, include: { load: true, carrier: true, thread: true } });
  if(!p) throw Object.assign(new Error('Proposal not found'), { status: 404 });
  // Opcional: limitar chat a sólo propuestas aprobadas
  if(p.status !== 'approved') throw Object.assign(new Error('Chat no disponible hasta aprobar la propuesta'), { status: 400 });
  if(p.thread) return p.thread;
  // Reutilizar si existe por (loadId, carrierId); si no, crear y vincular a proposal
  const existing = await prisma.thread.findFirst({ where: { loadId: p.loadId, carrierId: p.carrierId } });
  if(existing){
    const up = await prisma.thread.update({ where: { id: existing.id }, data: { proposalId: proposalId } });
    return up;
  }
  return prisma.thread.create({ data: { loadId: p.loadId, carrierId: p.carrierId, proposalId: proposalId } });
}

function userCanAccessProposal(u: JwtUser | null | undefined, p: { load: { ownerId: string }, carrierId: string }){
  if(!u) return false;
  if(u.role === 'sendix') return true;
  if(u.role === 'empresa') return u.id === p.load.ownerId;
  if(u.role === 'transportista') return u.id === p.carrierId;
  return false;
}

// Listar mensajes de una propuesta (asegura thread)
app.get('/api/proposals/:id/messages', async (req, res) => {
  try{
    const id = String(req.params.id);
    const p = await prisma.proposal.findUnique({ where: { id }, include: { load: true } });
    if(!p) return res.status(404).json({ error: 'Not found' });
    if(!userCanAccessProposal(req.user, p)) return res.status(403).json({ error: 'Forbidden' });
    const th = await ensureThreadForProposal(id);
    const rows = await prisma.message.findMany({
      where: { threadId: th.id },
      orderBy: { createdAt: 'asc' },
      include: { fromUser: { select: { id: true, name: true, role: true } } }
    });
    res.json(rows.map(m => ({
      id: m.id,
      text: m.text,
      createdAt: m.createdAt,
      from: { id: m.fromUser.id, name: m.fromUser.name, role: m.fromUser.role },
      replyToId: m.replyToId,
      attachments: m.attachments || null
    })));
  }catch(err:any){
    const status = (err && err.status) || 400;
    res.status(status).json({ error: err?.message || String(err) });
  }
});

// Enviar mensaje a una propuesta
const MessageCreateSchema = z.object({ text: z.string().trim().min(1), replyToId: z.string().optional(), attachments: z.any().optional() });
app.post('/api/proposals/:id/messages', async (req, res) => {
  try{
    if(!req.user) return res.status(401).json({ error: 'Auth required' });
    const id = String(req.params.id);
    const body = MessageCreateSchema.parse(req.body);
    const p = await prisma.proposal.findUnique({ where: { id }, include: { load: true } });
    if(!p) return res.status(404).json({ error: 'Not found' });
    if(!userCanAccessProposal(req.user, p)) return res.status(403).json({ error: 'Forbidden' });
    const th = await ensureThreadForProposal(id);
    const created = await prisma.message.create({
      data: {
        threadId: th.id,
        fromUserId: req.user.id,
        text: body.text,
        replyToId: body.replyToId ?? undefined,
        attachments: body.attachments ?? undefined
      },
      include: { fromUser: { select: { id: true, name: true, role: true } } }
    });
    // Marcar lectura del emisor
    await prisma.read.upsert({
      where: { threadId_userId: { threadId: th.id, userId: req.user.id } },
      update: { lastReadAt: new Date() },
      create: { threadId: th.id, userId: req.user.id, lastReadAt: new Date() }
    });
    // Emitir evento en tiempo real a la sala de la propuesta
    try{
      io.to(`proposal:${id}`).emit('chat:message', {
        proposalId: id,
        id: created.id,
        text: created.text,
        createdAt: created.createdAt,
        from: { id: created.fromUser.id, name: created.fromUser.name, role: created.fromUser.role },
        replyToId: created.replyToId,
        attachments: created.attachments || null
      });
    }catch{}
    res.status(201).json({
      id: created.id,
      text: created.text,
      createdAt: created.createdAt,
      from: { id: created.fromUser.id, name: created.fromUser.name, role: created.fromUser.role },
      replyToId: created.replyToId,
      attachments: created.attachments || null
    });
  }catch(err:any){
    const status = (err && err.status) || 400;
    res.status(status).json({ error: err?.message || String(err) });
  }
});

// Marcar hilo como leído por propuesta
app.post('/api/proposals/:id/read', async (req, res) => {
  try{
    if(!req.user) return res.status(401).json({ error: 'Auth required' });
    const id = String(req.params.id);
    const p = await prisma.proposal.findUnique({ where: { id }, include: { load: true } });
    if(!p) return res.status(404).json({ error: 'Not found' });
    if(!userCanAccessProposal(req.user, p)) return res.status(403).json({ error: 'Forbidden' });
    const th = await ensureThreadForProposal(id);
    await prisma.read.upsert({
      where: { threadId_userId: { threadId: th.id, userId: req.user.id } },
      update: { lastReadAt: new Date() },
      create: { threadId: th.id, userId: req.user.id, lastReadAt: new Date() }
    });
    try{ io.to(`proposal:${id}`).emit('chat:read', { proposalId: id, userId: req.user.id, at: new Date().toISOString() }); }catch{}
    res.json({ ok: true });
  }catch(err:any){
    const status = (err && err.status) || 400;
    res.status(status).json({ error: err?.message || String(err) });
  }
});

// Resumen de no leídos y último mensaje por propuesta para el usuario actual
app.get('/api/chat/unread', async (req, res) => {
  try{
    if(!req.user) return res.status(401).json({ error: 'Auth required' });
    // Buscar threads relevantes según rol
    let proposals: any[] = [];
    if(req.user.role === 'sendix'){
      proposals = await prisma.proposal.findMany({ where: { status: 'approved' }, select: { id:true, loadId:true, carrierId:true, thread: { select: { id:true } } } });
    } else if(req.user.role === 'empresa'){
      proposals = await prisma.proposal.findMany({ where: { status: 'approved', load: { ownerId: req.user.id } }, select: { id:true, loadId:true, carrierId:true, thread: { select: { id:true } } } });
    } else if(req.user.role === 'transportista'){
      proposals = await prisma.proposal.findMany({ where: { status: 'approved', carrierId: req.user.id }, select: { id:true, loadId:true, carrierId:true, thread: { select: { id:true } } } });
    }
    // Asegurar threads para todas
    const withThreads = [] as { id: string, threadId: string }[];
    for(const p of proposals){
      const th = p.thread ? p.thread : await ensureThreadForProposal(p.id);
      withThreads.push({ id: p.id, threadId: th.id });
    }
    // Obtener lastRead por usuario e hilo
    const reads = await prisma.read.findMany({ where: { userId: req.user.id, threadId: { in: withThreads.map(x=>x.threadId) } } });
    const lastReadMap = new Map(reads.map(r=> [r.threadId, r.lastReadAt] ));
    // Obtener últimos mensajes y conteo de no leídos
    const result: Record<string, { unread: number, lastMessageAt: string | null }> = {};
    for(const x of withThreads){
      const lastReadAt = lastReadMap.get(x.threadId) || new Date(0);
      const lastMsg = await prisma.message.findFirst({ where: { threadId: x.threadId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      const unread = await prisma.message.count({ where: { threadId: x.threadId, createdAt: { gt: lastReadAt }, NOT: { fromUserId: req.user.id } } });
      result[x.id] = { unread, lastMessageAt: lastMsg?.createdAt?.toISOString() || null };
    }
    res.json(result);
  }catch(err:any){
    res.status(400).json({ error: err?.message || String(err) });
  }
});

// ---- API: Commissions ----
const CommissionUpdateSchema = z.object({
  status: z.enum(['pending','invoiced']).optional(),
  invoiceAt: z.string().datetime().optional()
});

// Listar comisiones (filtros opcionales: status, ownerEmail, carrierEmail)
app.get('/api/commissions', async (req, res) => {
  try{
    const { status, ownerEmail, carrierEmail } = req.query as Record<string,string>;
    const where: any = {};
    if(status) where.status = status;
    const relations: any = { proposal: { include: { load: { include: { owner: { select: { id:true, name:true, email:true } } } }, carrier: { select: { id:true, name:true, email:true } } } } };
    if(ownerEmail){
      relations.proposal.where = { ...(relations.proposal.where||{}), load: { owner: { email: String(ownerEmail).toLowerCase() } } };
    }
    if(carrierEmail){
      relations.proposal.where = { ...(relations.proposal.where||{}), carrier: { email: String(carrierEmail).toLowerCase() } };
    }
    const rows = await prisma.commission.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: relations
    });
    res.json(rows);
  }catch(err){ res.status(500).json({ error: String(err) }); }
});

// Actualizar comisión (p.ej. marcar como facturada)
app.patch('/api/commissions/:id', async (req, res) => {
  try{
    const id = String(req.params.id);
    const data = CommissionUpdateSchema.parse(req.body);
    const upd = await prisma.commission.update({
      where: { id },
      data: {
        status: data.status ?? undefined,
        invoiceAt: data.invoiceAt ? new Date(data.invoiceAt) : undefined
      }
    });
    res.json(upd);
  }catch(err:any){
    res.status(400).json({ error: err?.message || String(err) });
  }
});

// ---- API: Users (admin SENDIX) ----
app.get('/api/users', requireRole('sendix'), async (req, res) => {
  try{
    const { role, q, cargas, vehiculos, seguroOk, senasa, imo, alcance } = req.query as Record<string,string>;
    const where:any = {};
    if(role && ['sendix','empresa','transportista'].includes(role)) where.role = role;
    if(q && String(q).trim()){
      const s = String(q).trim();
      where.OR = [
        { name: { contains: s, mode: 'insensitive' } },
        { email: { contains: s, mode: 'insensitive' } }
      ];
    }
    const rows = await prisma.usuario.findMany({
      where,
      orderBy: { name: 'asc' },
      select: { id:true, name:true, email:true, role:true, phone:true, taxId:true, perfilJson:true }
    });
    // Filtros avanzados por perfilJson (en memoria)
    const cargArr = cargas ? String(cargas).split(',').map(s=>s.trim()).filter(Boolean) : [];
    const vehArr = vehiculos ? String(vehiculos).split(',').map(s=>s.trim()).filter(Boolean) : [];
    const wantSeguro = seguroOk === '1' || seguroOk === 'true';
    const wantSenasa = senasa === '1' || senasa === 'true';
    const wantImo = imo === '1' || imo === 'true';
    const alc = alcance ? String(alcance).toLowerCase() : '';
    const filtered = rows.filter(u => {
      if(role && u.role !== role) return false;
      const pj:any = u.perfilJson || {};
      if(cargArr.length){ const arr = Array.isArray(pj.cargas)? pj.cargas: []; if(!cargArr.some(x=> arr.includes(x))) return false; }
      if(vehArr.length){ const arr = Array.isArray(pj.vehiculos)? pj.vehiculos: []; if(!vehArr.some(x=> arr.includes(x))) return false; }
      if(seguroOk!=null && seguroOk!=='' && wantSeguro && !pj.seguroOk) return false;
      if(senasa!=null && senasa!=='' && wantSenasa && !pj.senasa) return false;
      if(imo!=null && imo!=='' && wantImo && !pj.imo) return false;
      if(alc) { const s = String(pj.alcance||'').toLowerCase(); if(!s.includes(alc)) return false; }
      return true;
    });
    res.json(filtered.map(u=> ({ id:u.id, name:u.name, email:u.email, role:u.role, phone:u.phone, taxId:u.taxId, perfil: u.perfilJson || null })));
  }catch(err){ res.status(500).json({ error: String(err) }); }
});

// ---- Frontend estático (sirve index.html y assets) ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..'); // carpeta raíz del proyecto (donde está index.html)

// Archivos estáticos: assets, styles.css, app.js, demo html
app.use('/assets', express.static(path.join(rootDir, 'assets'), { maxAge: '1h' }));
app.get('/styles.css', (_req, res) => res.sendFile(path.join(rootDir, 'styles.css')));
app.get('/app.js', (_req, res) => res.sendFile(path.join(rootDir, 'app.js')));
app.get('/demo-mapa-real.html', (_req, res) => res.sendFile(path.join(rootDir, 'demo-mapa-real.html')));

// Raíz: SPA
app.get('/', (_req, res) => res.sendFile(path.join(rootDir, 'index.html')));
// Ruta dedicada para restablecer contraseña (sirve la SPA también)
app.get('/reset-password', (_req, res) => res.sendFile(path.join(rootDir, 'index.html')));

const PORT = Number(process.env.PORT) || 4000;
const server = httpServer.listen(PORT, () => {
  const opts = getCookieOpts();
  console.log(`✅ API + Web en http://localhost:${PORT}`);
  console.log('CORS_ORIGIN:', corsOrigins || '(reflect origin)');
  console.log('COOKIE SameSite/secure:', opts.sameSite, '/', opts.secure);
});

// Cierre ordenado
async function shutdown(signal: string) {
  console.log(`\nRecibido ${signal}. Cerrando...`);
  server.close(async () => {
    try {
      await prisma.$disconnect();
    } finally {
      process.exit(0);
    }
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// --- Bootstrap: crear admin SENDIX si hay variables configuradas ---
async function ensureSendixAdmin(){
  try{
    const email = (process.env.SENDIX_ADMIN_EMAIL||'').toLowerCase().trim();
    const password = process.env.SENDIX_ADMIN_PASSWORD||'';
    const name = process.env.SENDIX_ADMIN_NAME || 'Nexo SENDIX';
    if(!email || !password){
      console.log('ℹ️ SENDIX_ADMIN_EMAIL/PASSWORD no configurados: omitiendo bootstrap de admin');
      return;
    }
    const existing = await prisma.usuario.findUnique({ where: { email } });
    if(existing){
      if(existing.role !== 'sendix'){
        await prisma.usuario.update({ where: { id: existing.id }, data: { role: 'sendix' } });
        console.log('✅ Usuario existente marcado como sendix:', email);
      } else {
        console.log('ℹ️ Admin SENDIX ya existe:', email);
      }
      return;
    }
    const hash = await bcrypt.hash(password, 10);
    await prisma.usuario.create({ data: { email, name, role: 'sendix', passwordHash: hash } });
    console.log('✅ Admin SENDIX creado:', email);
  }catch(err){ console.error('Error creando admin SENDIX:', err); }
}

(async()=>{ await ensureSendixAdmin(); })();
