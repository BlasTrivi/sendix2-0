import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient, Prisma } from '@prisma/client';
import { z } from 'zod';

const app = express();
const prisma = new PrismaClient();

// Middlewares
app.use(express.json());

// CORS configurable por variable de entorno (lista separada por comas)
const rawOrigins = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const corsOrigins = rawOrigins.length > 0 ? rawOrigins : undefined; // si no hay, no restringimos (mismo origen)
app.use(corsOrigins ? cors({ origin: corsOrigins }) : cors());

// ---- API ----
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
app.post('/api/loads', async (req, res) => {
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
app.patch('/api/loads/:id', async (req, res) => {
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
app.delete('/api/loads/:id', async (req, res) => {
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
app.post('/api/proposals', async (req, res) => {
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
        carrier: { select: { id:true, name:true, email:true } },
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
app.post('/api/proposals/:id/filter', async (req, res) => {
  try{
    const id = String(req.params.id);
    const upd = await prisma.proposal.update({ where: { id }, data: { status: 'filtered' } });
    res.json(upd);
  }catch(err){ res.status(400).json({ error: String(err) }); }
});

// Rechazar
app.post('/api/proposals/:id/reject', async (req, res) => {
  try{
    const id = String(req.params.id);
    const upd = await prisma.proposal.update({ where: { id }, data: { status: 'rejected' } });
    res.json(upd);
  }catch(err){ res.status(400).json({ error: String(err) }); }
});

// Seleccionar ganadora: aprueba ésta y rechaza el resto del mismo load; crea comisión si no existe
app.post('/api/proposals/:id/select', async (req, res) => {
  try{
    const id = String(req.params.id);
    const winner = await prisma.proposal.findUnique({ where: { id }, include: { load: true } });
    if(!winner) return res.status(404).json({ error: 'Not found' });
    await prisma.$transaction([
      prisma.proposal.update({ where: { id }, data: { status: 'approved', shipStatus: winner.shipStatus ?? 'pendiente' } }),
      prisma.proposal.updateMany({ where: { loadId: winner.loadId, NOT: { id } }, data: { status: 'rejected' } })
    ]);
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

// ---- API: Commissions ----
const CommissionUpdateSchema = z.object({
  status: z.enum(['pending','invoiced']).optional(),
  invoiceAt: z.string().datetime().optional()
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

const PORT = Number(process.env.PORT) || 4000;
const server = app.listen(PORT, () => {
  console.log(`✅ API + Web en http://localhost:${PORT}`);
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
