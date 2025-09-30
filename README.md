# SENDIX

Aplicación SPA (sin framework) que conecta empresas y transportistas con un nexo (SENDIX). Incluye publicación/selección de cargas, chat integrado estilo WhatsApp Web y un tracking visual simulado con SVG.

## Características principales

- Sin dependencias: HTML + CSS + JavaScript puro en una sola página (hash routing).
- Roles y flujos:
	- Empresa: publica cargas, elige propuestas filtradas, chatea y ve estado del envío.
	- Transportista: ve ofertas, se postula, gestiona estado del envío, chatea.
	- SENDIX (nexo): modera propuestas y puede participar del chat.
- Chat moderno por hilo (empresa ⇄ transportista + nexo):
	- Lista de hilos ordenada por última actividad.
	- Vista tipo WhatsApp Web: primero solo lista, al abrir se ve solo el chat, botón “← Chats” para volver.
	- Header e input sticky, scroll interno con “fades” y barras de scroll ocultas.
	- Enter para enviar, Shift+Enter para salto de línea.
	- Adjuntos (imágenes) con previsualización.
	- Responder a mensajes (swipe-to-reply en móvil y menú contextual en desktop).
	- Indicador de escritura simulado.
	- Badges de no leídos por hilo y en navegación.
- Tracking visual con SVG: camión animado en onda senoidal entre hitos (pendiente → en-carga → en-camino → entregado).
- Estado persistente en LocalStorage.
- Barra inferior dinámica por rol; el layout evita solapes con contenido en todas las vistas.

## Estructura del proyecto

- `index.html`: Shell de la SPA, vistas y navegación inferior.
- `styles.css`: Tokens, layout, componentes (cards, listas, chat, tracking), y responsivo.
- `app.js`: Routing por hash, estado en LocalStorage, render de vistas y lógica de negocio (publicar, moderación, chat, tracking).
- `assets/`: Recursos estáticos (logo, SVG placeholder).

## Cómo ejecutar

Opción 1 (rápida): abrir `index.html` en tu navegador.

Opción 2 (servidor local):

```bash
# Python 3
python -m http.server 8080
# Luego abrir http://localhost:8080/ en el navegador
```

No se requiere build ni instalación de paquetes.

## Rutas y vistas

- Login: selección de rol y nombre.
- Home: accesos directos con badges por rol.
- Empresa:
	- Publicar: formulario con vista previa en vivo.
	- Mis cargas y propuestas:
		- Si no hay propuesta aprobada: lista “Propuestas filtradas por SENDIX”.
		- Si hay propuesta aprobada y el envío está en curso: bloque “Envío seleccionado” con estado, Chat y Ver envío; se ocultan las propuestas.
		- Si el envío fue entregado: se muestra solo el estado “entregado” y detalles; sin Chat ni Ver envío y sin propuestas.
- Transportista:
	- Ofertas disponibles: listar y postularse.
	- Mis postulaciones: histórico y acceso a Chat cuando esté aprobada.
	- Mis envíos: actualizar estado del envío (cada envío aprobado).
- SENDIX (nexo):
	- Moderación: filtrar propuestas (pendiente ⇄ filtrada) o rechazar.
- Conversaciones: chat por hilo (loadId + carrier), ordenado por última actividad.
- Tracking: lista de envíos aprobados con estado actual y visualización SVG animada.

## Comportamiento del chat (resumen)

- Lista → Chat → Volver a lista (en todas las resoluciones).
- Scroll interno con barras ocultas y “fades” arriba/abajo.
- Adjuntos con previsualización, responder mensajes, menú contextual y swipe-to-reply en móvil.
- Indicador de escritura y badges de no leídos.
- Atajo: Ctrl/Cmd + K para enfocar búsqueda de chats.

## Estado y persistencia

El estado se guarda en LocalStorage con estas claves:

- `sendix.user` (usuario/rol actual)
- `sendix.loads` (cargas publicadas)
- `sendix.proposals` (propuestas: pending/filtered/approved/rejected y shipStatus)
- `sendix.messages` (mensajes por hilo)
- `sendix.reads` (última lectura por usuario + hilo)
- `sendix.step` (paso global de tracking, usado como fallback)

Para “resetear” el demo podés limpiar localStorage desde DevTools:

```js
localStorage.removeItem('sendix.user');
localStorage.removeItem('sendix.loads');
localStorage.removeItem('sendix.proposals');
localStorage.removeItem('sendix.messages');
localStorage.removeItem('sendix.reads');
localStorage.removeItem('sendix.step');
```

## Parámetros visuales útiles

- Altura del recuadro de chat: `--chat-h` (en `:root`, usa `clamp()` para adaptarse por dispositivo).
- Altura de la barra inferior: `--bbar-h` (se calcula dinámicamente desde JS y evita solapes).
- Safe areas iOS: `--safe-top`, `--safe-bottom`.

## Notas de desarrollo

- No hay librerías, por lo que todo es editable sin tooling extra.
- Se cuidó evitar listeners duplicados usando handlers `on*` en renders que se repiten.
- Se optimizó el orden por última actividad de los hilos precomputando el último mensaje por hilo.
- El tracking usa SVG y `requestAnimationFrame()` con animación senoidal; respeta `prefers-reduced-motion`.

## Limitaciones y siguientes pasos (ideas)

- Autenticación real y backend (API) no incluidos; todo es demo local.
- Subida real de archivos no implementada (se previsualiza con `URL.createObjectURL`).
- Mejoras opcionales:
	- Badge “Nuevo mensaje” cuando no estás scrolleado al final del chat.
	- Filtros en “Mis cargas” (p.ej. ocultar entregados) y búsqueda.
	- Exportar/Importar estado demo (JSON) para compartir escenarios.

---

Hecho con cariño, simpleza y foco en UX rápida para el caso de uso de SENDIX.
