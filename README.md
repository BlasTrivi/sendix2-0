# MICARGA

Plataforma logística full‑stack que conecta Empresas y Transportistas con un rol moderador (MICARGA). Incluye:

* Publicación y postulación de cargas
* Moderación / filtrado de propuestas
* Selección de propuesta ganadora y cálculo de comisión
* Chat en tiempo real por propuesta aprobada (WhatsApp‑like) con Socket.IO
* Tracking de envío (pendiente → en_carga → en_camino → entregado) con visual animada SVG
* Autenticación por roles con JWT en cookie httpOnly
* Recuperación de contraseña con enlaces de un solo uso (Resend / SMTP / simulación)
* Perfil extendido para transportistas (tipos de carga, vehículos, seguros, alcance, etc.)

---

## 🔍 Resumen tecnológico

| Capa | Tecnología |
|------|------------|
| Backend API | Node.js + Express (TypeScript) |
| Persistencia | PostgreSQL + Prisma Client |
| Tiempo real | Socket.IO (rooms por propuesta) |
| Autenticación | JWT (Firmado, cookie httpOnly SameSite configurable) |
| Frontend | SPA sin framework (HTML + CSS + JS puro, hash routing) |
| Emails | Resend (prioridad) + Nodemailer (SMTP fallback) |
| Contenedores | Docker / docker-compose |

---

## 📂 Estructura principal

```
├── src/
│   ├── server.ts              # API principal + rutas HTTP y Socket.IO
│   └── resetPassword.ts       # Endpoints de recuperación (forgot / reset)
├── prisma/
│   └── schema.prisma          # Modelos (Usuario, Load, Proposal, Thread, Message, etc.)
├── index.html                 # Shell SPA
├── app.js                     # Lógica de UI (routing, render, llamadas API)
├── styles.css                 # Estilos y componentes
├── assets/                    # Recursos estáticos
├── Dockerfile
├── docker-compose.yml
└── tsconfig.json
```

---

## 🧬 Modelos clave (Prisma)

* Usuario (roles: empresa, transportista, micarga)
  (El rol administrador interno ahora es 'micarga'. Se aceptan tokens legados con 'sendix' y se normalizan a 'micarga' en backend.)
* Load (carga publicada por empresa)
* Proposal (propuesta del transportista + estado de moderación + shipStatus)
* Thread (1‑1 con Proposal aprobada; compone el chat)
* Message (mensajes del chat; soporta replyTo y attachments JSON)
* Read (última lectura por usuario + hilo)
* Commission (tasa/importe sobre proposal aprobada)
* PasswordReset (tokens hash + expiración + single‑use)

---

## 🚀 Puesta en marcha (desarrollo)

1. Clonar repositorio
2. Crear base de datos Postgres local (o usar docker-compose)
3. Configurar `.env` mínimo:

```
DATABASE_URL=postgresql://user:pass@localhost:5432/micarga?schema=public
JWT_SECRET=dev-secret
CORS_ORIGIN=http://localhost:4000
APP_BASE_URL=http://localhost:4000
```

4. Instalar dependencias
```
npm install
```
5. Sincronizar schema
```
npx prisma db push
```
6. Levantar en modo desarrollo (watch TS)
```
npm run dev
```
7. Visitar: http://localhost:4000

> El frontend se sirve desde el mismo servidor Express (no requiere build separado). 

---

## 🐳 Opción rápida con docker-compose

```
docker compose up --build
```

Servicios:
* db: Postgres 16 (puerto host 5433)
* app: API + frontend (puerto 4000)

La variable `DATABASE_URL` ya apunta al servicio interno `db`.

---

## 🔐 Autenticación

* Registro: `/api/auth/register` (empresa o transportista) – crea usuario y setea cookie `token`.
* Login: `/api/auth/login`.
* Logout: `/api/auth/logout` (borra cookie).
* `GET /api/me` entrega usuario actual (o `null`).
* Cookie: httpOnly, SameSite derivado de `COOKIE_SAMESITE` o `none` si hay CORS_ORIGIN.
* Admin MICARGA opcional se autogenera si se definen `MICARGA_ADMIN_EMAIL` y `MICARGA_ADMIN_PASSWORD` (o sus equivalentes legacy `SENDIX_*` por compatibilidad).

### Variables relevantes

| Nombre | Descripción |
|--------|-------------|
| DATABASE_URL | Cadena de conexión Postgres |
| PORT | Puerto HTTP (default 4000) |
| CORS_ORIGIN | Lista separada por comas de orígenes permitidos |
| COOKIE_SAMESITE | lax | none | strict (auto none si hay CORS_ORIGIN) |
| JWT_SECRET / JWT_ACCESS_SECRET | Clave firma JWT |
| MICARGA_ADMIN_EMAIL / PASSWORD / NAME | Bootstrap usuario rol admin (micarga). También se aceptan SENDIX_* por compatibilidad |
| APP_BASE_URL | Base absoluta para construir links de reset |
| SMTP_HOST / SMTP_PORT | Servidor SMTP fallback |
| SMTP_USER / SMTP_PASS | Credenciales SMTP |
| SMTP_FROM | Cabecera From legible (si falta se usa SMTP_USER) |
| RESEND_API_KEY | Para envío prioritario vía Resend |
| RESEND_FROM | Remitente para Resend (opcional) |

---

## 🔄 Flujo de recuperación de contraseña

1. POST `/api/forgot-password` { email }
2. Genera token aleatorio (32 bytes), se almacena hash (bcrypt) + expiración 1h
3. Enlace enviado: `APP_BASE_URL/reset-password?token=...&email=...`
4. POST `/api/reset-password` { email, token, password }
5. Marca registro como `usedAt` (single‑use) y actualiza hash de contraseña

Fallbacks:
* Si no hay Resend, usa SMTP
* Si tampoco, simula envío (log ofuscado del email)

---

## 💬 Chat en tiempo real

* Un chat por Proposal aprobada (Thread)
* Room Socket.IO: `proposal:{proposalId}`
* Eventos server → cliente:
  * `chat:message` (nuevo mensaje)
  * `chat:read` (lectura)
  * `ship:update` (cambio de estado logístico)
* API REST:
  * GET `/api/proposals/:id/messages` → `{ disabled, messages[] }` (si la proposal no está aprobada `disabled=true`)
  * POST `/api/proposals/:id/messages`
  * POST `/api/proposals/:id/read`
  * GET `/api/chat/unread` → resumen por proposal

Mensajes incluyen: id, text, createdAt, from { id, name, role }, replyToId, attachments.

---

## 📦 Ciclo de vida de una carga

1. Empresa crea Load (`/api/loads`)
2. Transportistas envían Proposal (`/api/proposals`)
3. MICARGA filtra (`/filter`) / rechaza (`/reject`)
4. Empresa selecciona ganadora (`/select`) → status=approved + se asegura Thread
5. Transportista / Empresa avanzan `shipStatus` (en_carga → en_camino → entregado)
6. Cada cambio relevante dispara un mensaje automático y evento tiempo real
7. Commission se genera al aprobar (rate fija 10% en código)

---

## 🧪 Endpoints principales (resumen mínimo)

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | /api/auth/register | Registro usuario |
| POST | /api/auth/login | Login |
| GET  | /api/me | Usuario actual |
| POST | /api/loads | Crear carga (empresa) |
| GET  | /api/loads | Listar cargas |
| POST | /api/proposals | Crear propuesta (transportista) |
| GET  | /api/proposals | Listar propuestas (filtros) |
| POST | /api/proposals/:id/select | Aprobar (empresa) |
| POST | /api/proposals/:id/filter | Marcar filtered (micarga) |
| POST | /api/proposals/:id/reject | Rechazar |
| PATCH| /api/proposals/:id | Actualizar campos permitidos |
| GET  | /api/proposals/:id/messages | Mensajes chat |
| POST | /api/proposals/:id/messages | Enviar mensaje |
| POST | /api/forgot-password | Solicitar reset |
| POST | /api/reset-password | Aplicar reset |
| GET  | /health /healthz | Salud / liveness |

---

## 🛡️ Consideraciones de seguridad actuales

Implementado:
* JWT en cookie httpOnly (evita lectura por JS)
* Single‑use tokens para reset de contraseña
* Hash de contraseñas y tokens (bcrypt)
* CORS granular (`CORS_ORIGIN` lista)
* Autorización por rol en rutas críticas

Pendiente / Recomendado:
* Rate limiting (login / forgot)
* Bloqueo progresivo por intentos fallidos (parcialmente soportado en modelo, no aplicado en lógica)
* Cabeceras de seguridad (`helmet`)
* Sanitización/escapes adjuntos y validaciones extra attachments
* Migraciones versionadas (`prisma migrate`) en lugar de `db push` en producción
* Tests unitarios / integración + CI

---

## 🛠️ Scripts NPM

| Script | Acción |
|--------|-------|
| dev | `tsx watch src/server.ts` (hot reload) |
| build | Compila TypeScript a `dist/` |
| start | Ejecuta build en Node (producción) |
| start:node | Ejecuta TS directo con tsx (sin build) |
| prisma:push | Sincroniza schema con la base |
| prisma:studio | UI de Prisma |

Post‑install genera el Prisma Client automáticamente (ignora error si no hay DB aún).

---

## 📦 Docker (producción)

El `Dockerfile` genera una imagen multi‑stage (build + runtime Alpine):

```
docker build -t micarga .
docker run -p 4000:4000 --env-file .env micarga
```

Requisitos: que `DATABASE_URL` apunte a una base accesible desde el contenedor.

---

## 🎨 Frontend (SPA sin framework)

* Hash routing (`#home`, `#login`, etc.)
* Estado manejado desde `app.js` llamando a la API (persistencia ya no depende de LocalStorage para datos críticos; se conserva sólo lo mínimo si aplica)
* Chat con layout responsive: lista → conversación (botón volver) en móviles
* Tracking animado con SVG + `requestAnimationFrame` (respeta `prefers-reduced-motion`)

---

## ♻️ Flujo de desarrollo sugerido

1. `npm run dev`
2. Ajustar modelos en `schema.prisma`
3. `npx prisma db push`
4. Probar endpoints con herramientas (Insomnia/Postman / fetch en consola)
5. Refinar UI en `app.js` / `styles.css`

Para producir versión estable: `npm run build && npm start`.

---

## 🧭 Roadmap (ideas futuras)

* Rate limiting + bloqueo adaptativo
* Verificación de email (modelo existe: `EmailVerification` falta lógica)
* Sesiones refresh tokens (modelo `Session` ya definido)
* Subida real de archivos (S3 / almacenamiento externo) en vez de JSON base64
* Búsqueda / filtros avanzados en hilos de chat
* Métricas / observabilidad (Prometheus + Grafana)
* División de `server.ts` en capas (routes / services / repos / sockets)
* Tests (Vitest / Jest) y pipeline CI/CD

---

## 🤝 Contribuir

1. Crear rama feature/*
2. Explicar en commit mensajes: tipo(scope): descripción (convención simple)
3. Mantener cambios de schema acompañados por `prisma migrate` (cuando se adopte)

---

Hecho con foco en simplicidad, trazabilidad y UX rápida para el flujo logístico de MICARGA. ✨

