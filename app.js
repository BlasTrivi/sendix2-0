/* =====================================================================
   SENDIX — app.js (comentado)
   ---------------------------------------------------------------------
   - SPA sin framework: rutas por hash, estado en LocalStorage
   - Roles: empresa, transportista, sendix (nexo)
   - Módulos: navegación, auth, empresa, transportista, sendix, chat, tracking
   - Cada función tiene responsabilidad única y renderiza su vista
   ===================================================================== */
// Nexo + Chat 3 partes + Tracking global por envío (modo API: sin persistencia en LocalStorage)
const routes = ['login','home','publicar','mis-cargas','ofertas','mis-postulaciones','mis-envios','moderacion','conversaciones','resumen','usuarios','perfil','chat','tracking'];
const SHIP_STEPS = ['pendiente','en-carga','en-camino','entregado'];
// Comisión SENDIX
const COMM_RATE = 0.10; // 10%
function commissionFor(price){
  const n = Number(price||0);
  // Redondeo a entero ARS
  return Math.round(n * COMM_RATE);
}
function totalForCompany(price){
  const n = Number(price||0);
  return Math.round(n + commissionFor(n));
}

const state = {
  user: null,
  users: [],
  loads: [],
  proposals: [],
  messages: [],
  trackingStep: 'pendiente',
  activeThread: null,
  activeShipmentProposalId: null,
  reads: {},
  justOpenedChat: false,
  commissions: [],
  adminUsers: []
};

// --- Socket.IO cliente ---
let socket = null;
function ensureSocket(){
  try{
    if(socket || typeof io==='undefined') return;
    socket = io(API.base, { withCredentials: true });
    // Unirme a hilos relevantes cuando tenga sesión
    socket.on('connect', ()=>{
      try{
        const approved = (state.proposals||[]).filter(p=>p.status==='approved').map(p=>p.id);
        if(approved.length) socket.emit('chat:joinMany', { proposalIds: approved });
      }catch{}
    });
    // Nuevo mensaje entrante
    socket.on('chat:message', (m)=>{
      try{
        const pId = m?.proposalId; if(!pId) return;
        const p = (state.proposals||[]).find(x=>x.id===pId); if(!p) return;
        const tId = threadIdFor(p);
        const mapped = {
          id: m.id,
          threadId: tId,
          from: m.from?.name || '-',
          role: m.from?.role || '-',
          text: m.text||'',
          ts: m.createdAt ? new Date(m.createdAt).getTime() : Date.now(),
          replyToId: m.replyToId || null,
          attach: Array.isArray(m.attachments)? m.attachments: []
        };
        state.messages.push(mapped);
        save();
        const route = (location.hash.replace('#','')||'home');
        if(route==='conversaciones'){
          renderChat();
          renderThreads();
        }
        // Actualizar badge global de no leídos
        scheduleNavUnreadRefresh();
      }catch{}
    });
    // Lectura por otro usuario (podríamos refrescar contadores)
    socket.on('chat:read', (_evt)=>{
      try{ const route=(location.hash.replace('#','')||'home'); if(route==='conversaciones') renderThreads(); }catch{}
      scheduleNavUnreadRefresh();
    });
  }catch{}
}

function save(){ /* modo API: sin persistencia local */ }

// --- Sesión (cookies httpOnly) ---
function setSession(_tokenIgnored, user){
  // El token se guarda en cookie httpOnly del servidor; aquí solo guardamos el usuario
  const safeUser = user ? { name: user.name || user.email || 'Usuario', email: user.email, role: user.role, phone: user.phone||'', taxId: user.taxId||'', perfil: user.perfil||null } : null;
  state.user = safeUser;
  if(safeUser) upsertUser(safeUser);
  save();
  updateChrome();
  // Actualizar badge global de no leídos tras iniciar sesión
  scheduleNavUnreadRefresh(50);
}
function clearSession(){
  state.user = null;
  save();
  updateChrome();
}
async function tryRestoreSession(){
  try{
    const me = await API.me();
    if(me && me.user){ setSession('', me.user); }
  }catch{}
  // Inicializar socket después de intentar restaurar sesión
  ensureSocket();
  // Y refrescar badge con la sesión restaurada
  scheduleNavUnreadRefresh(50);
}

function isValidEmail(email){
  const s = String(email||'').trim();
  // Regex simple y suficiente para demo
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}
function findUserByEmail(email){
  const key = String(email||'').toLowerCase();
  return (state.users||[]).find(u=> String(u.email||'').toLowerCase()===key) || null;
}
function reconcileSessionWithUsers(){
  try{
    if(!state.user){ return; }
    const currentEmail = String(state.user.email||'').toLowerCase();
    const u = findUserByEmail(currentEmail);
    if(!u){
      // Si la sesión apunta a un email inexistente, limpiar sesión
      state.user = null; save();
      return;
    }
    // Sincronizar sesión con el registro guardado (rol y datos correctos)
    state.user = { ...u };
    save();
  }catch{}
}

function upsertUser(u){
  if(!u) return;
  const email = (u.email||'').toLowerCase();
  if(!email) return;
  const idx = (state.users||[]).findIndex(x=> String(x.email||'').toLowerCase()===email);
  if(idx>=0){ state.users[idx] = { ...state.users[idx], ...u }; }
  else { state.users.unshift({ ...u, createdAt: u.createdAt || new Date().toISOString() }); }
  save();
}

// Actualiza la variable CSS --bbar-h según la barra inferior visible
function updateBottomBarHeight(){
  try{
    const root = document.documentElement;
    const bar = document.querySelector('.bottombar.visible');
    let h = 0;
    if(bar){
      const rect = bar.getBoundingClientRect();
      // Usar la altura real de la barra (incluye padding y safe-area)
      h = Math.max(0, Math.round(rect.height));
    }
    // Guardrail: valores razonables (0-200px)
    if(!(h >= 0 && h <= 200)) h = 64;
    root.style.setProperty('--bbar-h', h + 'px');
  }catch(e){
    // Fallback silencioso (no bloquear la app)
  }
}

function genId(){ return Math.random().toString(36).slice(2,10); }
function threadIdFor(p){ return `${p.loadId}__${p.carrier}`; }

function computeUnread(threadId){
  if(!state.user) return 0;
  const last = (state.reads[threadId] && state.reads[threadId][state.user.name]) || 0;
  return state.messages.filter(m=>m.threadId===threadId && m.ts>last && m.from!==state.user.name).length;
}
function unreadBadge(threadId){
  const u = computeUnread(threadId);
  return u ? `<span class="badge-pill">${u}</span>` : '';
}
function markThreadRead(threadId){
  if(!threadId) return;
  if(!state.reads[threadId]) state.reads[threadId] = {};
  state.reads[threadId][state.user?.name] = Date.now();
  save();
}

// Unread helpers (comparten cálculo entre vistas)
async function getUnreadMapForProposals(proposals){
  const threads = Array.isArray(proposals) ? proposals : [];
  let unreadMap = {};
  let total = 0;
  try{
    const m = await API.chatUnread();
    unreadMap = m || {};
    total = threads.map(p=> (unreadMap[p.id]?.unread||0)).reduce((a,b)=>a+b,0);
  }catch{
    // Fallback local con estado en memoria
    unreadMap = {};
    for(const p of threads){
      const u = computeUnread(threadIdFor(p));
      unreadMap[p.id] = { unread: u, lastMessageAt: null };
      total += u;
    }
  }
  return { unreadMap, total };
}

function updateNavUnreadBadge(total){
  const navBadge = document.getElementById('nav-unread');
  if(!navBadge) return;
  const prev = Number(navBadge.textContent||'0');
  navBadge.style.display = total ? 'inline-block' : 'none';
  navBadge.textContent = total;
  if(total!==prev && total>0){ navBadge.classList.remove('pulse-badge'); void navBadge.offsetWidth; navBadge.classList.add('pulse-badge'); }
}

function setBadgeValue(idOrEl, value){
  const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
  if(!el) return;
  const prev = Number(el.textContent||'0');
  el.style.display = value ? 'inline-block' : 'none';
  el.textContent = value;
  if(value!==prev && value>0){ el.classList.remove('pulse-badge'); void el.offsetWidth; el.classList.add('pulse-badge'); }
}

async function refreshNavUnreadBadge(){
  try{
    const threads = threadsForCurrentUser();
    const { total } = await getUnreadMapForProposals(threads);
    updateNavUnreadBadge(total);
  }catch{}
}

// Debounce para evitar recalcular muchas veces seguido
let _navUnreadTimer = null;
function scheduleNavUnreadRefresh(delay=200){
  try{ if(_navUnreadTimer) clearTimeout(_navUnreadTimer); }catch{}
  _navUnreadTimer = setTimeout(()=>{ try{ refreshNavUnreadBadge(); }catch{} }, delay);
}

// Thread helpers by role
function threadsForCurrentUser(){
  if(!state.user) return [];
  if(state.user.role==='sendix'){
    return state.proposals.filter(p=>p.status==='approved');
  }
  if(state.user.role==='empresa'){
    const myLoadIds = state.loads.filter(l=>l.owner===state.user.name).map(l=>l.id);
    return state.proposals.filter(p=>myLoadIds.includes(p.loadId) && p.status==='approved');
  }
  if(state.user.role==='transportista'){
    return state.proposals.filter(p=>p.carrier===state.user.name && p.status==='approved');
  }
  return [];
}

// NAV
function navigate(route){
  if(route==='chat') route='conversaciones';
  if(!routes.includes(route)) route='login';
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelector(`[data-route="${route}"]`).classList.add('active');
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll(`.bottombar.visible .tab[data-nav="${route}"]`).forEach(t=>t.classList.add('active'));
  // Marcar en body la ruta activa para estilos específicos
  document.body.classList.toggle('route-conversaciones', route==='conversaciones');
  document.body.classList.toggle('route-publicar', route==='publicar');
  if(route!=='login') location.hash = route;

  // Si entramos a conversaciones sin abrir explícitamente un chat, mostrar solo la lista
  if(route==='conversaciones' && !state.justOpenedChat){
    state.activeThread = null;
  }

  if(route==='home') renderHome();
  if(route==='publicar'){ try{ requireRole('empresa'); renderLoads(true); }catch(e){} }
  if(route==='mis-cargas'){ try{ requireRole('empresa'); renderMyLoadsWithProposals(); }catch(e){} }
  if(route==='ofertas'){ try{ requireRole('transportista'); renderOffers(); }catch(e){} }
  if(route==='mis-postulaciones'){ try{ requireRole('transportista'); renderMyProposals(); }catch(e){} }
  if(route==='mis-envios'){ try{ requireRole('transportista'); renderShipments(); }catch(e){} }
  if(route==='moderacion'){ try{ requireRole('sendix'); renderInbox(); }catch(e){} }
  if(route==='conversaciones'){ renderThreads(); renderChat(); }
  if(route==='resumen'){ try{ requireRole('sendix'); renderMetrics(); }catch(e){} }
  if(route==='usuarios'){ try{ requireRole('sendix'); renderUsers(); }catch(e){} }
  if(route==='perfil'){ renderProfile(); }
  if(route==='tracking') renderTracking();
  if(route==='conversaciones') reflectMobileChatState(); else document.body.classList.remove('chat-has-active');
  // Asegurar que el indicador de escritura no quede visible fuera del chat
  if(route!=='conversaciones'){
    try{ const ti = document.getElementById('typing-indicator'); if(ti) ti.style.display='none'; }catch{}
  }
  // Recalcular altura por si la UI cambió
  updateBottomBarHeight();
  // Reset del flag luego de navegar
  state.justOpenedChat = false;
}
function initNav(){
  // Evitar duplicar navegación en tarjetas: no adjuntar a .card[data-nav], las maneja el delegado global
  document.querySelectorAll('[data-nav]:not(.card)').forEach(el=>el.addEventListener('click', ()=>navigate(el.dataset.nav)));
  // Si el usuario toca "Conversaciones" desde la barra, forzar vista de lista
  document.querySelectorAll('[data-nav="conversaciones"]').forEach(el=>{
    el.addEventListener('click', ()=>{ state.activeThread = null; state.justOpenedChat = false; });
  });
  // Permitir que las tarjetas del home sean clickeables en toda su superficie
  document.addEventListener('click', (e)=>{
    // Ignorar clicks en elementos de entrada para no interferir
    const tag = (e.target.tagName||'').toLowerCase();
    if(tag==='input' || tag==='textarea' || tag==='select' || e.target.isContentEditable){ return; }
    const target = e.target.closest('.card[data-nav]');
    if(target){
      // Evitar doble navegación si se hizo click en el botón interno
      if(e.target.closest('button')) return;
      navigate(target.dataset.nav);
    }
  });
  document.getElementById('btn-start')?.addEventListener('click', ()=>{
    const r = state.user?.role==='empresa' ? 'publicar' : state.user?.role==='transportista' ? 'ofertas' : state.user?.role==='sendix' ? 'moderacion' : 'login';
    navigate(r);
  });
  window.addEventListener('hashchange', ()=>navigate(location.hash.replace('#','')||'login'));
}
function requireRole(role){
  if(!state.user || state.user.role!==role){
    alert('Necesitás el rol adecuado para esta sección.');
    navigate('login');
    throw new Error('role required');
  }
}

// AUTH
function initLogin(){
  // Login simple (demo) por email/contraseña
  const loginForm = document.getElementById('auth-login-form');
  const openReg = document.getElementById('auth-open-register');
  const regWrap = document.getElementById('auth-register');
  const loginCtas = document.getElementById('auth-register-cta');
  const sendixRow = document.getElementById('auth-sendix-row');
  const backLogin = document.getElementById('auth-back-login');
  const regCompany = document.getElementById('register-company');
  const regCarrier = document.getElementById('register-carrier');
  const tabCompany = document.getElementById('reg-tab-company');
  const tabCarrier = document.getElementById('reg-tab-carrier');
  const cargasAll = document.getElementById('cargas-all');
  const sendixDemo = document.getElementById('auth-sendix-demo');
  const forgot = document.getElementById('auth-forgot');

  if(loginForm){
    loginForm.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const data = Object.fromEntries(new FormData(loginForm).entries());
      const emailRaw = String(data.email||'').trim();
      const email = emailRaw.toLowerCase();
      const pass = String(data.password||'');
      if(!isValidEmail(emailRaw) || pass.length<6){ alert('Completá email válido y contraseña (6+ caracteres).'); return; }
      try{
        const { user } = await API.login(email, pass);
        setSession('', user);
        navigate('home');
        return;
      }catch(err){
        console.error(err);
        alert(`No pudimos iniciar sesión: ${err?.message||err}`);
      }
    });
  }
  // Ocultar el acceso SENDIX (demo) por defecto; mostrar solo si se pasa ?demo=sendix
  try{
    const allowSendixDemo = new URLSearchParams(location.search).get('demo')==='sendix';
    const sendixRowEl = document.getElementById('auth-sendix-row');
    if(sendixRowEl) sendixRowEl.style.display = allowSendixDemo ? 'block' : 'none';
  }catch{}
  if(sendixDemo){
    sendixDemo.onclick = ()=>{ state.user = { name:'Nexo SENDIX', role:'sendix', email:'sendix@demo', password: '' }; upsertUser(state.user); save(); updateChrome(); navigate('home'); };
  }
  if(openReg){
    openReg.onclick = ()=>{
      if(regWrap) regWrap.style.display='grid';
      if(loginForm) loginForm.style.display='none';
      if(loginCtas) loginCtas.style.display='none';
      if(sendixRow) sendixRow.style.display='none';
      if(regCompany) regCompany.style.display='grid';
      if(regCarrier) regCarrier.style.display='none';
    };
  }
  if(forgot){
    forgot.onclick = async (e)=>{
      e.preventDefault();
      const mail = prompt('Ingresá tu email para restablecer:');
      if(!mail) return;
      if(!isValidEmail(mail)){ alert('Email inválido.'); return; }
      try{
        await API.forgot(String(mail).toLowerCase());
        alert('Si el email existe, te enviamos un enlace para restablecer la contraseña.');
      }catch(err){
        console.error(err);
        alert(`No pudimos procesar tu solicitud: ${err?.message||err}`);
      }
    };
  }
  if(backLogin){
    backLogin.onclick = ()=>{
      if(regWrap) regWrap.style.display='none';
      if(loginForm) loginForm.style.display='grid';
      if(loginCtas) loginCtas.style.display='flex';
      if(sendixRow) sendixRow.style.display='flex';
    };
  }
  if(tabCompany){ tabCompany.onclick = ()=>{ if(regCompany) regCompany.style.display='grid'; if(regCarrier) regCarrier.style.display='none'; } }
  if(tabCarrier){ tabCarrier.onclick = ()=>{ if(regCompany) regCompany.style.display='none'; if(regCarrier) regCarrier.style.display='grid'; } }
  if(cargasAll){
    cargasAll.addEventListener('change', ()=>{
      const boxes = regCarrier?.querySelectorAll('input[type="checkbox"][name="cargas"]');
      boxes?.forEach(b=> b.checked = cargasAll.checked);
    });
  }
  if(regCompany){
    regCompany.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const data = Object.fromEntries(new FormData(regCompany).entries());
      if(!data.terms){ alert('Debés aceptar los términos y condiciones.'); return; }
      if(!isValidEmail(data.email||'')){ alert('Ingresá un email válido.'); return; }
      try{
        const payload = { role:'empresa', name: String(data.companyName||'Empresa'), email: String(data.email||'').toLowerCase(), password: String(data.password||''), phone: String(data.phone||'')||null, taxId: String(data.taxId||'')||null };
        const { user } = await API.register(payload);
        setSession('', user);
        navigate('home');
      }catch(err){
        console.error(err);
        alert(`Registro de empresa falló: ${err?.message||err}`);
      }
    });
  }
  if(regCarrier){
    regCarrier.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const formData = new FormData(regCarrier);
      const data = Object.fromEntries(formData.entries());
      const cargas = Array.from(regCarrier.querySelectorAll('input[name="cargas"]:checked')).map(el=>el.value);
      const vehiculos = Array.from(regCarrier.querySelectorAll('input[name="vehiculos"]:checked')).map(el=>el.value);
      if(!data.terms){ alert('Debés aceptar los términos y condiciones.'); return; }
      if(!isValidEmail(data.email||'')){ alert('Ingresá un email válido.'); return; }
      if(cargas.length===0){ alert('Seleccioná al menos un tipo de carga.'); return; }
      if(vehiculos.length===0){ alert('Seleccioná al menos un tipo de vehículo.'); return; }
      const fullName = `${data.firstName||''} ${data.lastName||''}`.trim() || 'Transportista';
      try{
        const perfil = {
          cargas, vehiculos, alcance: String(data.alcance||''),
          firstName: String(data.firstName||''), lastName: String(data.lastName||''),
          dni: String(data.dni||''), seguroOk: !!regCarrier.querySelector('input[name="seguroOk"]')?.checked,
          tipoSeguro: String(data.tipoSeguro||''), senasa: !!regCarrier.querySelector('input[name="senasa"]')?.checked,
          imo: !!regCarrier.querySelector('input[name="imo"]')?.checked,
        };
        const { user } = await API.register({ role:'transportista', name: fullName, email: String(data.email||'').toLowerCase(), password: String(data.password||''), perfil });
        setSession('', user);
        navigate('home');
      }catch(err){
        console.error(err);
        alert(`Registro de transportista falló: ${err?.message||err}`);
      }
    });
  }
}
function updateChrome(){
  const badge = document.getElementById('user-badge');
  if(state.user){
    const initials = (state.user.name||'?').split(' ').map(s=>s[0]).join('').slice(0,2).toUpperCase();
    badge.innerHTML = `
      <button class="btn btn-ghost" id="open-profile" title="Perfil" style="display:inline-flex; align-items:center; gap:8px">
        <span class="avatar" style="width:28px;height:28px;font-size:12px">${initials||'?'}</span>
        <span class="muted">${state.user.name} · ${state.user.role}</span>
      </button>
      <button class="btn btn-ghost" id="logout">Salir</button>`;
  } else badge.textContent='';
  document.getElementById('logout')?.addEventListener('click', async ()=>{ try{ await API.logout(); }catch{} clearSession(); navigate('login'); });
  document.getElementById('open-profile')?.addEventListener('click', ()=> navigate('perfil'));
  document.getElementById('nav-empresa')?.classList.toggle('visible', state.user?.role==='empresa');
  document.getElementById('nav-transportista')?.classList.toggle('visible', state.user?.role==='transportista');
  document.getElementById('nav-sendix')?.classList.toggle('visible', state.user?.role==='sendix');
  // Recalcular altura de la barra inferior cuando cambie la visibilidad por rol
  updateBottomBarHeight();
}

async function fetchAdminUsers(params={}){
  try{
    const p = new URLSearchParams();
    Object.entries(params).forEach(([k,v])=>{ if(v!=null && v!=='') p.set(k,String(v)); });
    const res = await fetch(`${API.base}/api/users${p.toString()?`?${p.toString()}`:''}`, { credentials:'include' });
    if(!res.ok) throw new Error(await parseErr(res));
    const rows = await res.json();
    state.adminUsers = rows;
    save();
    return rows;
  }catch{ return []; }
}

// PERFIL propio o de terceros (solo SENDIX)
async function renderProfile(emailToView){
  const isSendix = state.user?.role==='sendix';
  const title = document.getElementById('profile-title');
  const back = document.getElementById('profile-back');
  const saveBtn = document.getElementById('profile-save');
  const form = document.getElementById('profile-form');
  if(!form) return;
  // Target: propio por defecto; si SENDIX pasó email, ver de terceros (read-only)
  const email = (emailToView || form.dataset.viewEmail || state.user?.email || '').toLowerCase();
  const viewingOther = isSendix && email && email !== String(state.user?.email||'').toLowerCase();
  // Encontrar fuente
  let me = viewingOther ? ((state.adminUsers||[]).find(u=> String(u.email||'').toLowerCase()===email) || (state.users||[]).find(u=> String(u.email||'').toLowerCase()===email)) : state.user;
  if(viewingOther && !me){
    // Intentar traerlo del backend admin
    const rows = await fetchAdminUsers({ q: email });
    me = rows.find(u=> String(u.email||'').toLowerCase()===email) || null;
  }
  if(!me){
    if(title) title.textContent = 'Perfil';
    if(back) back.onclick = ()=> navigate('home');
    if(saveBtn) saveBtn.style.display = 'none';
    form.innerHTML = '<div class="muted">Perfil no encontrado.</div>';
    return;
  }
  title.textContent = viewingOther ? `Perfil de ${me.name||me.email||'Usuario'}` : 'Mi perfil';
  if(back) back.onclick = ()=>{ if(viewingOther) navigate('usuarios'); else navigate('home'); };
  // Renderizar campos según rol
  const role = me.role||'empresa';
  function inputRow(label, name, value='', type='text', attrs=''){
    const dis = viewingOther ? 'disabled' : '';
    return `<label>${label}<input ${dis} type="${type}" name="${name}" value="${escapeHtml(value||'')}" ${attrs}/></label>`;
  }
  function checkboxRow(label, name, checked){
    const dis = viewingOther ? 'disabled' : '';
    return `<label class="radio"><input ${dis} type="checkbox" name="${name}" ${checked?'checked':''}/> ${label}</label>`;
  }
  function chips(name, options, selected){
    const dis = viewingOther ? 'disabled' : '';
    return `<fieldset class="roles"><legend>${escapeHtml(name)}</legend>`+
      options.map(opt=>`<label class="radio"><input ${dis} type="checkbox" name="opt-${name}" value="${opt}" ${selected?.includes(opt)?'checked':''}/> ${opt}</label>`).join('')+
      `</fieldset>`;
  }
  // Estructura de formulario
  let html = '';
  if(role==='empresa'){
    html += inputRow('Nombre/Empresa','companyName', (me.companyName||'') || (me.name||''));
    html += inputRow('Email','email', me.email||'', 'email');
    html += inputRow('Teléfono','phone', me.phone||'');
    html += inputRow('DNI/CUIL/CUIT','taxId', me.taxId||'');
  } else if(role==='transportista'){
    const perfil = me.perfil||{};
    const firstName = perfil.firstName || (me.name||'').split(' ')[0] || '';
    const lastName = perfil.lastName || (me.name||'').split(' ').slice(1).join(' ');
    html += `<div class="row" style="gap:8px">`+
            `<label style="flex:1">Nombre<input ${(viewingOther?'disabled':'')} name="firstName" value="${escapeHtml(perfil.firstName||firstName)}"/></label>`+
            `<label style="flex:1">Apellido<input ${(viewingOther?'disabled':'')} name="lastName" value="${escapeHtml(lastName)}"/></label>`+
            `</div>`;
    html += inputRow('Email','email', me.email||'', 'email');
    html += inputRow('DNI','dni', perfil.dni||'');
    html += chips('Tipo de carga', ['Contenedor','Granel','Carga general','Flete'], perfil.cargas||[]);
    html += chips('Tipo de vehículo', ['Liviana','Mediana','Pesada'], perfil.vehiculos||[]);
    html += checkboxRow('Seguro al día','seguroOk', !!perfil.seguroOk);
    html += inputRow('Tipo de seguro','tipoSeguro', perfil.tipoSeguro||'');
    html += checkboxRow('Habilitación SENASA','senasa', !!perfil.senasa);
    html += checkboxRow('Realiza carga IMO','imo', !!perfil.imo);
    html += inputRow('Alcance del transporte','alcance', perfil.alcance||'');
  } else {
    html += inputRow('Nombre','name', me.name||'');
    html += inputRow('Email','email', me.email||'', 'email');
  }
  form.innerHTML = html;
  if(saveBtn) saveBtn.style.display = viewingOther ? 'none' : 'inline-flex';

  // Guardado
  if(!viewingOther && saveBtn){
    saveBtn.onclick = async ()=>{
      const data = Object.fromEntries(new FormData(form).entries());
      const oldEmail = String(state.user.email||'');
      let payload = {};
      if(role==='empresa'){
        payload = { name: data.companyName||state.user.name, phone: data.phone||'', taxId: data.taxId||'' };
      } else if(role==='transportista'){
        const cargas = Array.from(form.querySelectorAll('input[name="opt-Tipo de carga"]:checked')).map(el=>el.value);
        const vehiculos = Array.from(form.querySelectorAll('input[name="opt-Tipo de vehículo"]:checked')).map(el=>el.value);
        const perfil = {
          ...(state.user.perfil||{}),
          firstName: data.firstName||'',
          lastName: data.lastName||'',
          dni: data.dni||'',
          cargas, vehiculos,
          seguroOk: !!form.querySelector('input[name="seguroOk"]')?.checked,
          tipoSeguro: data.tipoSeguro||'',
          senasa: !!form.querySelector('input[name="senasa"]')?.checked,
          imo: !!form.querySelector('input[name="imo"]')?.checked,
          alcance: data.alcance||''
        };
        const fullName = `${perfil.firstName} ${perfil.lastName}`.trim() || state.user.name;
        payload = { name: fullName, perfil };
      } else {
        payload = { name: data.name||state.user.name };
      }
      try{
        const res = await fetch(`${API.base}/api/profile`, { method:'PATCH', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload), credentials: 'include' });
        if(!res.ok) throw new Error(await res.text());
        const { user } = await res.json();
        setSession('', user);
        upsertUser(state.user);
        const newEmail = String(state.user.email||'');
        if(isValidEmail(newEmail) && oldEmail.toLowerCase()!==newEmail.toLowerCase()){
          state.users = (state.users||[]).filter(u=> String(u.email||'').toLowerCase() !== oldEmail.toLowerCase());
        }
        save(); updateChrome(); alert('Perfil actualizado');
      }catch(err){ console.error(err); alert('No pudimos actualizar el perfil ahora.'); }
    };
  }
}

// Vista de usuarios (solo SENDIX)
async function renderUsers(){
  const ul = document.getElementById('users-list');
  const empty = document.getElementById('users-empty');
  const roleSel = document.getElementById('users-role');
  const qInput = document.getElementById('users-q');
  const boxTransp = document.getElementById('users-filters-transportista');
  const cargasIn = document.getElementById('users-cargas');
  const vehiculosIn = document.getElementById('users-vehiculos');
  const seguroChk = document.getElementById('users-seguro');
  const senasaChk = document.getElementById('users-senasa');
  const imoChk = document.getElementById('users-imo');
  const alcanceIn = document.getElementById('users-alcance');
  const clearBtn = document.getElementById('users-clear');
  if(!ul) return;

  // Mostrar/ocultar filtros de transportista
  const currentRole = roleSel?.value || 'all';
  if(boxTransp) boxTransp.style.display = currentRole==='transportista' ? 'block' : 'none';

  // Cargar usuarios
  let users = [];
  try{
    const params = {
      role: currentRole==='all' ? '' : currentRole,
      q: qInput?.value?.trim() || '',
      cargas: cargasIn?.value || '',
      vehiculos: vehiculosIn?.value || '',
      seguroOk: seguroChk?.checked ? '1' : '',
      senasa: senasaChk?.checked ? '1' : '',
      imo: imoChk?.checked ? '1' : '',
      alcance: alcanceIn?.value || ''
    };
    users = await fetchAdminUsers(params);
    if(!Array.isArray(users)) users = [];
  }catch(e){
    console.warn('Fallo /api/users, uso local', e);
    users = (state.users||[]);
  }

  // Persistir para perfil
  state.adminUsers = users;
  save();

  // Render
  ul.innerHTML = users.length ? users.map(u=>{
    const initials = (u.name||'?').split(' ').map(s=>s[0]).join('').slice(0,2).toUpperCase();
    const sub = u.role==='empresa' ? (u.phone? `Tel: ${escapeHtml(u.phone)}` : '') : (u.role==='transportista' ? (u.perfil? `${(u.perfil.cargas||[]).join('/') || ''} · ${(u.perfil.vehiculos||[]).join('/') || ''}` : '') : '');
    const extras = u.role==='transportista' && u.perfil ? `
      <div class="muted small">DNI: ${escapeHtml(u.perfil.dni||'-')} · Alcance: ${escapeHtml(u.perfil.alcance||'-')} · Seguro: ${u.perfil.seguroOk?'OK':'No'}</div>
    ` : '';
    return `<li class="row">
      <div class="row" style="gap:8px; align-items:center">
        <span class="avatar" style="width:28px;height:28px;font-size:12px">${initials}</span>
        <div>
          <strong>${escapeHtml(u.name||u.email||'')}</strong>
          <div class="muted">${escapeHtml(u.role||'')} · ${escapeHtml(u.email||'')}</div>
          ${sub? `<div class="muted">${escapeHtml(sub)}</div>`:''}
          ${extras}
        </div>
      </div>
      <div class="row" style="gap:8px">
        <button class="btn" data-view-user="${escapeHtml(u.email||'')}">Ver</button>
      </div>
    </li>`;
  }).join('') : '<li class="muted">Aún no hay usuarios registrados.</li>';
  ul.querySelectorAll('[data-view-user]')?.forEach(b=> b.onclick = ()=>{ const email=b.dataset.viewUser; document.getElementById('profile-form')?.setAttribute('data-view-email', email); navigate('perfil'); renderProfile(email); });
  if(empty) empty.style.display = users.length? 'none':'block';

  // Wire eventos
  if(roleSel) roleSel.onchange = ()=> renderUsers();
  if(qInput) qInput.oninput = ()=> renderUsers();
  if(cargasIn) cargasIn.oninput = ()=> renderUsers();
  if(vehiculosIn) vehiculosIn.oninput = ()=> renderUsers();
  if(seguroChk) seguroChk.onchange = ()=> renderUsers();
  if(senasaChk) senasaChk.onchange = ()=> renderUsers();
  if(imoChk) imoChk.onchange = ()=> renderUsers();
  if(alcanceIn) alcanceIn.oninput = ()=> renderUsers();
  if(clearBtn) clearBtn.onclick = ()=>{
    if(roleSel) roleSel.value = 'all';
    if(qInput) qInput.value = '';
    if(cargasIn) cargasIn.value = '';
    if(vehiculosIn) vehiculosIn.value = '';
    if(seguroChk) seguroChk.checked = false;
    if(senasaChk) senasaChk.checked = false;
    if(imoChk) imoChk.checked = false;
    if(alcanceIn) alcanceIn.value = '';
    renderUsers();
  };
}

// EMPRESA
// API helpers
function authHeaders(){ return {}; }

function getApiBase(){
  try{
    const params = new URLSearchParams(location.search);
    const qp = params.get('api');
    if(qp){ return qp; }
    if(typeof window!=='undefined' && window.SENDIX_API_BASE){ return String(window.SENDIX_API_BASE); }
    return location.origin;
  }catch{ return location.origin; }
}
async function parseErr(res){
  try{
    const t = await res.text();
    try{ const j = JSON.parse(t); return j.error||t||res.statusText; }catch{ return t||res.statusText; }
  }catch{ return res.statusText || 'Error'; }
}
function parseErrMessage(err){
  try{
    if(typeof err==='string') return err;
    if(err && err.message) return String(err.message);
    return 'Error';
  }catch{ return 'Error'; }
}
const API = {
  base: getApiBase(),
  // --- Auth (nuevo) ---
  async login(email, password){
    const res = await fetch(`${API.base}/api/auth/login`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ email, password }), credentials: 'include' });
    if(!res.ok) throw new Error(await parseErr(res));
    return res.json();
  },
  async register(payload){
    // Enviar el payload tal cual (incluye phone, taxId o perfil según el formulario)
    const res = await fetch(`${API.base}/api/auth/register`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload), credentials: 'include' });
    if(!res.ok) throw new Error(await parseErr(res));
    return res.json();
  },
  async me(){
    const res = await fetch(`${API.base}/api/me`, { headers: { ...authHeaders() }, credentials: 'include' });
    if(!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async logout(){
    const res = await fetch(`${API.base}/api/auth/logout`, { method:'POST', credentials: 'include' });
    if(!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async forgot(email){
    const res = await fetch(`${API.base}/api/auth/forgot`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ email }), credentials: 'include' });
    if(!res.ok) throw new Error(await parseErr(res));
    return res.json();
  },
  async resetPassword(token, password){
    const res = await fetch(`${API.base}/api/auth/reset`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ token, password }), credentials: 'include' });
    if(!res.ok) throw new Error(await parseErr(res));
    return res.json();
  },
  async listLoads(opts={}){
    const p = new URLSearchParams();
    if(opts.ownerEmail) p.set('ownerEmail', String(opts.ownerEmail));
  const res = await fetch(`${API.base}/api/loads${p.toString()?`?${p.toString()}`:''}`, { headers: { ...authHeaders() }, credentials: 'include' });
    if(!res.ok) throw new Error('Error list loads');
    return res.json();
  },
  async createLoad(payload){
  const res = await fetch(`${API.base}/api/loads`, { method:'POST', headers:{'Content-Type':'application/json', ...authHeaders()}, body: JSON.stringify(payload), credentials: 'include' });
    if(!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async listProposals(params={}){
    const p = new URLSearchParams();
    Object.entries(params).forEach(([k,v])=>{ if(v!=null && v!=='') p.set(k,String(v)); });
  const res = await fetch(`${API.base}/api/proposals${p.toString()?`?${p.toString()}`:''}`, { headers: { ...authHeaders() }, credentials: 'include' });
    if(!res.ok) throw new Error('Error list proposals');
    return res.json();
  },
  async createProposal(payload){
  const res = await fetch(`${API.base}/api/proposals`, { method:'POST', headers:{'Content-Type':'application/json', ...authHeaders()}, body: JSON.stringify(payload), credentials: 'include' });
    if(!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async selectProposal(id){
  const res = await fetch(`${API.base}/api/proposals/${id}/select`, { method:'POST', headers: { ...authHeaders() }, credentials: 'include' });
    if(!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async updateProposal(id, payload){
  const res = await fetch(`${API.base}/api/proposals/${id}`, { method:'PATCH', headers:{'Content-Type':'application/json', ...authHeaders()}, body: JSON.stringify(payload), credentials: 'include' });
    if(!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async filterProposal(id){
  const res = await fetch(`${API.base}/api/proposals/${id}/filter`, { method:'POST', headers: { ...authHeaders() }, credentials: 'include' });
    if(!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async rejectProposal(id){
  const res = await fetch(`${API.base}/api/proposals/${id}/reject`, { method:'POST', headers: { ...authHeaders() }, credentials: 'include' });
    if(!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async getCommissions(params={}){
    const p = new URLSearchParams();
    Object.entries(params).forEach(([k,v])=>{ if(v!=null && v!=='') p.set(k,String(v)); });
  const res = await fetch(`${API.base}/api/commissions${p.toString()?`?${p.toString()}`:''}`, { headers: { ...authHeaders() }, credentials: 'include' });
    if(!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async updateCommission(id, payload){
  const res = await fetch(`${API.base}/api/commissions/${id}`, { method:'PATCH', headers:{'Content-Type':'application/json', ...authHeaders()}, body: JSON.stringify(payload), credentials: 'include' });
    if(!res.ok) throw new Error(await res.text());
    return res.json();
  },
  // ---- Chat ----
  async listMessages(proposalId){
    const res = await fetch(`${API.base}/api/proposals/${proposalId}/messages`, { headers: { ...authHeaders() }, credentials: 'include' });
    if(!res.ok) throw new Error(await parseErr(res));
    return res.json();
  },
  async sendMessage(proposalId, payload){
    const res = await fetch(`${API.base}/api/proposals/${proposalId}/messages`, { method:'POST', headers:{'Content-Type':'application/json', ...authHeaders()}, body: JSON.stringify(payload), credentials: 'include' });
    if(!res.ok) throw new Error(await parseErr(res));
    return res.json();
  },
  async markRead(proposalId){
    const res = await fetch(`${API.base}/api/proposals/${proposalId}/read`, { method:'POST', headers: { ...authHeaders() }, credentials: 'include' });
    if(!res.ok) throw new Error(await parseErr(res));
    return res.json();
  },
  async chatUnread(){
    const res = await fetch(`${API.base}/api/chat/unread`, { headers: { ...authHeaders() }, credentials: 'include' });
    if(!res.ok) throw new Error(await parseErr(res));
    return res.json();
  }
};

async function syncLoadsFromAPI(){
  try{
    if(!state.user) return;
    const rows = await API.listLoads();
    // Adaptar a formato local para render sin romper nada
    state.loads = rows.map(r=>({
      id: r.id,
      owner: r.owner?.name || r.ownerName || state.user.name,
      origen: r.origen,
      destino: r.destino,
      tipo: r.tipo,
      cantidad: r.cantidad ?? null,
      unidad: r.unidad || '',
      dimensiones: r.dimensiones || '',
      peso: r.peso ?? null,
      volumen: r.volumen ?? null,
      fechaHora: r.fechaHora || r.createdAt,
      descripcion: r.descripcion || '',
      adjuntos: r.attachments || [] ,
      createdAt: r.createdAt
    }));
    save();
  }catch(e){ /* fallback silencioso */ }
}

async function addLoad(load){
  // Intentar API primero; si falla, guardar localmente
  try{
    const created = await API.createLoad({
      ownerEmail: state.user?.email,
      ownerName: state.user?.name,
      origen: load.origen,
      destino: load.destino,
      tipo: load.tipo,
      cantidad: load.cantidad ?? null,
      unidad: load.unidad||'',
      dimensiones: load.dimensiones||'',
      peso: load.peso ?? null,
      volumen: load.volumen ?? null,
      fechaHora: load.fechaHora || null,
      descripcion: load.descripcion||'',
      attachments: load.adjuntos||[]
    });
    // Insertar arriba adaptado
    state.loads.unshift({
      id: created.id,
      owner: created.owner?.name || state.user.name,
      origen: created.origen,
      destino: created.destino,
      tipo: created.tipo,
      cantidad: created.cantidad ?? null,
      unidad: created.unidad || '',
      dimensiones: created.dimensiones || '',
      peso: created.peso ?? null,
      volumen: created.volumen ?? null,
      fechaHora: created.fechaHora || created.createdAt,
      descripcion: created.descripcion || '',
      adjuntos: created.attachments || [],
      createdAt: created.createdAt
    });
    save();
    return;
  }catch(e){
    const id = genId();
    state.loads.unshift({ ...load, id, owner: state.user.name, createdAt: new Date().toISOString() });
    save();
  }
}
async function syncProposalsFromAPI(){
  try{
    const rows = await API.listProposals();
    state.proposals = rows.map(r=>({
      id: r.id,
      loadId: r.loadId,
      carrier: r.carrier?.name || r.carrierName || '-',
      vehicle: r.vehicle||'',
      price: r.price ?? null,
      status: r.status,
      shipStatus: r.shipStatus || 'pendiente',
      createdAt: r.createdAt
    }));
    // Derivar comisiones desde proposals que las traen incluidas
    const commissions = rows.filter(r=> r && r.commission).map(r=>({
      id: r.commission.id,
      proposalId: r.id,
      loadId: r.loadId,
      owner: r.load?.owner?.name || '-',
      carrier: r.carrier?.name || '-',
      price: r.price ?? 0,
      rate: Number(r.commission.rate ?? COMM_RATE),
      amount: Number(r.commission.amount ?? 0),
      status: r.commission.status,
      createdAt: r.commission.createdAt,
      invoiceAt: r.commission.invoiceAt || null
    }));
    state.commissions = commissions;
    save();
  }catch(e){ /* fallback silencioso */ }
}

async function syncCommissionsFromAPI(){
  try{
    const rows = await API.getCommissions();
    // Adaptar al shape del panel actual
    state.commissions = rows.map(r=>({
      id: r.id,
      proposalId: r.proposalId,
      loadId: r.proposal?.loadId,
      owner: r.proposal?.load?.owner?.name || '-',
      carrier: r.proposal?.carrier?.name || '-',
      price: r.proposal?.price ?? 0,
      rate: Number(r.rate ?? COMM_RATE),
      amount: Number(r.amount ?? 0),
      status: r.status,
      createdAt: r.createdAt,
      invoiceAt: r.invoiceAt || null
    }));
    save();
  }catch{}
}
async function renderLoads(onlyMine=false){
  await syncLoadsFromAPI();
  const ul = document.getElementById('loads-list');
  const data = onlyMine ? state.loads.filter(l=>l.owner===state.user?.name) : state.loads;
  ul.innerHTML = data.length ? data.map(l=>`
    <li>
      <div class="row"><strong>${l.origen} ➜ ${l.destino}</strong><span>${new Date(l.createdAt).toLocaleDateString()}</span></div>
      <div class="muted">Tipo: ${l.tipo} · Cant.: ${l.cantidad? `${l.cantidad} ${l.unidad||''}`:'-'} · Dim.: ${l.dimensiones||'-'} · Peso: ${l.peso? l.peso+' kg':'-'} · Vol: ${l.volumen? l.volumen+' m³':'-'} · Fecha: ${l.fechaHora? new Date(l.fechaHora).toLocaleString(): (l.fecha||'-')} · Por: ${l.owner}</div>
      ${Array.isArray(l.adjuntos)&&l.adjuntos.length? `<div class="attachments small">${l.adjuntos.slice(0,3).map(a=> a.type?.startsWith('image/')? `<img src="${a.preview||''}" alt="adjunto"/>` : `<span class="file-chip">${a.name||'archivo'}</span>`).join('')}${l.adjuntos.length>3? `<span class="muted">+${l.adjuntos.length-3} más</span>`:''}</div>`:''}
      <div class="row"><button class="btn btn-ghost" data-view="${l.id}">Ver propuestas</button></div>
    </li>`).join('') : '<li class="muted">No hay cargas.</li>';
  ul.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click', ()=>{ navigate('mis-cargas'); renderMyLoadsWithProposals(b.dataset.view); }));
}
function initPublishForm(){
  const form = document.getElementById('publish-form');
  const preview = document.getElementById('publish-preview');
  const fileInput = document.getElementById('publish-files');
  const filePreviews = document.getElementById('file-previews');
  const fileDrop = document.getElementById('file-drop');
  const btnSelectFiles = document.getElementById('btn-select-files');
  let pendingFiles = [];
  function updatePreview() {
    const data = Object.fromEntries(new FormData(form).entries());
    if(data.origen || data.destino || data.tipo || data.cantidad || data.fechaHora || data.descripcion || pendingFiles.length) {
      preview.style.display = 'block';
      preview.innerHTML = `
        <strong>Resumen de carga:</strong><br>
        <span>📍 <b>Origen:</b> ${escapeHtml(data.origen||'-')}</span><br>
        <span>🎯 <b>Destino:</b> ${escapeHtml(data.destino||'-')}</span><br>
        <span>📦 <b>Tipo:</b> ${escapeHtml(data.tipo||'-')}</span><br>
        <span>🔢 <b>Cantidad:</b> ${escapeHtml(data.cantidad||'-')} ${escapeHtml(data.unidad||'')}</span><br>
        <span>📐 <b>Dimensiones:</b> ${escapeHtml(data.dimensiones||'-')}</span><br>
        <span>⚖️ <b>Peso:</b> ${escapeHtml(data.peso||'-')} kg · 🧪 <b>Volumen:</b> ${escapeHtml(data.volumen||'-')} m³</span><br>
        <span>📅 <b>Fecha y hora:</b> ${data.fechaHora? new Date(data.fechaHora).toLocaleString() : '-'}</span><br>
        <span>📝 <b>Comentarios:</b> ${escapeHtml(data.descripcion||'-')}</span><br>
        ${pendingFiles.length? `<div class="attachments">${pendingFiles.slice(0,4).map(a=> a.type?.startsWith('image/')? `<img src="${a.preview}" alt="adjunto"/>`:`<span class="file-chip">${escapeHtml(a.name)}</span>`).join('')} ${pendingFiles.length>4? `<span class="muted">+${pendingFiles.length-4} más</span>`:''}</div>`:''}
      `;
    } else {
      preview.style.display = 'none';
      preview.innerHTML = '';
    }
  }
  form.addEventListener('input', updatePreview);
  function renderFileCards(){
    if(!filePreviews) return;
    filePreviews.innerHTML = '';
    pendingFiles.forEach((a, idx)=>{
      const card = document.createElement('div');
      card.className = 'file-card';
      const del = document.createElement('button'); del.className = 'file-del'; del.type='button'; del.title='Quitar'; del.textContent='✕';
      del.onclick = ()=>{ pendingFiles.splice(idx,1); renderFileCards(); updatePreview(); };
      if(a.type.startsWith('image/') && a.preview){
        const img = document.createElement('img'); img.src = a.preview; img.alt = a.name; card.appendChild(img);
      } else {
        const chip = document.createElement('span'); chip.className='file-chip'; chip.textContent = a.name; card.appendChild(chip);
      }
      const info = document.createElement('div'); info.className='file-info';
      const nm = document.createElement('div'); nm.className='file-name'; nm.textContent = a.name;
      const kb = Math.max(1, Math.round((a.size||0)/1024));
      const meta = document.createElement('div'); meta.className='file-meta'; meta.textContent = `${kb} KB`;
      info.appendChild(nm); info.appendChild(meta); card.appendChild(info); card.appendChild(del);
      filePreviews.appendChild(card);
    });
    filePreviews.style.display = pendingFiles.length? 'flex':'none';
  }

  if(btnSelectFiles){ btnSelectFiles.onclick = ()=> fileInput?.click(); }
  if(fileInput){
    fileInput.addEventListener('change', ()=>{
      const files = Array.from(fileInput.files||[]);
      pendingFiles = [];
      let pendingReads = 0;
      function maybeDone(){
        if(pendingReads>0) return;
        // Render previews
        renderFileCards();
        updatePreview();
      }
      files.forEach(f=>{
        const item = { name: f.name, type: f.type||'', size: f.size||0 };
        if(f.type && f.type.startsWith('image/')){
          pendingReads++;
          const reader = new FileReader();
          reader.onload = (ev)=>{
            item.preview = String(ev.target?.result||'');
            pendingFiles.push(item);
            pendingReads--; maybeDone();
          };
          reader.onerror = ()=>{ pendingReads--; pendingFiles.push(item); maybeDone(); };
          reader.readAsDataURL(f);
        } else {
          pendingFiles.push(item);
        }
      });
      maybeDone();
    });
  }
  if(fileDrop){
    function cancel(e){ e.preventDefault(); e.stopPropagation(); }
    ['dragenter','dragover'].forEach(ev=> fileDrop.addEventListener(ev, (e)=>{ cancel(e); fileDrop.classList.add('dragover'); }));
    ;['dragleave','drop'].forEach(ev=> fileDrop.addEventListener(ev, (e)=>{ cancel(e); fileDrop.classList.remove('dragover'); }));
    fileDrop.addEventListener('drop', (e)=>{
      const dt = e.dataTransfer; const files = Array.from(dt?.files||[]);
      if(!files.length) return;
      // Merge con existentes
      const all = files; // podría limitar cantidad si se desea
      let pendingReads = 0;
      all.forEach(f=>{
        const item = { name: f.name, type: f.type||'', size: f.size||0 };
        if(f.type && f.type.startsWith('image/')){
          pendingReads++;
          const reader = new FileReader();
          reader.onload = (ev)=>{ item.preview = String(ev.target?.result||''); pendingFiles.push(item); pendingReads--; if(pendingReads===0){ renderFileCards(); updatePreview(); } };
          reader.onerror = ()=>{ pendingReads--; pendingFiles.push(item); if(pendingReads===0){ renderFileCards(); updatePreview(); } };
          reader.readAsDataURL(f);
        } else {
          pendingFiles.push(item);
        }
      });
      if(pendingReads===0){ renderFileCards(); updatePreview(); }
    });
  }
  form.addEventListener('submit', (e)=>{
    e.preventDefault();
    if(state.user?.role!=='empresa'){ alert('Ingresá como Empresa.'); return; }
    const data = Object.fromEntries(new FormData(form).entries());
    // Normalizar y guardar nuevos campos
    const load = {
      origen: (data.origen||'').trim(),
      destino: (data.destino||'').trim(),
      tipo: data.tipo||'',
      cantidad: data.cantidad? Number(data.cantidad) : null,
      unidad: data.unidad||'',
      dimensiones: (data.dimensiones||'').trim(),
      peso: data.peso? Number(data.peso) : null,
      volumen: data.volumen? Number(data.volumen) : null,
      fechaHora: data.fechaHora || null,
      descripcion: (data.descripcion||'').trim(),
      adjuntos: pendingFiles
    };
    addLoad(load);
    form.reset();
    updatePreview();
    // limpiar previews
    pendingFiles = [];
    if(filePreviews){ filePreviews.innerHTML=''; filePreviews.style.display='none'; }
    alert('¡Publicada! Esperá postulaciones que Sendix moderará.');
    navigate('mis-cargas');
  });
  updatePreview();
}
async function renderMyLoadsWithProposals(focus){
  await syncLoadsFromAPI();
  await syncProposalsFromAPI();
  const ul = document.getElementById('my-loads-with-proposals');
  const mine = state.loads.filter(l=>l.owner===state.user?.name);
  ul.innerHTML = mine.length ? mine.map(l=>{
    const approved = state.proposals.find(p=>p.loadId===l.id && p.status==='approved');
    const filtered = state.proposals.filter(p=>p.loadId===l.id && p.status==='filtered');
    const isDelivered = !!approved && (approved.shipStatus||'pendiente')==='entregado';
    // Bloque de envío seleccionado (aprobado)
    const approvedBlock = approved ? (()=>{
      const threadId = threadIdFor(approved);
      const lastMsg = [...state.messages].reverse().find(m=>m.threadId===threadId);
      const chipClass = (approved.shipStatus==='entregado') ? 'ok' : (approved.shipStatus==='en-camino' ? '' : 'warn');
      const rightActions = isDelivered
        ? `<div class="row"><span class="muted">Total</span> <strong>$${totalForCompany(approved.price).toLocaleString('es-AR')}</strong></div>`
        : `<div class="row">
             <span class="badge">Aprobada</span>
             <span class="muted">Total</span> <strong>$${totalForCompany(approved.price).toLocaleString('es-AR')}</strong>
             <button class="btn" data-approved-chat="${approved.id}">Chat</button>
             <button class="btn" data-approved-track="${approved.id}">Ver envío</button>
           </div>`;
      return `<ul class="list" style="margin-top:8px">
        <li class="row">
          <div>
            <div><strong>${approved.carrier}</strong> <span class="muted">(${approved.vehicle||'-'})</span></div>
            <div class="muted">Estado actual: <span class="chip ${chipClass}">${approved.shipStatus||'pendiente'}</span></div>
            ${lastMsg ? `<div class="muted">Último chat: ${new Date(lastMsg.ts).toLocaleString()} · ${escapeHtml(lastMsg.from||'')}: ${escapeHtml(lastMsg.text||'').slice(0,80)}${(lastMsg.text||'').length>80?'…':''}</div>` : ''}
          </div>
          ${rightActions}
        </li>
      </ul>`;
    })() : '';
    // Bloque de propuestas filtradas (solo si no hay aprobada)
    const showFiltered = !approved;
    const filteredBlock = showFiltered && filtered.length ? filtered.map(p=>{
      const threadId = threadIdFor(p);
      const lastMsg = [...state.messages].reverse().find(m=>m.threadId===threadId);
      return `<li class="row">
        <div><strong>${p.carrier}</strong> <span class="muted">(${p.vehicle})</span></div>
        <div class="row">
          <span class="badge">Filtrada por SENDIX</span>
          <span class="muted">Total</span> <strong>$${totalForCompany(p.price).toLocaleString('es-AR')}</strong>
          <button class="btn btn-primary" data-select-win="${p.id}">Seleccionar</button>
        </div>
        <div class="muted" style="flex-basis:100%">${lastMsg ? 'Último: '+new Date(lastMsg.ts).toLocaleString()+' · '+escapeHtml(lastMsg.from)+': '+escapeHtml(lastMsg.text) : 'Aún sin chat (se habilita al seleccionar).'}</div>
      </li>`;
    }).join('') : (showFiltered ? '<li class="muted">Sin propuestas filtradas por SENDIX aún.</li>' : '');
    return `<li id="load-${l.id}">
      <div class="row"><strong>${l.origen} ➜ ${l.destino}</strong><span>${new Date(l.createdAt).toLocaleDateString()}</span></div>
      <div class="muted">Tipo: ${l.tipo} · Cant.: ${l.cantidad? `${l.cantidad} ${l.unidad||''}`:'-'} · Dim.: ${l.dimensiones||'-'} · Peso: ${l.peso? l.peso+' kg':'-'} · Vol: ${l.volumen? l.volumen+' m³':'-'} · Fecha: ${l.fechaHora? new Date(l.fechaHora).toLocaleString(): (l.fecha||'-')}</div>
      ${l.descripcion? `<div class="muted">📝 ${escapeHtml(l.descripcion)}</div>`:''}
      ${Array.isArray(l.adjuntos)&&l.adjuntos.length? `<div class="attachments small">${l.adjuntos.slice(0,4).map(a=> a.type?.startsWith('image/')? `<img src="${a.preview||''}" alt="adjunto"/>` : `<span class="file-chip">${a.name||'archivo'}</span>`).join('')}${l.adjuntos.length>4? `<span class="muted">+${l.adjuntos.length-4} más</span>`:''}</div>`:''}
      ${approvedBlock ? `<div class="mt"><strong>Envío seleccionado</strong></div>${approvedBlock}` : ''}
      ${showFiltered ? `<div class="mt"><strong>Propuestas filtradas por SENDIX</strong></div>
      <ul class="list">${filteredBlock}</ul>` : ''}
    </li>`;
  }).join('') : '<li class="muted">No publicaste cargas.</li>';
  if(focus) document.getElementById('load-'+focus)?.scrollIntoView({behavior:'smooth'});
  ul.querySelectorAll('[data-select-win]')?.forEach(b=>b.addEventListener('click', ()=>{
    const id = b.dataset.selectWin;
    const winner = state.proposals.find(x=>x.id===id);
    if(!winner) return;
    (async()=>{
      try{
        await API.selectProposal(winner.id);
        await syncProposalsFromAPI();
      }catch{
        // Fallback local: aprobar una y rechazar el resto
        state.proposals.forEach(pp=>{
          if(pp.loadId===winner.loadId){
            if(pp.id===winner.id){ pp.status='approved'; pp.shipStatus = pp.shipStatus || 'pendiente'; }
            else if(pp.status!=='approved'){ pp.status='rejected'; }
          }
        });
        save();
      }
      alert('Propuesta seleccionada. Se habilitó chat y tracking del envío.');
      openChatByProposalId(winner.id);
    })();
  }));
  // Acciones sobre envío aprobado (chat / ver envío)
  ul.querySelectorAll('[data-approved-chat]')?.forEach(b=> b.addEventListener('click', ()=> openChatByProposalId(b.dataset.approvedChat)));
  ul.querySelectorAll('[data-approved-track]')?.forEach(b=> b.addEventListener('click', ()=>{ state.activeShipmentProposalId = b.dataset.approvedTrack; save(); navigate('tracking'); }));
}

// TRANSPORTISTA
async function renderOffers(){
  await syncLoadsFromAPI();
  const ul = document.getElementById('offers-list');
  // Excluir mis propias cargas y las que ya tienen una propuesta aprobada
  const approvedByLoad = new Set(state.proposals.filter(p=>p.status==='approved').map(p=>p.loadId));
  const offers = state.loads.filter(l=>l.owner!==state.user?.name && !approvedByLoad.has(l.id));

  ul.innerHTML = offers.length
    ? offers.map(l=>{
        const alreadyApplied = state.proposals.some(p=>p.loadId===l.id && p.carrier===state.user?.name);
        const formHtml = alreadyApplied
          ? `<div class="row"><span class="badge">Ya te postulaste</span></div>`
          : `<form class="row" data-apply="${l.id}">
               <input name="vehicle" placeholder="Vehículo" required autocomplete="off"/>
               <input name="price" type="number" min="0" step="100" placeholder="Precio (ARS)" required autocomplete="off"/>
               <button class="btn btn-primary">Postularse</button>
             </form>`;
        return `<li>
          <div class="row">
            <strong>${l.origen} ➜ ${l.destino}</strong>
            <span>${new Date(l.createdAt).toLocaleDateString()}</span>
          </div>
          <div class="muted">Tipo: ${l.tipo} · Cant.: ${l.cantidad? `${l.cantidad} ${l.unidad||''}`:'-'} · Dim.: ${l.dimensiones||'-'} · Peso: ${l.peso? l.peso+' kg':'-'} · Vol: ${l.volumen? l.volumen+' m³':'-'} · Fecha: ${l.fechaHora? new Date(l.fechaHora).toLocaleString(): (l.fecha||'-')} · Empresa: ${l.owner}</div>
          ${l.descripcion? `<div class="muted">📝 ${escapeHtml(l.descripcion)}</div>`:''}
          ${Array.isArray(l.adjuntos)&&l.adjuntos.length? `<div class="attachments small">${l.adjuntos.slice(0,3).map(a=> a.type?.startsWith('image/')? `<img src="${a.preview||''}" alt="adjunto"/>` : `<span class="file-chip">${a.name||'archivo'}</span>`).join('')}${l.adjuntos.length>3? `<span class="muted">+${l.adjuntos.length-3} más</span>`:''}</div>`:''}
          ${formHtml}
        </li>`;
      }).join('')
    : '<li class="muted">No hay ofertas (o ya fueron adjudicadas).</li>';

  ul.querySelectorAll('[data-apply]').forEach(form=>form.addEventListener('submit', e=>{
    e.preventDefault();
    if(state.user?.role!=='transportista'){ alert('Ingresá como Transportista.'); return; }
    const id = form.dataset.apply;
    const alreadyApplied = state.proposals.some(p=>p.loadId===id && p.carrier===state.user?.name);
    const hasApproved = state.proposals.some(p=>p.loadId===id && p.status==='approved');
    if(hasApproved){ alert('Esta carga ya fue adjudicada.'); renderOffers(); return; }
    if(alreadyApplied){ alert('Solo podés postularte una vez a cada carga.'); renderOffers(); return; }
    const data = Object.fromEntries(new FormData(form).entries());
    (async()=>{
      try{
        await API.createProposal({ loadId: id, carrierEmail: state.user.email, carrierName: state.user.name, vehicle: String(data.vehicle||''), price: Number(data.price||0) });
        await syncProposalsFromAPI();
        alert('¡Postulación enviada! Queda en revisión por SENDIX.');
      }catch{
        state.proposals.unshift({
          id: genId(), loadId:id, carrier: state.user.name,
          vehicle: data.vehicle, price: Number(data.price),
          status: 'pending', shipStatus: 'pendiente', createdAt: new Date().toISOString()
        });
        save(); alert('Postulación enviada (local).');
      }
      renderOffers();
    })();
  }));
}
function renderMyProposals(){
  const ul = document.getElementById('my-proposals');
  (async()=>{ try{ await syncProposalsFromAPI(); }catch{}; actuallyRender(); })();
  function actuallyRender(){
  const mine = state.proposals.filter(p=>p.carrier===state.user?.name);
  ul.innerHTML = mine.length ? mine.map(p=>{
    const l = state.loads.find(x=>x.id===p.loadId);
    const badge = p.status==='approved' ? 'Aprobada' : p.status==='rejected' ? 'Rechazada' : p.status==='filtered' ? 'Filtrada' : 'En revisión';
    const canChat = p.status==='approved';
    return `<li class="row">
      <div>
        <div><strong>${l?.origen} ➜ ${l?.destino}</strong></div>
        <div class="muted">Para: ${l?.owner} · ${l?.tipo} · Cant.: ${l?.cantidad? `${l?.cantidad} ${l?.unidad||''}`:'-'} · Dim.: ${l?.dimensiones||'-'} · Peso: ${l?.peso? l?.peso+' kg':'-'} · Vol: ${l?.volumen? l?.volumen+' m³':'-'} · Fecha: ${l?.fechaHora? new Date(l?.fechaHora).toLocaleString(): (l?.fecha||'-')}</div>
      </div>
      <div class="row">
        <span class="badge">${badge}</span>
        <strong>$${p.price.toLocaleString('es-AR')}</strong>
        ${canChat ? `<button class="btn" data-chat="${p.id}">Chat</button>` : ''}
      </div>
    </li>`;
  }).join('') : '<li class="muted">Sin postulaciones.</li>';
  ul.querySelectorAll('[data-chat]').forEach(b=>b.addEventListener('click', ()=>openChatByProposalId(b.dataset.chat)));
  }
}

// Envíos del transportista (tracking por envío)
function renderShipments(){
  const ul = document.getElementById('shipments');
  (async()=>{ try{ await syncProposalsFromAPI(); }catch{}; actuallyRender(); })();
  function actuallyRender(){
  const mine = state.proposals.filter(p=>p.carrier===state.user?.name && p.status==='approved');
  ul.innerHTML = mine.length ? mine.map(p=>{
    const l = state.loads.find(x=>x.id===p.loadId);
    return `<li>
      <div class="row">
        <strong>${l?.origen} ➜ ${l?.destino}</strong>
        <span class="badge">${p.shipStatus||'pendiente'}</span>
      </div>
      <div class="muted">Cliente: ${l?.owner} · ${l?.tipo} · Cant.: ${l?.cantidad? `${l?.cantidad} ${l?.unidad||''}`:'-'} · Dim.: ${l?.dimensiones||'-'} · Peso: ${l?.peso? l?.peso+' kg':'-'} · Vol: ${l?.volumen? l?.volumen+' m³':'-'} · Fecha: ${l?.fechaHora? new Date(l?.fechaHora).toLocaleString(): (l?.fecha||'-')} · Precio: $${p.price.toLocaleString('es-AR')}</div>
      <div class="row">
        <select data-ship="${p.id}">
          ${SHIP_STEPS.map(s=>`<option value="${s}" ${s===(p.shipStatus||'pendiente')?'selected':''}>${s}</option>`).join('')}
        </select>
        <button class="btn" data-save-ship="${p.id}">Actualizar estado</button>
        <button class="btn" data-chat="${p.id}">Abrir chat ${unreadBadge(threadIdFor(p))}</button>
      </div>
    </li>`;
  }).join('') : '<li class="muted">No tenés envíos aprobados aún.</li>';
  ul.querySelectorAll('[data-save-ship]').forEach(b=>b.addEventListener('click', ()=>{
    const id = b.dataset.saveShip;
    const sel = document.querySelector(`select[data-ship="${id}"]`);
    const p = state.proposals.find(x=>x.id===id);
    if(p){
      const prev = p.shipStatus || 'pendiente';
      const next = sel.value;
      (async()=>{
        try{
          await API.updateProposal(id, { shipStatus: next });
          await syncProposalsFromAPI();
        }catch{
          p.shipStatus = next; save();
        }
        if(next==='entregado' && prev!=='entregado'){
          notifyDelivered(p);
        }
        renderShipments();
        const currentRoute = (location.hash.replace('#','')||'home');
        if(currentRoute==='mis-cargas'){ try{ requireRole('empresa'); renderMyLoadsWithProposals(); }catch(e){} }
        alert('Estado actualizado');
      })();
    }
  }));
  ul.querySelectorAll('[data-chat]').forEach(b=>b.addEventListener('click', ()=>openChatByProposalId(b.dataset.chat)));
  }
}

// SENDIX: Moderación (filtrar) + acceso a chat de aprobados (cuando la empresa elija)
function renderInbox(){
  const ul = document.getElementById('inbox');
  // Sincronizar propuestas y cargas para tener contexto completo en la bandeja
  (async()=>{ try{ await syncProposalsFromAPI(); await syncLoadsFromAPI(); }catch{}; actuallyRender(); })();
  function actuallyRender(){
  // Filtros por email
  const emailInput = document.getElementById('inbox-email');
  const emailType = document.getElementById('inbox-email-type');
  const emailVal = String(emailInput?.value||'').trim().toLowerCase();
  const emailMode = String(emailType?.value||'both');
  const qInput = document.getElementById('inbox-q');
  const statusSel = document.getElementById('inbox-status');
  const q = String(qInput?.value||'').trim().toLowerCase();
  const statusFilter = String(statusSel?.value||'all');
  const matchesEmail = (p)=>{
    if(!emailVal) return true;
    const load = state.loads.find(x=>x.id===p.loadId);
    const ownerEmail = (load && load.ownerEmail) ? String(load.ownerEmail).toLowerCase() : String(p.load?.owner?.email||'').toLowerCase();
    const carrierEmail = String(p.carrier?.email||'').toLowerCase();
    if(emailMode==='owner') return ownerEmail.includes(emailVal);
    if(emailMode==='carrier') return carrierEmail.includes(emailVal);
    return ownerEmail.includes(emailVal) || carrierEmail.includes(emailVal);
  };
  const matchesQ = (p)=>{
    if(!q) return true;
    const load = state.loads.find(x=>x.id===p.loadId);
    const hay = [
      load?.owner,
      load?.origen,
      load?.destino,
      p.vehicle,
      p.carrier
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  };
  const matchesStatus = (p)=> statusFilter==='all' ? true : (p.status===statusFilter);
  // Solo propuestas que no han sido filtradas ni rechazadas
  const pending = state.proposals.filter(p=>p.status==='pending' && matchesEmail(p) && matchesQ(p) && matchesStatus(p));
  // Propuestas que han sido filtradas por SENDIX y no han sido aprobadas ni rechazadas
  const filteredList = state.proposals.filter(p=>p.status==='filtered' && matchesEmail(p) && matchesQ(p) && matchesStatus(p)).sort((a,b)=> new Date(b.createdAt) - new Date(a.createdAt));
  // Propuestas filtradas por SENDIX y aprobadas por la empresa
  const filteredAndApproved = state.proposals.filter(p=>p.status==='approved' && matchesEmail(p) && matchesQ(p) && matchesStatus(p)).sort((a,b)=> new Date(b.createdAt) - new Date(a.createdAt));
  ul.innerHTML = `<h3>Pendientes</h3>` + (pending.length ? pending.map(p=>{
    const l = state.loads.find(x=>x.id===p.loadId);
    return `<li>
      <div class="row"><strong>${p.carrier}</strong> <span class="muted">(${p.vehicle})</span> <strong>$${p.price.toLocaleString('es-AR')}</strong> <span class="muted">· Total empresa $${totalForCompany(p.price).toLocaleString('es-AR')}</span></div>
      <div class="muted">Carga: ${l?.origen} ➜ ${l?.destino} · ${l?.tipo} · Cant.: ${l?.cantidad? `${l?.cantidad} ${l?.unidad||''}`:'-'} · Dim.: ${l?.dimensiones||'-'} · Peso: ${l?.peso? l?.peso+' kg':'-'} · Vol: ${l?.volumen? l?.volumen+' m³':'-'} · Fecha: ${l?.fechaHora? new Date(l?.fechaHora).toLocaleString(): (l?.fecha||'-')} · Empresa: ${l?.owner}</div>
      <div class="actions">
        <button class="btn btn-primary" data-filter="${p.id}">Filtrar</button>
        <button class="btn" data-reject="${p.id}">Rechazar</button>
      </div>
    </li>`;
  }).join('') : '<li class="muted">No hay propuestas pendientes.</li>');
  ul.innerHTML += `<h3 class='mt'>Filtradas por SENDIX (${filteredList.length})</h3>` + (filteredList.length ? filteredList.map(p=>{
    const l = state.loads.find(x=>x.id===p.loadId);
    return `<li>
      <div class="row"><strong>${p.carrier}</strong> <span class="muted">(${p.vehicle})</span> <strong>$${p.price.toLocaleString('es-AR')}</strong> <span class="muted">· Total empresa $${totalForCompany(p.price).toLocaleString('es-AR')}</span></div>
      <div class="muted">Carga: ${l?.origen} ➜ ${l?.destino} · ${l?.tipo} · Cant.: ${l?.cantidad? `${l?.cantidad} ${l?.unidad||''}`:'-'} · Dim.: ${l?.dimensiones||'-'} · Peso: ${l?.peso? l?.peso+' kg':'-'} · Vol: ${l?.volumen? l?.volumen+' m³':'-'} · Fecha: ${l?.fechaHora? new Date(l?.fechaHora).toLocaleString(): (l?.fecha||'-')} · Empresa: ${l?.owner}</div>
      <div class="actions">
        <span class="badge">Filtrada</span>
        <button class="btn" data-unfilter="${p.id}">Quitar filtro</button>
      </div>
    </li>`;
  }).join('') : '<li class="muted">No hay propuestas filtradas.</li>');

  // Bloque: Filtradas por SENDIX y aprobadas por la empresa
  ul.innerHTML += `<h3 class='mt'>Filtradas por SENDIX y aprobadas por la empresa (${filteredAndApproved.length})</h3>` + (filteredAndApproved.length ? filteredAndApproved.map(p=>{
    const l = state.loads.find(x=>x.id===p.loadId);
    return `<li>
      <div class="row"><strong>${p.carrier}</strong> <span class="muted">(${p.vehicle||'-'})</span> <strong>$${p.price.toLocaleString('es-AR')}</strong> <span class="badge">Aprobada</span></div>
      <div class="muted">Carga: ${l?.origen} ➜ ${l?.destino} · ${l?.tipo} · Cant.: ${l?.cantidad? `${l?.cantidad} ${l?.unidad||''}`:'-'} · Dim.: ${l?.dimensiones||'-'} · Peso: ${l?.peso? l?.peso+' kg':'-'} · Vol: ${l?.volumen? l?.volumen+' m³':'-'} · Fecha: ${l?.fechaHora? new Date(l?.fechaHora).toLocaleString(): (l?.fecha||'-')} · Empresa: ${l?.owner}</div>
      <div class="actions">
        <button class="btn" data-approved-chat="${p.id}">Abrir chat</button>
      </div>
    </li>`;
  }).join('') : '<li class="muted">No hay aprobadas.</li>');

  ul.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click', ()=>{
    const id = b.dataset.filter;
    const p = state.proposals.find(x=>x.id===id);
    if(!p) return;
    (async()=>{
      try{ await API.filterProposal(id); await syncProposalsFromAPI(); }
      catch{ if(p.status==='pending'){ p.status='filtered'; save(); } }
      renderInbox(); alert('Marcada como FILTRADA. La empresa decidirá.');
    })();
  }));
  ul.querySelectorAll('[data-unfilter]').forEach(b=>b.addEventListener('click', ()=>{
    const id=b.dataset.unfilter; const p=state.proposals.find(x=>x.id===id);
    if(!p) return;
    (async()=>{
      try{ await API.updateProposal(id, { status:'pending' }); await syncProposalsFromAPI(); }
      catch{ p.status='pending'; save(); }
      renderInbox();
    })();
  }));
  ul.querySelectorAll('[data-reject]').forEach(b=>b.addEventListener('click', ()=>{
    const id = b.dataset.reject; const p = state.proposals.find(x=>x.id===id);
    if(!p) return;
    (async()=>{
      try{ await API.rejectProposal(id); await syncProposalsFromAPI(); }
      catch{ p.status='rejected'; save(); }
      renderInbox();
    })();
  }));
  }
  // Eventos de filtros
  const emailInput2 = document.getElementById('inbox-email');
  const typeSel = document.getElementById('inbox-email-type');
  const btnClear = document.getElementById('inbox-email-clear');
  if(emailInput2) emailInput2.oninput = ()=> renderInbox();
  if(typeSel) typeSel.onchange = ()=> renderInbox();
  if(btnClear) btnClear.onclick = ()=>{ if(emailInput2) emailInput2.value=''; const qEl=document.getElementById('inbox-q'); if(qEl) qEl.value=''; const st=document.getElementById('inbox-status'); if(st) st.value='all'; renderInbox(); };
  const qEl2 = document.getElementById('inbox-q');
  const stEl2 = document.getElementById('inbox-status');
  if(qEl2) qEl2.oninput = ()=> renderInbox();
  if(stEl2) stEl2.onchange = ()=> renderInbox();
}

// SENDIX/Empresa/Transportista: lista de chats aprobados
function renderThreads(){
  const ul = document.getElementById('threads');
  const q = (document.getElementById('chat-search')?.value||'').toLowerCase();
  // Sincronizar datos base en segundo plano
  (async()=>{ try{ await syncProposalsFromAPI(); await syncLoadsFromAPI(); ensureSocket(); if(socket){ const approved=(state.proposals||[]).filter(p=>p.status==='approved').map(p=>p.id); if(approved.length) socket.emit('chat:joinMany', { proposalIds: approved }); } }catch{} })();
  const myThreads = threadsForCurrentUser();
  // Obtener no leídos/último mensaje desde el backend y renderizar
  (async()=>{
    const { unreadMap, total } = await getUnreadMapForProposals(myThreads);
    updateNavUnreadBadge(total);
    const items = myThreads.map(p=>{
      const l = state.loads.find(x=>x.id===p.loadId);
      const title = `${l?.origen} → ${l?.destino}`;
      const sub = `Emp: ${l?.owner} · Transp: ${p.carrier} · Dim: ${l?.dimensiones||'-'}`;
      const unread = unreadMap[p.id]?.unread || 0;
      const match = (title+' '+sub).toLowerCase().includes(q);
      const lastTs = unreadMap[p.id]?.lastMessageAt ? new Date(unreadMap[p.id].lastMessageAt).getTime() : (p.createdAt ? new Date(p.createdAt).getTime() : 0);
      return {p, l, title, sub, unread, match, lastTs};
    }).filter(x=>x.match).sort((a,b)=> b.lastTs - a.lastTs);
    ul.innerHTML = items.length ? items.map(({p, l, title, sub, unread})=>`
    <li class="thread-item" data-chat="${p.id}">
      <div class="avatar">${(l?.owner||'?')[0]||'?'}</div>
      <div>
        <div class="thread-title">${title}</div>
        <div class="thread-sub">${sub} · ${p.shipStatus||'pendiente'}</div>
      </div>
      <div class="thread-badge">${unread?`<span class="badge-pill">${unread}</span>`:''}</div>
    </li>
  `).join('') : '<li class="muted" style="padding:12px">Sin conversaciones</li>';
    ul.querySelectorAll('[data-chat]').forEach(li=>li.addEventListener('click', ()=>openChatByProposalId(li.dataset.chat)));
    const searchEl = document.getElementById('chat-search');
    if(searchEl) searchEl.oninput = ()=>renderThreads();
    // Marcar todo como leído (en servidor y local)
    const markAll = document.getElementById('mark-all-read');
    if(markAll) markAll.onclick = ()=>{
      (async()=>{
        for(const p of threadsForCurrentUser()){
          try{ await API.markRead(p.id); }catch{}
          markThreadRead(threadIdFor(p));
        }
        renderThreads();
      })();
    };
    // Fades en la lista de hilos
    updateThreadsFades();
    ul.onscroll = updateThreadsFades;
  })();
}

function updateThreadsFades(){
  const ul = document.getElementById('threads');
  if(!ul) return;
  const atTop = ul.scrollTop <= 0;
  const atBottom = Math.abs(ul.scrollHeight - ul.clientHeight - ul.scrollTop) < 1;
  ul.classList.toggle('show-top-fade', !atTop);
  ul.classList.toggle('show-bottom-fade', !atBottom);
}

// Notificación al entregar: mensaje del sistema en el hilo para la empresa y resto de participantes
function notifyDelivered(proposal){
  const l = state.loads.find(x=>x.id===proposal.loadId);
  const threadId = threadIdFor(proposal);
  const text = `🚚 Entrega confirmada: ${l?.origen||''} → ${l?.destino||''} por ${proposal.carrier}.`;
  state.messages.push({ threadId, from: 'Sistema', role: 'sendix', text, ts: Date.now() });
  save();
  // Actualizar badges si el usuario está viendo conversaciones
  const currentRoute = location.hash.replace('#','')||'home';
  if(currentRoute==='conversaciones'){ renderThreads(); }
}

// Resumen métricas (demo)
function renderMetrics(){
  // antes de pintar, intentar sincronizar comisiones del backend
  (async()=>{ try{ await syncCommissionsFromAPI(); }catch{}; actuallyRender(); })();
  function actuallyRender(){
  const tLoads = state.loads.length;
  const tProps = state.proposals.length;
  const approved = state.proposals.filter(p=>p.status==='approved').length;
  const rejected = state.proposals.filter(p=>p.status==='rejected').length;
  const pending = state.proposals.filter(p=>p.status==='pending').length;
  const filtered = state.proposals.filter(p=>p.status==='filtered').length;
  document.getElementById('m-total-loads').textContent = tLoads;
  document.getElementById('m-total-proposals').textContent = tProps;
  document.getElementById('m-approved').textContent = approved;
  document.getElementById('m-rejected').textContent = rejected;
  document.getElementById('m-pending').textContent = pending;
  document.getElementById('m-filtered').textContent = filtered;

  // Comisiones (SENDIX)
  const comms = state.commissions||[];
  const dateForPeriod = (c)=> new Date(c.invoiceAt || c.createdAt);
  const sum = (arr)=> arr.reduce((a,b)=>a+Number(b||0),0);
  const pendingAmt = sum(comms.filter(c=>c.status==='pending').map(c=>c.amount));
  const now = Date.now();
  const days30 = 30*24*60*60*1000;
  const last30Amt = sum(comms.filter(c=>c.status==='invoiced' && c.invoiceAt && (now - new Date(c.invoiceAt).getTime()) <= days30).map(c=>c.amount));
  const elPending = document.getElementById('m-comm-pending');
  const el30 = document.getElementById('m-comm-30');
  if(elPending) elPending.textContent = '$'+ pendingAmt.toLocaleString('es-AR');
  if(el30) el30.textContent = '$'+ last30Amt.toLocaleString('es-AR');

  const list = document.getElementById('commissions-list');
  if(list){
    // Filtros de período para el detalle global
    const commPeriod = document.getElementById('comm-period');
    const commCut = document.getElementById('comm-cut');
    const commStatus = document.getElementById('comm-status');
    const commExport = document.getElementById('comm-export-csv');
    // Inicializar mes actual si vacío
    if(commPeriod && !commPeriod.value){
      const d = new Date();
      commPeriod.value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    }
    const {start: gStart, end: gEnd} = periodRange(commPeriod?.value || '', commCut?.value || 'full');
    // Items del período + estado
    let items = [...(comms||[])].filter(c=>{
      const dt = dateForPeriod(c);
      return dt>=gStart && dt<gEnd;
    }).sort((a,b)=> new Date(b.createdAt) - new Date(a.createdAt));
    const st = (commStatus?.value||'all');
    if(st!=='all') items = items.filter(c=> c.status===st);
    list.innerHTML = items.length ? items.map(c=>{
      const l = state.loads.find(x=>x.id===c.loadId);
      const status = c.status==='pending'? '<span class="badge">Pendiente</span>' : `<span class="badge ok">Facturada</span>`;
  const btn = c.status==='pending' ? `<button class="btn" data-invoice="${c.id}">Marcar facturada</button>` : (()=>{ const [f,h]=formatDatePartsForCsv(c.invoiceAt||c.createdAt); return `<span class="muted" title="${formatDateForCsv(c.invoiceAt||c.createdAt)}">${f} ${h}</span>`; })();
      return `<li class="row">
        <div>
          <div><strong>${c.carrier}</strong> <span class="muted">→ ${l?.origen||'?'} → ${l?.destino||'?'} · ${l?.owner||'-'}</span></div>
          <div class="muted">Oferta $${c.price.toLocaleString('es-AR')} · Comisión (10%) $${c.amount.toLocaleString('es-AR')} · Fecha ${formatDateForCsv(c.invoiceAt||c.createdAt)}</div>
        </div>
        <div class="row">${status} ${btn}</div>
      </li>`;
    }).join('') : '<li class="muted">Sin comisiones registradas aún.</li>';
    list.querySelectorAll('[data-invoice]')?.forEach(b=> b.addEventListener('click', ()=>{
      const id = b.dataset.invoice;
      const c = state.commissions.find(x=>x.id===id);
      if(!c) return;
      (async()=>{
        try{ await API.updateCommission(id, { status:'invoiced', invoiceAt: new Date().toISOString() }); await syncProposalsFromAPI(); }
        catch{ c.status='invoiced'; c.invoiceAt = new Date().toISOString(); save(); }
        renderMetrics();
      })();
    }));
    // Exportar CSV del detalle global (aplica filtros actuales)
    if(commExport){
      commExport.onclick = ()=>{
        const ym = commPeriod?.value || '';
        const cut = commCut?.value || 'full';
        const header = ['Transportista','Empresa','Origen','Destino','Fecha','Hora','Oferta (ARS)','Comisión (ARS)','Estado','Período'];
        const rows = [header];
        items.forEach(c=>{
          const l = state.loads.find(x=>x.id===c.loadId);
          const [fecha, hora] = formatDatePartsForCsv(c.invoiceAt||c.createdAt);
          rows.push([
            c.carrier||'',
            l?.owner||'',
            l?.origen||'',
            l?.destino||'',
            fecha,
            hora,
            Number(c.price||0),
            Number(c.amount||0),
            formatEstadoCsv(c.status),
            ym
          ]);
        });
        const csv = csvBuild(rows, ';');
        const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `comisiones_detalle_${ym}_${st}.csv`;
        document.body.appendChild(a);
        a.click();
        setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
      };
    }
    // Eventos de filtros
    if(commPeriod) commPeriod.onchange = ()=> renderMetrics();
    if(commCut) commCut.onchange = ()=> renderMetrics();
    if(commStatus) commStatus.onchange = ()=> renderMetrics();
  }
  }

  // Panel de control por transportista (mensual)
  const carrierList = document.getElementById('carrier-list');
  const periodInput = document.getElementById('carrier-period');
  const cutInput = document.getElementById('carrier-cut');
  const detailList = document.getElementById('carrier-commissions-detail');
  const carrierTotalEl = document.getElementById('carrier-total');
  const carrierCountEl = document.getElementById('carrier-count');
  const carrierEmpty = document.getElementById('carrier-empty');
  const btnInvoicePeriod = null; // eliminado por requerimiento
  const btnExportCsv = document.getElementById('carrier-export-csv');
  const adminWrap = document.getElementById('commission-admin');
  if(carrierList && periodInput && detailList && adminWrap){
    // Inicializar mes actual si está vacío
    if(!periodInput.value){
      const d = new Date();
      const ym = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      periodInput.value = ym;
    }
    // Lista de transportistas a partir de comisiones (usar snapshot local comms)
    const carriers = Array.from(new Set((comms||[]).map(c=>c.carrier).filter(Boolean))).sort((a,b)=>a.localeCompare(b));
    // Auto-seleccionar el primero si no hay seleccionado y existen transportistas
    if(!adminWrap.dataset.selectedCarrier && carriers.length){
      adminWrap.dataset.selectedCarrier = carriers[0];
    }
    carrierList.innerHTML = carriers.length ? carriers.map(name=>{
      const selected = adminWrap.dataset.selectedCarrier===name;
      // Sumar del período/corte seleccionado para badge
      const {start,end} = periodRange(periodInput.value, cutInput?.value||'full');
      const totalMonth = sum((comms||[]).filter(c=>c.carrier===name && dateForPeriod(c)>=start && dateForPeriod(c)<end).map(c=>c.amount));
      const badge = totalMonth ? `<span class="badge-pill">$${totalMonth.toLocaleString('es-AR')}</span>` : '';
      return `<li class="row ${selected?'active':''}" data-carrier="${name}"><strong>${name}</strong>${badge}</li>`;
    }).join('') : '<li class="muted">Sin transportistas aún.</li>';
    // Selección
    carrierList.querySelectorAll('[data-carrier]')?.forEach(li=> li.onclick = ()=>{
      adminWrap.dataset.selectedCarrier = li.dataset.carrier;
      renderMetrics();
    });
  // Cambios de período/corte
  periodInput.onchange = ()=> renderMetrics();
  if(cutInput) cutInput.onchange = ()=> renderMetrics();

    // Render detalle del seleccionado
    const selected = adminWrap.dataset.selectedCarrier || '';
    if(!selected){
      carrierEmpty.style.display = 'block';
      detailList.innerHTML = '';
      if(carrierTotalEl) carrierTotalEl.textContent = '$0';
      if(carrierCountEl) carrierCountEl.textContent = '0';
      if(btnInvoicePeriod) btnInvoicePeriod.disabled = true;
    } else {
      carrierEmpty.style.display = 'none';
      const {start,end} = periodRange(periodInput.value, cutInput?.value||'full');
      // Filtrar por fecha de invoice si existe; si no, por createdAt
      const items = (comms||[]).filter(c=> c.carrier===selected && dateForPeriod(c)>=start && dateForPeriod(c)<end );
      const total = sum(items.map(c=>c.amount));
      if(carrierTotalEl) carrierTotalEl.textContent = '$'+ total.toLocaleString('es-AR');
      if(carrierCountEl) carrierCountEl.textContent = String(items.length);
      detailList.innerHTML = items.length ? items.map(c=>{
        const l = state.loads.find(x=>x.id===c.loadId);
        const status = c.status==='pending'? '<span class="badge">Pendiente</span>' : `<span class="badge ok">Facturada</span>`;
        return `<li class="row">
          <div>
            <div><strong>${l?.origen||'?'} → ${l?.destino||'?'}</strong> <span class="muted">(${l?.owner||'-'})</span></div>
            <div class="muted">Oferta $${c.price.toLocaleString('es-AR')} · Comisión 10% $${c.amount.toLocaleString('es-AR')} · Fecha ${formatDateForCsv(c.invoiceAt||c.createdAt)}</div>
          </div>
          <div>${status}</div>
        </li>`;
      }).join('') : '<li class="muted">Sin comisiones en el período seleccionado.</li>';
      // Botón de marcar período como facturado eliminado
      if(btnExportCsv){
        btnExportCsv.disabled = !items.length;
        btnExportCsv.onclick = ()=>{
          const ym = periodInput.value || '';
          const cut = (cutInput?.value||'full');
          const header = ['Transportista','Empresa','Origen','Destino','Fecha','Hora','Oferta (ARS)','Comisión (ARS)','Estado','Período'];
          const rows = [header];
          items.forEach(c=>{
            const l = state.loads.find(x=>x.id===c.loadId);
            const [fecha, hora] = formatDatePartsForCsv(c.invoiceAt||c.createdAt);
            rows.push([
              selected,
              l?.owner||'',
              l?.origen||'',
              l?.destino||'',
              fecha,
              hora,
              Number(c.price||0),
              Number(c.amount||0),
              formatEstadoCsv(c.status),
              ym
            ]);
          });
          const csv = csvBuild(rows, ';');
          const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `comisiones_${selected}_${ym}.csv`;
          document.body.appendChild(a);
          a.click();
          setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
        };
      }
    }
  }
}

// Helper de rango mensual [start, end) para un valor input type=month (YYYY-MM)
function monthRange(ym){
  // ym como '2025-09'
  const [y,m] = String(ym||'').split('-').map(n=>parseInt(n,10));
  const year = isFinite(y) ? y : new Date().getFullYear();
  const month = isFinite(m) ? (m-1) : new Date().getMonth();
  const start = new Date(year, month, 1, 0,0,0,0);
  const end = new Date(year, month+1, 1, 0,0,0,0);
  return {start, end};
}

// Rango por corte: full, q1 (1-15), q2 (16-fin)
function periodRange(ym, cut){
  const {start, end} = monthRange(ym);
  if(cut==='q1'){
    return { start, end: new Date(start.getFullYear(), start.getMonth(), 16, 0,0,0,0) };
  }
  if(cut==='q2'){
    return { start: new Date(start.getFullYear(), start.getMonth(), 16, 0,0,0,0), end };
  }
  return {start, end};
}

// CSV helpers
function csvEscape(v){
  const s = String(v==null? '': v);
  const needs = /[",\n]/.test(s);
  const esc = s.replaceAll('"','""');
  return needs ? '"'+esc+'"' : esc;
}

function csvBuild(rows, delimiter=','){
  // Incluir BOM para Excel, línea de separador y CRLF
  const sep = delimiter || ',';
  const lines = rows.map(r=> r.map(cell=> csvEscape(cell)).join(sep)).join('\r\n');
  const bom = '\uFEFF';
  const meta = `sep=${sep}\r\n`;
  return bom + meta + lines + '\r\n';
}

function formatDateForCsv(date){
  const d = new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  const hh = String(d.getHours()).padStart(2,'0');
  const mi = String(d.getMinutes()).padStart(2,'0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

// Devuelve partes separadas para Excel-friendly: dd/mm/yyyy y HH:MM (24h)
function formatDatePartsForCsv(date){
  try{
    const d = new Date(date);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    const hh = String(d.getHours()).padStart(2,'0');
    const mi = String(d.getMinutes()).padStart(2,'0');
    return [`${dd}/${mm}/${yyyy}`, `${hh}:${mi}`];
  }catch{
    return ['', ''];
  }
}

function formatEstadoCsv(status){
  const s = String(status||'').toLowerCase();
  if(s==='invoiced') return 'Facturada';
  if(s==='pending') return 'Pendiente';
  return s ? (s[0].toUpperCase()+s.slice(1)) : '';
}

// Chat (mediación) — por hilo (loadId + carrier) con SENDIX como 3er participante
function openChatByProposalId(propId){
  const p = state.proposals.find(x=>x.id===propId);
  state.activeThread = p ? threadIdFor(p) : null;
  state.justOpenedChat = true;
  save();
  navigate('conversaciones');
  if(state.activeThread) markThreadRead(state.activeThread);
}
function renderChat(){
  const box = document.getElementById('chat-box');
  const title = document.getElementById('chat-title');
  const topic = document.getElementById('chat-topic');
  const typing = document.getElementById('typing-indicator');
  const replyBar = document.getElementById('reply-bar');
  const replySnippet = document.getElementById('reply-snippet');
  const attachPreviews = document.getElementById('attach-previews');
  const contextMenu = document.getElementById('context-menu');
  const chatForm = document.getElementById('chat-form');
  const backBtn = document.getElementById('chat-back');
  if(!state.activeThread){
    box.innerHTML = '<div class="muted">Elegí una conversación.</div>';
  title.textContent='Elegí una conversación'; topic.textContent='';
    typing.style.display='none'; replyBar.style.display='none'; attachPreviews.style.display='none';
    chatForm.style.display='none';
    if(backBtn) backBtn.style.display='none';
    return;
  }
  if(backBtn) backBtn.style.display='inline-flex';
  chatForm.style.display='flex';
  const p = state.proposals.find(x=>threadIdFor(x)===state.activeThread);
  if(!p){ box.innerHTML='<div class="muted">Conversación no disponible.</div>'; return; }
  const l = state.loads.find(x=>x.id===p.loadId);
  title.textContent = `${l.origen} → ${l.destino}`;
  topic.textContent = `Empresa: ${l.owner} · Transportista: ${p.carrier} · Dimensiones: ${l.dimensiones||'-'} · Nexo: SENDIX`;
  // Sincronizar mensajes del backend para esta propuesta y re-render si cambian
  (async()=>{
    try{
      const serverMsgs = await API.listMessages(p.id);
      const mapped = serverMsgs.map(m=>({
        id: m.id,
        threadId: state.activeThread,
        from: m.from?.name || '-',
        role: m.from?.role || '-',
        text: m.text || '',
        ts: m.createdAt ? new Date(m.createdAt).getTime() : Date.now(),
        replyToId: m.replyToId || null,
        attach: Array.isArray(m.attachments) ? m.attachments : []
      }));
      const localThreadMsgs = state.messages.filter(mm=> mm.threadId===state.activeThread);
      const localLast = localThreadMsgs.length? localThreadMsgs[localThreadMsgs.length-1].ts : 0;
      const srvLast = mapped.length? mapped[mapped.length-1].ts : 0;
      if(localThreadMsgs.length !== mapped.length || localLast !== srvLast){
        // Reemplazar los del hilo activo
        state.messages = state.messages.filter(mm=> mm.threadId!==state.activeThread).concat(mapped);
        save();
        renderChat(); // re-render con datos nuevos
        renderThreads(); // actualizar badges
        return;
      }
    }catch{}
  })();
  const msgs = state.messages.filter(m=>m.threadId===state.activeThread).sort((a,b)=>a.ts-b.ts);
  box.innerHTML = msgs.map(m=>{
    const reply = m.replyToId ? msgs.find(x=>x.id===m.replyToId) : null;
    const replyHtml = reply ? `<div class="bubble-reply"><strong>${reply.from}</strong>: ${escapeHtml(reply.text).slice(0,120)}${reply.text.length>120?'…':''}</div>` : '';
    const atts = Array.isArray(m.attach)||m.attach? (m.attach||[]) : [];
    const attHtml = atts.length? `<div class="attachments">${atts.map(src=>`<img src="${src}" alt="adjunto"/>`).join('')}</div>` : '';
    return `<div class="bubble ${m.from===state.user?.name?'me':'other'}" data-ts="${m.ts}">
      ${replyHtml}
      <strong>${escapeHtml(m.from)} (${escapeHtml(m.role)})</strong><br>${linkify(escapeHtml(m.text))}
      ${attHtml}
      <br><span class="muted" style="font-size:11px">${new Date(m.ts).toLocaleString()}</span>
    </div>`;
  }).join('') || '<div class="muted">Sin mensajes aún.</div>';
  box.scrollTop = box.scrollHeight;
  updateChatFades();
  // Marcar leído en servidor y local
  (async()=>{ try{ await API.markRead(p.id); }catch{}; markThreadRead(state.activeThread); })();
  const form = document.getElementById('chat-form');
  const ta = document.getElementById('chat-textarea');
  // Autosize textarea
  function autoresize(){ if(!ta) return; ta.style.height='auto'; ta.style.height = Math.min(160, Math.max(40, ta.scrollHeight)) + 'px'; }
  if(ta) ta.oninput = (e)=>{ autoresize(); showTyping(); };
  autoresize();

  // Enviar con Enter, saltos con Shift+Enter
  if(ta) ta.onkeydown = (e)=>{
    if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); form.requestSubmit(); }
  };

  // (quick replies removidos)

  // Adjuntos
  const btnAttach = document.getElementById('btn-attach');
  const inputAttach = document.getElementById('file-attach');
  let tempAttach = [];
  if(btnAttach) btnAttach.onclick = ()=> inputAttach?.click();
  if(inputAttach) inputAttach.onchange = ()=>{
    const files = Array.from(inputAttach.files||[]);
    tempAttach = [];
    attachPreviews.innerHTML = '';
    files.slice(0,6).forEach(f=>{
      const url = URL.createObjectURL(f);
      tempAttach.push(url);
      const img = document.createElement('img');
      img.src = url; img.alt='adjunto';
      attachPreviews.appendChild(img);
    });
    attachPreviews.style.display = tempAttach.length? 'flex':'none';
  };

  // Reply a mensaje
  let replyToMsg = null;
  function setReply(m){ replyToMsg = m||null; if(replyToMsg){ replyBar.style.display='flex'; replySnippet.textContent = m.text.slice(0,120); } else { replyBar.style.display='none'; replySnippet.textContent=''; } }
  const replyCancel = document.getElementById('reply-cancel');
  if(replyCancel) replyCancel.onclick = ()=> setReply(null);
  // Menú contextual sobre mensajes
  box.querySelectorAll('.bubble')?.forEach(bub=>{
    bub.addEventListener('contextmenu', (e)=>{
      e.preventDefault();
      const ts = Number(bub.dataset.ts);
      const msg = msgs.find(x=>x.ts===ts);
      if(!msg) return;
      openContextMenu(e.pageX, e.pageY, msg);
    });
    // En móvil: long press
    let t; let startX=0; let startY=0; let swiped=false;
    const THRESH=56;
    bub.addEventListener('touchstart', (e)=>{
      swiped=false; startX=e.touches[0].clientX; startY=e.touches[0].clientY;
      t=setTimeout(()=>{ const ts=Number(bub.dataset.ts); const msg=msgs.find(x=>x.ts===ts); if(msg) openContextMenu(e.touches[0].pageX, e.touches[0].pageY, msg); }, 550);
    }, {passive:true});
    bub.addEventListener('touchmove', (e)=>{
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if(Math.abs(dy) > 30) { clearTimeout(t); return; }
      if(dx > 8 && !swiped){ bub.style.transform = `translateX(${Math.min(dx, THRESH)}px)`; }
      if(dx > THRESH && !swiped){
        swiped=true; clearTimeout(t);
        const ts=Number(bub.dataset.ts); const msg=msgs.find(x=>x.ts===ts); if(msg) setReply(msg);
        bub.style.transform = '';
      }
    }, {passive:true});
    bub.addEventListener('touchend', ()=>{ clearTimeout(t); bub.style.transform=''; });
  });

  function openContextMenu(x,y,msg){
    contextMenu.style.display='grid';
    contextMenu.style.left = x+'px';
    contextMenu.style.top = y+'px';
    const off = (ev)=>{ if(!contextMenu.contains(ev.target)) { contextMenu.style.display='none'; document.removeEventListener('click', off); } };
    document.addEventListener('click', off);
    contextMenu.querySelector('[data-action="reply"]').onclick = ()=>{ setReply(msg); contextMenu.style.display='none'; };
    contextMenu.querySelector('[data-action="copy"]').onclick = ()=>{ navigator.clipboard?.writeText(msg.text); contextMenu.style.display='none'; };
    contextMenu.querySelector('[data-action="delete"]').onclick = ()=>{
      // eliminar localmente (solo para mí): en demo, borramos del array
      const idx = state.messages.findIndex(m=>m.ts===msg.ts && m.threadId===state.activeThread);
      if(idx>=0){ state.messages.splice(idx,1); save(); renderChat(); }
      contextMenu.style.display='none';
    };
  }

  form.onsubmit = (e)=>{
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const text = String(data.message||'').trim();
    if(!text) return;
    (async()=>{
      try{
        const payload = { text, attachments: tempAttach.length? [...tempAttach] : undefined };
        if(replyToMsg?.id) payload.replyToId = replyToMsg.id;
        const created = await API.sendMessage(p.id, payload);
        const mapped = {
          id: created.id,
          threadId: state.activeThread,
          from: created.from?.name || state.user.name,
          role: created.from?.role || state.user.role,
          text: created.text,
          ts: created.createdAt ? new Date(created.createdAt).getTime() : Date.now(),
          replyToId: created.replyToId || null,
          attach: Array.isArray(created.attachments) ? created.attachments : (tempAttach||[])
        };
        state.messages.push(mapped);
        save();
        form.reset(); autoresize(); hideTyping(); setReply(null);
        tempAttach.splice(0); attachPreviews.innerHTML=''; attachPreviews.style.display='none'; inputAttach.value='';
        renderChat();
        renderThreads();
      }catch(err){ alert(parseErrMessage(err)); }
    })();
  };
  document.getElementById('open-related-tracking').onclick = ()=>{
    state.activeShipmentProposalId = p.id;
    navigate('tracking');
  };
  // Fades en scroll
  box.onscroll = updateChatFades;
  // Ocultar indicador si se hace clic fuera del textarea de chat
  document.addEventListener('click', (ev)=>{
    const insideChat = ev.target.closest && (ev.target.closest('.chat-input') || ev.target.closest('#chat-box'));
    if(!insideChat){ hideTyping(); }
  }, { once: true, capture: true });
  if(ta){ ta.addEventListener('blur', hideTyping); }
  reflectMobileChatState();
}

function reflectMobileChatState(){
  const routeIsChat = (location.hash.replace('#','')||'home')==='conversaciones';
  const hasActive = !!state.activeThread;
  document.body.classList.toggle('chat-has-active', routeIsChat && hasActive);
}

function updateChatFades(){
  const box = document.getElementById('chat-box');
  if(!box) return;
  const atTop = box.scrollTop <= 0;
  const atBottom = Math.abs(box.scrollHeight - box.clientHeight - box.scrollTop) < 1;
  box.classList.toggle('show-top-fade', !atTop);
  box.classList.toggle('show-bottom-fade', !atBottom);
}

// Indicador de escritura (simulado local)
let typingTimeout;
function showTyping(){
  const el = document.getElementById('typing-indicator');
  if(!el) return;
  // Mostrar solo si estamos en conversaciones y hay textarea activo
  const route = (location.hash.replace('#','')||'home');
  const ta = document.getElementById('chat-textarea');
  if(route!=='conversaciones' || !ta){ return; }
  el.style.display = 'block';
  el.textContent = 'Escribiendo…';
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(hideTyping, 1200);
}
function hideTyping(){
  const el = document.getElementById('typing-indicator');
  if(!el) return;
  el.style.display = 'none';
  clearTimeout(typingTimeout);
}

// Tracking global por envío
function renderTracking(){
  // sincronizar en segundo plano
  (async()=>{ try{ await syncProposalsFromAPI(); }catch{} })();
  const hint = document.getElementById('tracking-role-hint');
  const actions = document.getElementById('tracking-actions');
  const onlyActive = document.getElementById('tracking-only-active');
  const search = document.getElementById('tracking-search');

  let options = [];
  if(state.user?.role==='transportista'){
    options = state.proposals.filter(p=>p.carrier===state.user.name && p.status==='approved');
    hint.textContent = options.length ? 'Podés actualizar el estado del envío seleccionado.' : 'No tenés envíos aprobados.';
  } else if(state.user?.role==='empresa'){
    const myLoadIds = state.loads.filter(l=>l.owner===state.user.name).map(l=>l.id);
    options = state.proposals.filter(p=>myLoadIds.includes(p.loadId) && p.status==='approved');
    hint.textContent = options.length ? 'Vista de estado. Solo lectura.' : 'No hay envíos aprobados aún.';
  } else if(state.user?.role==='sendix'){
    options = state.proposals.filter(p=>p.status==='approved');
    hint.textContent = options.length ? 'Vista de nexo. Solo lectura.' : 'No hay envíos aprobados.';
  }

  const activeFilter = (p)=> (p.shipStatus||'pendiente') !== 'entregado';
  let filtered = options.filter(p => onlyActive?.checked ? activeFilter(p) : true);

  const q = (search?.value||'').toLowerCase();
  if(q){
    filtered = filtered.filter(p=>{
      const l = state.loads.find(x=>x.id===p.loadId);
      const text = `${l?.origen||''} ${l?.destino||''} ${p.carrier||''} ${l?.owner||''}`.toLowerCase();
      return text.includes(q);
    });
  }

  if(!filtered.length){
    state.activeShipmentProposalId = null;
  } else if(!state.activeShipmentProposalId || !filtered.find(p=>p.id===state.activeShipmentProposalId)){
    state.activeShipmentProposalId = filtered[0].id;
  }

  const ul = document.getElementById('tracking-list');
  if(!ul) return;
  ul.innerHTML = filtered.length ? filtered.map(p=>{
    const l = state.loads.find(x=>x.id===p.loadId);
    const threadId = threadIdFor(p);
    const unread = computeUnread(threadId);
    const chipClass = (p.shipStatus==='entregado') ? 'ok' : (p.shipStatus==='en-camino'?'':'warn');
    return `<li>
      <div class="row">
        <div class="title">${l?.origen} → ${l?.destino}</div>
        <span class="chip ${chipClass}">${p.shipStatus||'pendiente'}</span>
      </div>
      <div class="row subtitle">
  <div>Emp: ${l?.owner} · Transp: ${p.carrier} · Dim: ${l?.dimensiones||'-'}</div>
        <div class="row" style="gap:8px">
          <button class="btn" data-select="${p.id}">Ver</button>
          <button class="btn" data-chat="${p.id}">Chat ${unread?`<span class='badge-pill'>${unread}</span>`:''}</button>
        </div>
      </div>
    </li>`;
  }).join('') : '<li class="muted">No hay envíos para mostrar.</li>';
  ul.querySelectorAll('[data-select]').forEach(b=> b.onclick = ()=>{ state.activeShipmentProposalId = b.dataset.select; save(); renderTracking(); });
  ul.querySelectorAll('[data-chat]').forEach(b=> b.onclick = ()=>openChatByProposalId(b.dataset.chat));

  // Tracking visual (SVG animado)
  const current = state.proposals.find(p=>p.id===state.activeShipmentProposalId);
  const mapBox = document.getElementById('tracking-map');
  if(mapBox){
    mapBox.innerHTML = '';
    if(current){
      const l = state.loads.find(x=>x.id===current.loadId);
      const stepNames = ['pendiente','en-carga','en-camino','entregado'];
      const idxTarget = stepNames.indexOf(current.shipStatus||'pendiente');
      // SVG con fondo tipo mapa y animación de camión
      mapBox.innerHTML = `
        <svg id="svg-tracking" viewBox="0 0 600 180" width="100%" height="180" style="background: linear-gradient(135deg,#eaf1f6 60%,#cfe5e8 100%); border-radius:16px;">
          <defs>
            <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="3" stdDeviation="2" flood-color="#0E2F44" flood-opacity=".25"/>
            </filter>
          </defs>
          <rect x="40" y="90" width="520" height="12" rx="6" fill="#d0e6f7" stroke="#b3cde0" />
          <polyline points="40,96 120,60 200,96 280,60 360,96 440,60 560,96" fill="none" stroke="#3AAFA9" stroke-width="4" stroke-dasharray="8 6" />
          <circle class="tracking-step ${idxTarget>0?'done':idxTarget===0?'active':''}" cx="40" cy="96" r="16" fill="#fff" stroke="#0E2F44" stroke-width="3" />
          <circle class="tracking-step ${idxTarget>1?'done':idxTarget===1?'active':''}" cx="200" cy="96" r="16" fill="#fff" stroke="#0E2F44" stroke-width="3" />
          <circle class="tracking-step ${idxTarget>2?'done':idxTarget===2?'active':''}" cx="360" cy="96" r="16" fill="#fff" stroke="#0E2F44" stroke-width="3" />
          <circle class="tracking-step ${idxTarget>3?'done':idxTarget===3?'active':''}" cx="560" cy="96" r="16" fill="#fff" stroke="#0E2F44" stroke-width="3" />
          <text x="40" y="140" text-anchor="middle" font-size="15" fill="#5A6C79">${l?.origen || 'Origen'}</text>
          <text x="200" y="140" text-anchor="middle" font-size="15" fill="#5A6C79">En carga</text>
          <text x="360" y="140" text-anchor="middle" font-size="15" fill="#5A6C79">En camino</text>
          <text x="560" y="140" text-anchor="middle" font-size="15" fill="#5A6C79">${l?.destino || 'Destino'}</text>
          <!-- Camión inline (grupo) centrado en su posición con transform -->
          <g id="tracking-truck" transform="translate(40,96)" filter="url(#shadow)">
            <!-- Chasis -->
            <rect x="-22" y="-12" width="30" height="18" rx="3" fill="#0E2F44" />
            <!-- Cabina -->
            <rect x="8" y="-10" width="20" height="14" rx="2" fill="#3AAFA9" />
            <rect x="8" y="-10" width="7" height="10" fill="#ffffff" opacity="0.9" />
            <!-- Ruedas -->
            <circle cx="-10" cy="6" r="5" fill="#333" />
            <circle cx="12" cy="6" r="5" fill="#333" />
            <circle cx="-10" cy="6" r="2" fill="#888" />
            <circle cx="12" cy="6" r="2" fill="#888" />
          </g>
        </svg>
      `;
      // Animación JS para mover el camión
      setTimeout(()=>{
        const truck = document.getElementById('tracking-truck');
        if(truck){
          const steps = [40, 200, 360, 560];
          const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          // Animar desde el paso previo guardado hacia el actual (por envío)
          const lastId = mapBox.dataset.prevId || '';
          let startIdx = parseInt(mapBox.dataset.prevIdx||'0');
          if(lastId !== current.id) startIdx = 0;
          const endIdx = idxTarget < 0 ? 0 : idxTarget;
          const startX = steps[Math.max(0, Math.min(steps.length-1, startIdx))];
          const endX = steps[Math.max(0, Math.min(steps.length-1, endIdx))];
          // Guardar como nuevo punto de partida para la siguiente transición
          mapBox.dataset.prevIdx = String(endIdx);
          mapBox.dataset.prevId = current.id;

          const pathY = 96; // línea central de los hitos
          const amplitude = reduceMotion ? 6 : 18; // altura de la onda senoidal
          const cycles = reduceMotion ? 1 : 2.2; // cantidad de ondas en el trayecto
          const totalFrames = reduceMotion ? 30 : 60;
          let frame = 0;
          const easeInOut = (t)=> t<0.5 ? 2*t*t : -1+(4-2*t)*t; // suavizado
          function animate(){
            frame++;
            const t = Math.min(frame/totalFrames, 1);
            const te = easeInOut(t);
            const x = startX + (endX-startX)*te;
            const yOffset = amplitude * Math.sin(2*Math.PI*cycles*te);
            const y = pathY + yOffset;
            // Rotación leve según la pendiente de la onda: dy/dx
            let angle = 0;
            if(!reduceMotion){
              const dYdX = (amplitude * (2*Math.PI*cycles) * Math.cos(2*Math.PI*cycles*te)) / Math.max(1, Math.abs(endX-startX));
              angle = Math.atan2(dYdX, 1) * (180/Math.PI);
              angle = Math.max(-18, Math.min(18, angle));
            }
            truck.setAttribute('transform', `translate(${x},${y}) rotate(${angle})`);
            if(frame < totalFrames) requestAnimationFrame(animate);
          }
          if(Math.abs(endX-startX) < 0.5){
            // Pequeña oscilación en el lugar
            const wiggleFrames = 35; let f=0;
            function wiggle(){
              f++;
              const t = f/wiggleFrames;
              const y = pathY + (amplitude/2) * Math.sin(2*Math.PI*1*t);
              truck.setAttribute('transform', `translate(${endX},${y}) rotate(0)`);
              if(f<wiggleFrames) requestAnimationFrame(wiggle);
            }
            wiggle();
          } else {
            animate();
          }
        }
      }, 100);
    }
  }

  const canEdit = state.user?.role==='transportista' && !!current && current.carrier===state.user.name;
  if(actions) actions.style.display = canEdit ? 'flex' : 'none';

  const btnAdvance = document.querySelector('[data-advance]');
  if(btnAdvance) btnAdvance.onclick = ()=>{
    if(!current) return;
    const prev = current.shipStatus || 'pendiente';
    const idx = SHIP_STEPS.indexOf(prev);
    const next = SHIP_STEPS[Math.min(idx+1, SHIP_STEPS.length-1)];
    current.shipStatus = next;
    state.trackingStep = next;
    save();
    if(next==='entregado' && prev!=='entregado'){
      notifyDelivered(current);
    }
    renderTracking();
    // Refrescar 'mis-cargas' si está visible para que muestre entregado
    const currentRoute2 = (location.hash.replace('#','')||'home');
    if(currentRoute2==='mis-cargas'){ try{ requireRole('empresa'); renderMyLoadsWithProposals(); }catch(e){} }
  };
  const btnReset = document.querySelector('[data-reset]');
  if(btnReset) btnReset.onclick = ()=>{
    if(!current) return;
    current.shipStatus = 'pendiente';
    state.trackingStep = current.shipStatus;
    save(); renderTracking();
    const currentRoute3 = (location.hash.replace('#','')||'home');
    if(currentRoute3==='mis-cargas'){ try{ requireRole('empresa'); renderMyLoadsWithProposals(); }catch(e){} }
  };
  const btnOpenChat = document.getElementById('tracking-open-chat');
  if(btnOpenChat) btnOpenChat.onclick = ()=>{ if(current) openChatByProposalId(current.id); };
  if(onlyActive) onlyActive.onchange = ()=>renderTracking();
  if(search) search.oninput = ()=>renderTracking();
}

// Home visibility by role
function renderHome(){
  // sincronizar en segundo plano para actualizar badges
  (async()=>{ try{ await syncProposalsFromAPI(); }catch{} })();
  if(state.user?.role==='sendix'){
    (async()=>{
      const threads = state.proposals.filter(p=>p.status==='approved');
      const { total } = await getUnreadMapForProposals(threads);
      updateNavUnreadBadge(total);
    })();
  }
  document.getElementById('cards-empresa').style.display = state.user?.role==='empresa' ? 'grid' : 'none';
  document.getElementById('cards-transportista').style.display = state.user?.role==='transportista' ? 'grid' : 'none';
  document.getElementById('cards-sendix').style.display = state.user?.role==='sendix' ? 'grid' : 'none';

  // Badges por rol
  if(state.user?.role==='empresa'){
    const myLoads = state.loads.filter(l=>l.owner===state.user.name).length;
    const myApproved = state.proposals.filter(p=>state.loads.find(l=>l.id===p.loadId && l.owner===state.user.name) && p.status==='approved');
    const trackingActivos = myApproved.filter(p=>(p.shipStatus||'pendiente')!=='entregado').length;
    const b1 = document.getElementById('badge-empresa-mis-cargas');
    const b2 = document.getElementById('badge-empresa-tracking');
    if(b1) setBadgeValue(b1, myLoads);
    if(b2) setBadgeValue(b2, trackingActivos);
  }
  if(state.user?.role==='transportista'){
    const approvedByLoad = new Set(state.proposals.filter(p=>p.status==='approved').map(p=>p.loadId));
    const ofertas = state.loads.filter(l=>l.owner!==state.user?.name && !approvedByLoad.has(l.id)).length;
    const misPost = state.proposals.filter(p=>p.carrier===state.user?.name).length;
    const misEnvios = state.proposals.filter(p=>p.carrier===state.user?.name && p.status==='approved').length;
    const trackingActivos = state.proposals.filter(p=>p.carrier===state.user?.name && p.status==='approved' && (p.shipStatus||'pendiente')!=='entregado').length;
    setBadgeValue('badge-transp-ofertas', ofertas);
    setBadgeValue('badge-transp-mis-postulaciones', misPost);
    setBadgeValue('badge-transp-mis-envios', misEnvios);
    setBadgeValue('badge-transp-tracking', trackingActivos);
  }
  if(state.user?.role==='sendix'){
    const moderacion = state.proposals.filter(p=>p.status==='pending').length;
    const threads = state.proposals.filter(p=>p.status==='approved');
    const b1 = document.getElementById('badge-sendix-moderacion');
    const b2 = document.getElementById('badge-sendix-conversaciones');
    (async()=>{
      const { total } = await getUnreadMapForProposals(threads);
      if(b2) setBadgeValue(b2, total);
    })();
    if(b1) setBadgeValue(b1, moderacion);
  }
}

// Init
document.addEventListener('DOMContentLoaded', ()=>{
  initNav(); initLogin(); initPublishForm(); reconcileSessionWithUsers(); updateChrome();
  // Restaurar sesión desde backend si hay token
  tryRestoreSession().finally(()=>{
    const start = state.user ? (location.hash.replace('#','')||'home') : 'login';
    navigate(start);
  });
  // Reset password: si estamos en /reset-password con ?token=, abrir flujo
  try{
    const path = location.pathname || '/';
    const params = new URLSearchParams(location.search||'');
    const token = params.get('token');
    if(path.includes('reset-password') && token){
      navigate('login');
      startResetFlow(token);
    }
  }catch{}
  // Shortcut: Ctrl/Cmd+K para buscar chats
  document.addEventListener('keydown', (e)=>{
    if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='k'){
      const route = (location.hash.replace('#','')||'home');
      if(route==='conversaciones'){
        e.preventDefault();
        document.getElementById('chat-search')?.focus();
      }
    }
  });
  // Ajustar altura de barra inferior al cargar y al redimensionar
  updateBottomBarHeight();
  window.addEventListener('resize', ()=>{ updateBottomBarHeight(); updateChatFades(); });
  window.addEventListener('hashchange', ()=>reflectMobileChatState());
  const back = document.getElementById('chat-back');
  if(back) back.onclick = ()=>{
    // Volver a la lista de chats en móviles
    state.activeThread = null; save(); renderChat(); renderThreads(); reflectMobileChatState();
  };
  // Overlay central reutilizable (alert/console)
  try {
    const overlay = document.getElementById('notice-overlay');
    const headEl = document.getElementById('notice-head');
    const titleEl = document.getElementById('notice-title');
    const bodyEl = document.getElementById('notice-body');
    const okBtn = document.getElementById('notice-ok');
    if (overlay && headEl && titleEl && bodyEl && okBtn) {
      const original = {
        log: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console)
      };
      function openNotice({ title='Aviso', message='', kind='info', okText='Aceptar' }={}){
        // Estilos por tipo
        headEl.classList.remove('warn','error');
        if(kind==='warn') headEl.classList.add('warn');
        if(kind==='error') headEl.classList.add('error');
        // Contenido
        titleEl.textContent = title;
        bodyEl.textContent = message;
        okBtn.textContent = okText;
        // Mostrar
        overlay.style.display = 'flex';
        overlay.classList.add('show');
        // Foco en botón
        setTimeout(()=>{ try{ okBtn.focus(); }catch{} }, 0);
      }
      function hideNotice(){ overlay.classList.remove('show'); overlay.style.display='none'; }
      okBtn.addEventListener('click', hideNotice);
      overlay.addEventListener('click', (e)=>{ if(e.target===overlay) hideNotice(); });
      document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') hideNotice(); });
      // Exponer helpers globales
      window.showNotice = openNotice;
      window.hideNotice = hideNotice;
      // Reemplazar alert nativo por modal centrado
      window.alert = (msg)=>{
        try{
          openNotice({ title:'Aviso', message: String(msg ?? ''), kind:'info', okText:'Aceptar' });
        }catch{ /* no-op */ }
      };
      // Hook de consola: solo warn/error generan aviso; logs quedan en consola
      window.__SHOW_LOG_OVERLAY__ = false; // true para forzar overlay en logs
      console.log = (...args)=>{
        original.log(...args);
        if(window.__SHOW_LOG_OVERLAY__){
          const text = args.map(a=> a instanceof Error ? (a.stack||a.message) : (typeof a==='object'? (()=>{ try{return JSON.stringify(a,null,2)}catch{return String(a)} })() : String(a)) ).join(' ');
          openNotice({ title:'Aviso', message:text, kind:'info', okText:'Aceptar' });
        }
      };
      console.warn = (...args)=>{
        original.warn(...args);
        const text = args.map(a=> a instanceof Error ? (a.stack||a.message) : (typeof a==='object'? (()=>{ try{return JSON.stringify(a,null,2)}catch{return String(a)} })() : String(a)) ).join(' ');
        openNotice({ title:'Atención', message:text, kind:'warn', okText:'Aceptar' });
      };
      console.error = (...args)=>{
        original.error(...args);
        const text = args.map(a=> a instanceof Error ? (a.stack||a.message) : (typeof a==='object'? (()=>{ try{return JSON.stringify(a,null,2)}catch{return String(a)} })() : String(a)) ).join(' ');
        openNotice({ title:'Error', message:text, kind:'error', okText:'Aceptar' });
      };
    }
  } catch {}
});

// helpers chat
function escapeHtml(str){
  return (str||'')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;');
}
function linkify(text){
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.replace(urlRegex, (url)=>`<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
}
// Reset password UI
function startResetFlow(token){
  try{
    const loginView = document.querySelector('[data-route="login"]');
    if(!loginView) return;
    // Ocultar formularios de login/registro
    loginView.querySelector('#auth-login-form')?.setAttribute('style','display:none');
    loginView.querySelector('#auth-register-cta')?.setAttribute('style','display:none');
    loginView.querySelector('#auth-sendix-row')?.setAttribute('style','display:none');
    loginView.querySelector('#auth-register')?.setAttribute('style','display:none');
    // Crear caja de reset
    let box = document.getElementById('reset-box');
    if(!box){
      box = document.createElement('div');
      box.id = 'reset-box';
      box.className = 'form small';
      box.innerHTML = `
        <h3>Restablecer contraseña</h3>
        <form id="auth-reset-form">
          <label>Nueva contraseña
            <input type="password" name="password" minlength="6" required />
          </label>
          <label>Confirmar contraseña
            <input type="password" name="confirm" minlength="6" required />
          </label>
          <button class="btn btn-primary" type="submit">Guardar contraseña</button>
          <button class="btn btn-ghost" type="button" id="reset-cancel">Cancelar</button>
        </form>`;
      loginView.querySelector('.login-box')?.appendChild(box);
    } else {
      box.style.display = 'block';
    }
    const form = box.querySelector('#auth-reset-form');
    const cancel = box.querySelector('#reset-cancel');
    if(cancel){ cancel.addEventListener('click', ()=>{ box.style.display='none'; history.replaceState(null,'', '/'); navigate('login'); }); }
    if(form){
      form.addEventListener('submit', async (e)=>{
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(form).entries());
        const pass = String(fd.password||'');
        const conf = String(fd.confirm||'');
        const strong = pass.length>=8 && /[A-Z]/.test(pass) && /[a-z]/.test(pass) && /[0-9]/.test(pass);
        if(!strong){ alert('La contraseña debe tener mínimo 8 caracteres y combinar mayúsculas, minúsculas y números.'); return; }
        if(pass!==conf){ alert('Las contraseñas no coinciden.'); return; }
        try{
          const r = await API.resetPassword(token, pass);
          alert('Contraseña restablecida. Bienvenido.');
          if(r && r.user){ setSession('', r.user); }
          history.replaceState(null,'', '/');
          navigate('home');
        }catch(err){
          console.error(err);
          alert('Token inválido o expirado. Solicitá un nuevo enlace.');
        }
      }, { once: true });
    }
  }catch{}
}