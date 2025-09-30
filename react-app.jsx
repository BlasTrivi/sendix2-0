// react-app.jsx
// Pequeño ejemplo de integración React sin build, montado en #react-widget

const { useState, useEffect } = React;

function StatusDot({ ok }){
  const color = ok ? '#16a34a' : '#ef4444';
  return (
    <span style={{display:'inline-flex', alignItems:'center', gap:8}}>
      <span style={{width:10,height:10,borderRadius:'50%',background:color,boxShadow:'0 0 0 2px rgba(0,0,0,.05)'}}/>
      <span style={{color:'#5A6C79', fontSize:12}}>{ok? 'OK' : 'Atención'}</span>
    </span>
  );
}

function ReactWidget(){
  const [now, setNow] = useState(() => new Date());
  const [mounts, setMounts] = useState(0);
  const [role, setRole] = useState(null);

  useEffect(()=>{
    setMounts(m => m+1);
    const id = setInterval(()=> setNow(new Date()), 1000);
    try{
      const usr = JSON.parse(localStorage.getItem('sendix.user')||'null');
      setRole(usr?.role || null);
    }catch{}
    return ()=> clearInterval(id);
  },[]);

  return (
    <div style={{padding:16}}>
      <div className="row" style={{justifyContent:'space-between', alignItems:'center'}}>
        <h3 style={{margin:'8px 0'}}>Widget React</h3>
        <StatusDot ok={true}/>
      </div>
      <p className="muted" style={{marginTop:0}}>Este bloque está renderizado con React 18 (sin build). Úsalo para nuevas partes interactivas.</p>
      <div className="row" style={{gap:12, alignItems:'center'}}>
        <strong>Hora:</strong>
        <code>{now.toLocaleTimeString()}</code>
      </div>
      <div className="row" style={{gap:12, alignItems:'center'}}>
        <strong>Montajes:</strong>
        <code>{mounts}</code>
      </div>
      <div className="row" style={{gap:12, alignItems:'center'}}>
        <strong>Rol actual:</strong>
        <code>{role || 'no logueado'}</code>
      </div>
      <div className="row" style={{gap:8, marginTop:12}}>
        <button className="btn" onClick={()=> alert('Hola desde React!')}>Probar</button>
        <button className="btn btn-ghost" onClick={()=> setNow(new Date())}>Refrescar hora</button>
      </div>
    </div>
  );
}

// Montaje condicional solo cuando existe el contenedor (p.ej., en la ruta Home)
(function mountReactWidget(){
  const el = document.getElementById('react-widget');
  if(!el) return;
  const root = ReactDOM.createRoot(el);
  root.render(<ReactWidget/>);
})();
