(function(){
'use strict';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const NW=220;
const TYPES={
  trigger:{name:'Trigger',color:'#B8912E',hasIn:false,outs:['out'],desc:'What starts the flow',fields:[['board','Board (name in monday)'],['trigger','Fires on (change_column_value, create_item, item_moved_to_any_group)'],['columns','Only these columns (comma separated)'],['when','Only when (e.g. Deposit Status = Received)'],['event','Plain-English label for the card']],sum:n=>(n.p.board?n.p.board+' · ':'')+(n.p.event||n.p.columns||n.p.trigger||'')},
  condition:{name:'Yes / No check',color:'#2F6FB3',hasIn:true,outs:['yes','no'],desc:'Split the flow',fields:[],sum:n=>{const r=n.p.rules||[];if(!r.length)return 'No rules yet';return (r.length>1?(n.p.match==='any'?'Any of:\n':'All of:\n'):'')+r.map(x=>'• '+x.col+' '+x.op+(x.op.includes('empty')?'':' '+x.val)).join('\n')}},
  status:{name:'Change status',color:'#6F5BB5',hasIn:true,outs:['out'],desc:'Set a column value on the item',fields:[['col','Column'],['val','Set to (or Today, Today + 8 weeks)']],sum:n=>(n.p.col||'?')+'  →  '+(n.p.val||'?')},
  email:{name:'Send email',color:'#2E8B57',hasIn:true,outs:['out'],desc:'Phase 3 — logged for now',fields:[['to','To'],['subject','Subject'],['body','Message','textarea']],sum:n=>'To: '+(n.p.to||'?')+'\n'+(n.p.subject||'')},
  notify:{name:'Notify person',color:'#C47A1C',hasIn:true,outs:['out'],desc:'Posts an update on the item',fields:[['who','Who'],['msg','Message','textarea']],sum:n=>(n.p.who||'?')+': '+(n.p.msg||'')},
  wait:{name:'Wait',color:'#6B7280',hasIn:true,outs:['out'],desc:'Pause the run',fields:[['for','How long (1 day · 2 weeks · until 2 weeks before {Due Date})']],sum:n=>n.p.for||''},
  move:{name:'Move to group',color:'#1B7F9E',hasIn:true,outs:['out'],desc:'Move the item on its board',fields:[['group','Group (name in monday)']],sum:n=>'→ '+(n.p.group||'?')},
  create:{name:'Create item',color:'#5B8C2A',hasIn:true,outs:['out'],desc:'New item on another board',fields:[['board','Board (name in monday)'],['item','Item name']],sum:n=>'On: '+(n.p.board||'?')+(n.p.item?'\n'+n.p.item:'')},
  ai:{name:'AI block',color:'#B23A7A',hasIn:true,outs:['out'],desc:'Phase 2 — skipped for now',fields:[['task','Task'],['prompt','Instructions','textarea'],['out','Save result to']],sum:n=>(n.p.task||'')+(n.p.out?'\nSaves to: '+n.p.out:'')},
  exit:{name:'Exit',color:'#2F3640',hasIn:true,outs:[],desc:'The flow stops here',fields:[['note','Why it stops']],sum:n=>n.p.note||''}
};
const OPS=['is','is not','is any of','is empty','is not empty','is at least','is less than'];
const PAL_ORDER=['trigger','condition','status','email','notify','wait','move','create','ai','exit'];
const N=(id,type,title,p)=>({id,type,title,p:p||{}});
const E=(from,port,to)=>({from,port,to});
const R=(col,op,val)=>({col,op,val:val||''});

/* ---------- API ---------- */
async function api(method,path,body){const r=await fetch('/api'+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}); if(r.status===401){location.href='/login';throw new Error('login');} const d=await r.json().catch(()=>({})); if(!r.ok)throw new Error(d.error||r.statusText); return d;}

/* ---------- state ---------- */
const state={workflows:[],current:0};
const cur=()=>state.workflows[state.current];
const byId=id=>cur().nodes.find(n=>n.id===id);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>'n'+Math.random().toString(36).slice(2,8);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
let sel=null, armed=null, saveT=null;
function flatten(w){w.nodes=w.def.nodes||[]; w.edges=w.def.edges||[]; w.sample=w.def.sample||{}; w.desc=w.def.desc||''; try{w.view=JSON.parse(localStorage.getItem('view:'+w.id)||'null');}catch(e){w.view=null;} return w;}
function save(){clearTimeout(saveT); $('#saved').textContent='Saving…'; saveT=setTimeout(async()=>{const w=cur(); if(!w)return; try{localStorage.setItem('view:'+w.id,JSON.stringify(w.view||null));}catch(e){} try{const r=await api('PUT','/workflows/'+w.id,{name:w.name,mode:w.mode,def:{desc:w.desc,sample:w.sample,nodes:w.nodes,edges:w.edges,color:w.def.color}}); w.version=r.version; $('#saved').textContent='Saved · v'+r.version;}catch(e){$('#saved').textContent='Not saved: '+e.message;}},500);}
function toast(m){const t=$('#toast'); t.textContent=m; t.classList.add('show'); clearTimeout(toast.t); toast.t=setTimeout(()=>t.classList.remove('show'),3200);}
async function load(idx){const ws=await api('GET','/workflows'); state.workflows=ws.map(flatten); state.current=Math.min(idx==null?state.current:idx,Math.max(0,state.workflows.length-1)); sel=null; armed=null; renderAll(); requestAnimationFrame(()=>{renderEdges(); fit();});}
/* ---------- view ---------- */
const vp=$('#viewport'), world=$('#world'), nodesEl=$('#nodes'), edgeLayer=$('#edgeLayer'), tempEdge=$('#tempEdge');
function view(){const w=cur(); if(!w.view) w.view={tx:40,ty:40,s:0.9}; return w.view;}
function applyView(){const v=view(); world.style.transform=`translate(${v.tx}px,${v.ty}px) scale(${v.s})`;}
function toWorld(cx,cy){const r=vp.getBoundingClientRect(); const v=view(); return {x:(cx-r.left-v.tx)/v.s, y:(cy-r.top-v.ty)/v.s};}
function zoomAt(f,cx,cy){const r=vp.getBoundingClientRect(); const v=view(); const px=cx-r.left, py=cy-r.top; const ns=clamp(v.s*f,0.2,2); const k=ns/v.s; v.tx=px-(px-v.tx)*k; v.ty=py-(py-v.ty)*k; v.s=ns; applyView(); save();}
function fit(){const w=cur(); const v=view(); const r=vp.getBoundingClientRect(); if(!w.nodes.length||!r.width){v.tx=40;v.ty=40;v.s=1;applyView();return;}
  let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
  w.nodes.forEach(n=>{const h=nodeH(n); minX=Math.min(minX,n.x); minY=Math.min(minY,n.y); maxX=Math.max(maxX,n.x+NW); maxY=Math.max(maxY,n.y+h);});
  const pad=40, mobile=window.innerWidth<=900, top=mobile?70:0;
  const s=clamp(Math.min((r.width-pad*2)/(maxX-minX),(r.height-top-pad*2)/(maxY-minY)),0.2,1.15);
  v.s=s; v.tx=(r.width-(maxX-minX)*s)/2-minX*s; v.ty=top+(r.height-top-(maxY-minY)*s)/2-minY*s; applyView(); save();}

/* ---------- render ---------- */
function nodeEl(id){return nodesEl.querySelector(`.node[data-id="${id}"]`);}
function nodeH(n){const el=nodeEl(n.id); return el?el.offsetHeight:72;}
function portPos(n,port){const h=nodeH(n); if(port==='in')return{x:n.x,y:n.y+h/2}; if(port==='yes')return{x:n.x+NW,y:n.y+h*0.34}; if(port==='no')return{x:n.x+NW,y:n.y+h*0.72}; return{x:n.x+NW,y:n.y+h/2};}
function renderNodes(){const w=cur();
  nodesEl.innerHTML=w.nodes.map(n=>{const T=TYPES[n.type]||TYPES.exit;
    const ports=(T.hasIn?'<div class="port in" data-port="in"></div>':'')+T.outs.map(o=>`<div class="port ${o}" data-port="${o}"></div>`+(o==='yes'||o==='no'?`<span class="plabel ${o}">${o==='yes'?'Yes':'No'}</span>`:'')).join('');
    const cls='node'+(sel&&sel.kind==='node'&&sel.id===n.id?' selected':'');
    return `<div class="${cls}" data-id="${n.id}" style="left:${n.x}px;top:${n.y}px;--c:${T.color}"><div class="n-type">${esc(T.name)}</div><div class="n-title">${esc(n.title)}</div><div class="n-sum">${esc(T.sum(n))}</div>${ports}</div>`;}).join('');
  $('#empty').classList.toggle('show',!w.nodes.length);
  if(armed){const el=nodeEl(armed.from); const p=el&&el.querySelector(`.port[data-port="${armed.port}"]`); if(p)p.classList.add('armed');}}
function edgeKey(e){return e.from+':'+e.port;}
function pathD(a,b){if(b.x<a.x+40){const c=Math.max(120,(a.x-b.x)*0.35); return {d:`M${a.x},${a.y} C${a.x+c},${a.y} ${b.x-c},${b.y} ${b.x},${b.y}`,back:true};}
  const dx=Math.max(50,Math.abs(b.x-a.x)*0.45); return {d:`M${a.x},${a.y} C${a.x+dx},${a.y} ${b.x-dx},${b.y} ${b.x},${b.y}`,back:false};}
function renderEdges(){const w=cur();
  edgeLayer.innerHTML=w.edges.map(e=>{const a=byId(e.from), b=byId(e.to); if(!a||!b)return '';
    const pa=portPos(a,e.port), pb=portPos(b,'in'); const {d,back}=pathD(pa,pb);
    const isSel=sel&&sel.kind==='edge'&&sel.from===e.from&&sel.port===e.port;
    const cls='edge '+e.port+(back?' back':'')+(isSel?' selected':''); const mk=isSel?'mk-sel':(e.port==='yes'?'mk-yes':e.port==='no'?'mk-no':'mk');
    const label=back?`<text x="${(pa.x+pb.x)/2}" y="${Math.min(pa.y,pb.y)-10}" text-anchor="middle">loops back</text>`:'';
    return `<path class="hit" data-key="${edgeKey(e)}" d="${d}"/><path class="${cls}" data-key="${edgeKey(e)}" d="${d}" marker-end="url(#${mk})"/>${label}`;}).join('');}
function renderSelect(){const s=$('#wfSelect'); s.innerHTML=state.workflows.map((w,i)=>`<option value="${i}" ${i===state.current?'selected':''}>${esc(w.name)}${w.mode==='live'?' · LIVE':w.mode==='off'?' · off':''}</option>`).join('')+'<option value="__new">+ New workflow…</option>'; const m=cur()?cur().mode:'watch'; $$('#modeSeg button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===m)));}
function renderAll(){renderNodes(); renderEdges(); applyView(); renderSelect(); renderInspector();}

/* ---------- inspector ---------- */
const insp=$('#inspector'), inspBody=$('#inspBody');
function fieldHtml(k,l,kind,val){return `<label class="field"><span>${esc(l)}</span>${kind==='textarea'?`<textarea data-k="${k}">${esc(val)}</textarea>`:`<input data-k="${k}" value="${esc(val)}">`}</label>`;}
function renderInspector(){const w=cur();
  if(sel&&sel.kind==='node'){const n=byId(sel.id); if(!n){sel=null;return renderInspector();} const T=TYPES[n.type];
    let h=`<span class="chip" style="--c:${T.color}">${esc(T.name)}</span><h2 style="margin-top:4px">Edit this step</h2><p class="sub">${esc(T.desc)}</p>`;
    h+=fieldHtml('__title','Name on the card','',n.title);
    T.fields.forEach(f=>{h+=fieldHtml(f[0],f[1],f[2],n.p[f[0]]||'');});
    if(n.type==='condition'){const rules=n.p.rules||[];
      h+=`<label class="field"><span>Go to Yes when…</span><select data-k="match"><option value="all" ${n.p.match!=='any'?'selected':''}>All rules are true</option><option value="any" ${n.p.match==='any'?'selected':''}>Any rule is true</option></select></label>`;
      h+=rules.map((r,i)=>`<div class="rule"><div class="r"><input data-rule="${i}" data-rk="col" placeholder="Column" value="${esc(r.col)}"><select data-rule="${i}" data-rk="op">${OPS.map(o=>`<option ${o===r.op?'selected':''}>${o}</option>`).join('')}</select><input data-rule="${i}" data-rk="val" placeholder="Value (comma-separate for any of)" value="${esc(r.val)}" ${r.op.includes('empty')?'disabled':''}></div><button class="x" data-rmrule="${i}" aria-label="Remove rule">×</button></div>`).join('');
      h+=`<div class="row"><button class="btn small" id="addRule">+ Add rule</button></div><p class="hint">Yes = the rules pass. No = they don't. Connect both dots so nothing falls through.</p>`;}
    if(n.type==='ai') h+=`<p class="hint">AI blocks arrive in phase 2. Until then this step is skipped and logged.</p>`;
    if(n.type==='trigger') h+=`<p class="hint">Fires on: <b>${esc(n.p.trigger||'change_column_value')}</b>${n.p.columns?' for columns '+esc(n.p.columns):''}${n.p.when?' · only when '+esc(n.p.when):''}. Column names must match the board exactly — Setup shows which ones don't.</p>`;
    if(n.type==='email') h+=`<p class="hint">Curly brackets pull values from the item, e.g. {Owner}. Sending arrives in phase 3; for now the step is logged.</p>`;
    h+=`<div class="row"><button class="btn small" id="dupNode">Duplicate</button><button class="btn small danger" id="delNode">Delete step</button></div>`;
    inspBody.innerHTML=h;
  } else if(sel&&sel.kind==='edge'){const e=w.edges.find(x=>x.from===sel.from&&x.port===sel.port); const a=e&&byId(e.from), b=e&&byId(e.to);
    inspBody.innerHTML=`<h2>Connection</h2><p class="sub">${esc(a?a.title:'?')} <b>${sel.port==='out'?'→':sel.port==='yes'?'Yes →':'No →'}</b> ${esc(b?b.title:'?')}</p><p class="hint">To change where it goes, drag from the dot again — the old connection is replaced.</p><div class="row"><button class="btn small danger" id="delEdge">Remove connection</button></div>`;
  } else {
    let h=`<h2>Workflow</h2><p class="sub">Tap any step on the canvas to edit it.</p>`+fieldHtml('__wfname','Name','',w.name)+fieldHtml('__wfdesc','What it does','textarea',w.desc||'');
    h+=`<h2 style="margin-top:14px">Test item</h2><p class="sub">The sample item used by Run test. Change values to see a different path.</p>`;
    h+=Object.keys(w.sample||{}).map(k=>`<div class="kv"><label title="${esc(k)}">${esc(k)}</label><input data-sample="${esc(k)}" value="${esc(w.sample[k])}"></div>`).join('');
    h+=`<div class="row"><button class="btn small" id="addField">+ Add field</button></div>`;
    h+=`<h2 style="margin-top:14px">Versions</h2><p class="sub">Every save is a version. v${w.version}. <a href="#" id="showVersions">Show earlier versions</a></p><div id="versions"></div>`;
    h+=`<div class="row" style="margin-top:18px"><button class="btn small" id="copyJson">Copy as JSON</button><button class="btn small danger" id="delWf">Delete workflow</button></div>`;
    inspBody.innerHTML=h;}}
function openInsp(){insp.classList.add('open');} function closeInsp(){insp.classList.remove('open');}
$('#closeInsp').addEventListener('click',closeInsp);
$('#btnDetails').addEventListener('click',()=>{sel=null; renderNodes(); renderEdges(); renderInspector(); openInsp();});
inspBody.addEventListener('input',e=>{const t=e.target; const w=cur();
  if(t.dataset.sample!=null){w.sample[t.dataset.sample]=t.value; save(); return;}
  if(t.dataset.k==='__wfname'){w.name=t.value; renderSelect(); save(); return;}
  if(t.dataset.k==='__wfdesc'){w.desc=t.value; save(); return;}
  if(!sel||sel.kind!=='node')return; const n=byId(sel.id); if(!n)return;
  if(t.dataset.rule!=null){const r=(n.p.rules||[])[+t.dataset.rule]; if(r){r[t.dataset.rk]=t.value; if(t.dataset.rk==='op'){t.parentElement.querySelector('[data-rk="val"]').disabled=t.value.includes('empty');}}}
  else if(t.dataset.k==='__title') n.title=t.value; else if(t.dataset.k) n.p[t.dataset.k]=t.value;
  renderNodes(); renderEdges(); save();});
inspBody.addEventListener('click',e=>{const b=e.target.closest('button'); if(!b)return; const w=cur();
  if(b.id==='addRule'){const n=byId(sel.id); (n.p.rules=n.p.rules||[]).push(R('','is','')); renderInspector(); renderNodes(); renderEdges(); save();}
  if(b.dataset.rmrule!=null){const n=byId(sel.id); n.p.rules.splice(+b.dataset.rmrule,1); renderInspector(); renderNodes(); renderEdges(); save();}
  if(b.id==='delNode'){deleteNode(sel.id);}
  if(b.id==='dupNode'){const n=byId(sel.id); const c=JSON.parse(JSON.stringify(n)); c.id=uid(); c.x+=40; c.y+=60; w.nodes.push(c); sel={kind:'node',id:c.id}; renderNodes(); renderEdges(); renderInspector(); save();}
  if(b.id==='delEdge'){w.edges=w.edges.filter(x=>!(x.from===sel.from&&x.port===sel.port)); sel=null; renderEdges(); renderInspector(); save();}
  if(b.id==='addField'){const k=prompt('Field name (as it appears on the monday board):'); if(k){w.sample[k]=''; renderInspector(); save();}}
  if(b.id==='copyJson'){const txt=JSON.stringify({name:w.name,desc:w.desc,nodes:w.nodes,edges:w.edges},null,2); if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(()=>toast('Copied'),()=>showJson(txt));}else showJson(txt);}
  if(b.id==='delWf'){if(confirm(`Delete "${w.name}"? Its runs are kept.`)){api('DELETE','/workflows/'+w.id).then(()=>load(0));}}});
function showJson(txt){inspBody.insertAdjacentHTML('beforeend',`<label class="field"><span>Copy this</span><textarea style="min-height:160px">${esc(txt)}</textarea></label>`);}
function deleteNode(id){const w=cur(); w.nodes=w.nodes.filter(n=>n.id!==id); w.edges=w.edges.filter(e=>e.from!==id&&e.to!==id); sel=null; renderNodes(); renderEdges(); renderInspector(); save();}

/* ---------- selection & connecting ---------- */
function selectNode(id){sel={kind:'node',id}; renderNodes(); renderEdges(); renderInspector(); openInsp();}
function selectEdge(key){const [from,port]=key.split(':'); sel={kind:'edge',from,port}; renderNodes(); renderEdges(); renderInspector(); openInsp();}
function deselect(){sel=null; renderNodes(); renderEdges(); renderInspector(); closeInsp();}
function connect(from,port,to){const w=cur(); if(from===to){toast("A step can't connect to itself");return;} const tn=byId(to); if(!tn||!TYPES[tn.type].hasIn){toast('That step has no input');return;}
  w.edges=w.edges.filter(e=>!(e.from===from&&e.port===port)); w.edges.push(E(from,port,to)); armed=null; renderNodes(); renderEdges(); save(); toast('Connected');}

/* ---------- pointer handling ---------- */
let drag=null; const pts=new Map();
const pinchDist=()=>{const a=[...pts.values()]; return Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y);};
const pinchCenter=()=>{const a=[...pts.values()]; return {x:(a[0].x+a[1].x)/2,y:(a[0].y+a[1].y)/2};};
vp.addEventListener('pointerdown',e=>{pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(pts.size===2){drag={kind:'pinch',d0:pinchDist(),s0:view().s,c:pinchCenter(),tx:view().tx,ty:view().ty}; return;}
  const port=e.target.closest('.port[data-port="out"],.port[data-port="yes"],.port[data-port="no"]'); const nEl=e.target.closest('.node');
  if(e.target.closest('.hit')){drag={kind:'edge',key:e.target.dataset.key,sx:e.clientX,sy:e.clientY,moved:false}; vp.setPointerCapture(e.pointerId); return;}
  if(port&&nEl){drag={kind:'connect',from:nEl.dataset.id,port:port.dataset.port,sx:e.clientX,sy:e.clientY,moved:false}; vp.setPointerCapture(e.pointerId); e.preventDefault(); return;}
  if(nEl){const n=byId(nEl.dataset.id); const w=toWorld(e.clientX,e.clientY); drag={kind:'node',id:n.id,ox:w.x-n.x,oy:w.y-n.y,sx:e.clientX,sy:e.clientY,moved:false}; vp.setPointerCapture(e.pointerId); return;}
  drag={kind:'pan',sx:e.clientX,sy:e.clientY,tx:view().tx,ty:view().ty,moved:false}; vp.setPointerCapture(e.pointerId); vp.classList.add('panning');});
vp.addEventListener('pointermove',e=>{if(pts.has(e.pointerId))pts.set(e.pointerId,{x:e.clientX,y:e.clientY}); if(!drag)return;
  if(drag.kind==='pinch'){if(pts.size<2)return; const v=view(); const r=vp.getBoundingClientRect(); const c=pinchCenter(); const ns=clamp(drag.s0*pinchDist()/drag.d0,0.2,2);
    const wx=(drag.c.x-r.left-drag.tx)/drag.s0, wy=(drag.c.y-r.top-drag.ty)/drag.s0; v.s=ns; v.tx=(c.x-r.left)-wx*ns; v.ty=(c.y-r.top)-wy*ns; applyView(); return;}
  const dx=e.clientX-drag.sx, dy=e.clientY-drag.sy; if(Math.hypot(dx,dy)>4)drag.moved=true;
  if(drag.kind==='node'){const n=byId(drag.id); const w=toWorld(e.clientX,e.clientY); n.x=Math.round(w.x-drag.ox); n.y=Math.round(w.y-drag.oy); const el=nodeEl(n.id); el.style.left=n.x+'px'; el.style.top=n.y+'px'; renderEdges();}
  else if(drag.kind==='pan'){const v=view(); v.tx=drag.tx+dx; v.ty=drag.ty+dy; applyView();}
  else if(drag.kind==='connect'){const a=portPos(byId(drag.from),drag.port); const b=toWorld(e.clientX,e.clientY); tempEdge.style.display=''; tempEdge.setAttribute('d',pathD(a,b).d);
    nodesEl.querySelectorAll('.target-ok').forEach(x=>x.classList.remove('target-ok')); const el=document.elementFromPoint(e.clientX,e.clientY); const t=el&&el.closest('.node'); if(t&&t.dataset.id!==drag.from&&TYPES[byId(t.dataset.id).type].hasIn)t.classList.add('target-ok');}});
function endPointer(e){pts.delete(e.pointerId); if(!drag)return;
  if(drag.kind==='pinch'){if(pts.size<2){drag=null; save();} return;}
  const d=drag; drag=null; vp.classList.remove('panning'); tempEdge.style.display='none'; nodesEl.querySelectorAll('.target-ok').forEach(x=>x.classList.remove('target-ok'));
  if(d.kind==='node'){if(!d.moved){if(armed)connect(armed.from,armed.port,d.id); else selectNode(d.id);}else{renderEdges(); save();}}
  else if(d.kind==='pan'){if(!d.moved){if(armed){armed=null; renderNodes(); toast('Cancelled');}else deselect();}else save();}
  else if(d.kind==='edge'){if(!d.moved)selectEdge(d.key);}
  else if(d.kind==='connect'){if(!d.moved){armed={from:d.from,port:d.port}; renderNodes(); toast('Now tap the step this should lead to');}
    else{const el=document.elementFromPoint(e.clientX,e.clientY); const t=el&&el.closest('.node'); if(t)connect(d.from,d.port,t.dataset.id); else{armed=null; renderNodes();}}}}
vp.addEventListener('pointerup',endPointer); vp.addEventListener('pointercancel',endPointer);
vp.addEventListener('wheel',e=>{e.preventDefault(); zoomAt(Math.exp(-e.deltaY*0.0015),e.clientX,e.clientY);},{passive:false});
$('#zIn').addEventListener('click',()=>{const r=vp.getBoundingClientRect(); zoomAt(1.2,r.left+r.width/2,r.top+r.height/2);});
$('#zOut').addEventListener('click',()=>{const r=vp.getBoundingClientRect(); zoomAt(1/1.2,r.left+r.width/2,r.top+r.height/2);});
$('#zFit').addEventListener('click',fit);
$('#btnTidy').addEventListener('click',()=>{autoLayout(cur()); renderNodes(); renderEdges(); requestAnimationFrame(()=>{renderEdges(); fit();}); save(); toast('Tidied');});
document.addEventListener('keydown',e=>{const tag=(e.target.tagName||'').toLowerCase(); if(tag==='input'||tag==='textarea'||tag==='select')return; if(!$('#canvasPanel').classList.contains('show'))return;
  if((e.key==='Delete'||e.key==='Backspace')&&sel){e.preventDefault(); if(sel.kind==='node')deleteNode(sel.id); else{cur().edges=cur().edges.filter(x=>!(x.from===sel.from&&x.port===sel.port)); sel=null; renderEdges(); renderInspector(); save();}}
  if(e.key==='Escape'){armed=null; deselect();}});

/* ---------- palette ---------- */
const ghost=$('#ghost');
$('#palItems').innerHTML=PAL_ORDER.map(t=>`<button class="pal" data-type="${t}" style="--c:${TYPES[t].color}"><i></i><span><b>${esc(TYPES[t].name)}</b><small>${esc(TYPES[t].desc)}</small></span></button>`).join('');
let pdrag=null;
$('#palItems').addEventListener('pointerdown',e=>{const b=e.target.closest('.pal'); if(!b)return; pdrag={type:b.dataset.type,sx:e.clientX,sy:e.clientY,moved:false}; b.setPointerCapture(e.pointerId); ghost.textContent=TYPES[b.dataset.type].name; ghost.style.setProperty('--c',TYPES[b.dataset.type].color);});
$('#palItems').addEventListener('pointermove',e=>{if(!pdrag)return; if(Math.hypot(e.clientX-pdrag.sx,e.clientY-pdrag.sy)>6)pdrag.moved=true; if(pdrag.moved){ghost.style.display='block'; ghost.style.left=(e.clientX+12)+'px'; ghost.style.top=(e.clientY+12)+'px';}});
function palEnd(e){if(!pdrag)return; const d=pdrag; pdrag=null; ghost.style.display='none'; const r=vp.getBoundingClientRect(); let pos;
  if(d.moved){if(e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom)pos=toWorld(e.clientX,e.clientY); else return; pos.x-=NW/2; pos.y-=30;}
  else{pos=toWorld(r.left+r.width/2,r.top+r.height/2); pos.x-=NW/2; pos.y-=30; const w=cur(); while(w.nodes.some(n=>Math.abs(n.x-pos.x)<30&&Math.abs(n.y-pos.y)<30)){pos.x+=30;pos.y+=30;}}
  addNode(d.type,Math.round(pos.x),Math.round(pos.y));}
$('#palItems').addEventListener('pointerup',palEnd); $('#palItems').addEventListener('pointercancel',()=>{pdrag=null; ghost.style.display='none';});
function addNode(type,x,y){const w=cur(); const T=TYPES[type]; if(type==='trigger'&&w.nodes.some(n=>n.type==='trigger')){toast('This workflow already has a trigger');return;}
  const n=Object.assign(N(uid(),type,T.name,type==='condition'?{match:'all',rules:[R('','is','')]}:{}),{x,y}); w.nodes.push(n); selectNode(n.id); save(); if(armed)connect(armed.from,armed.port,n.id);}

/* ---------- workflow switching, modes, test ---------- */
$('#wfSelect').addEventListener('change',async e=>{const v=e.target.value; if(v==='__new'){const name=prompt('Name the new workflow:','New workflow'); if(!name){renderSelect();return;} const r=await api('POST','/workflows',{name}); await load(state.workflows.length); return;} state.current=+v; sel=null; armed=null; renderAll(); requestAnimationFrame(()=>{renderEdges(); fit();});});
$('#modeSeg').addEventListener('click',async e=>{const b=e.target.closest('button'); if(!b)return; const w=cur(); if(!w)return; const m=b.dataset.mode; if(m===w.mode)return;
  if(m==='live'&&!confirm(`Switch "${w.name}" to LIVE?\n\nFrom now on it will write statuses, move items and create items on monday when it runs. Make sure the matching monday automation is switched OFF first.`))return;
  w.mode=m; renderSelect(); await api('PUT','/workflows/'+w.id,{mode:m}); toast(m==='live'?'Live — acting on monday':m==='watch'?'Watch — logging only':'Off — ignoring events');});
$('#btnTidy').addEventListener('click',async()=>{const w=cur(); const def=await api('POST','/workflows/'+w.id+'/tidy'); w.def=def; flatten(w); w.view=null; renderNodes(); renderEdges(); requestAnimationFrame(()=>{renderEdges(); fit();}); toast('Tidied');});
inspBody.addEventListener('click',async e=>{if(e.target.id==='showVersions'){e.preventDefault(); const w=cur(); const vs=await api('GET','/workflows/'+w.id+'/versions'); $('#versions').innerHTML=vs.length?vs.map(v=>`<div class="kv"><label>v${v.version} · ${new Date(v.created_at).toLocaleString('en-GB')}</label><button class="btn small" data-restore="${v.version}">Restore</button></div>`).join(''):'<p class="hint">No earlier versions yet.</p>';}
  const r=e.target.closest('[data-restore]'); if(r){const w=cur(); if(confirm('Restore v'+r.dataset.restore+'? The current canvas is kept as a version too.')){await api('POST','/workflows/'+w.id+'/restore/'+r.dataset.restore); await load(state.current); toast('Restored');}}});

/* ---------- test run on a real item ---------- */
const logEl=$('#log'), logList=$('#logList'); let running=false;
$('#logClose').addEventListener('click',()=>{logEl.classList.remove('open'); clearRun();});
function clearRun(){nodesEl.querySelectorAll('.visited,.active').forEach(x=>x.classList.remove('visited','active')); edgeLayer.querySelectorAll('.taken').forEach(x=>x.classList.remove('taken'));}
function logLine(txt,cls,color){const li=document.createElement('li'); if(cls)li.className=cls; if(color)li.style.setProperty('--c',color); li.innerHTML=`<i></i><span>${esc(txt)}</span>`; logList.appendChild(li); logList.scrollTop=logList.scrollHeight;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const KC={trigger:'#B8912E',yes:'#1E8E5A',no:'#C8402E',status:'#6F5BB5',email:'#2E8B57',notify:'#C47A1C',wait:'#6B7280',move:'#1B7F9E',create:'#5B8C2A',ai:'#B23A7A',exit:'#2F3640'};
const testModal=$('#testModal');
$('#btnRun').addEventListener('click',async()=>{const w=cur(); if(!w.nodes.some(n=>n.type==='trigger')){toast('Add a trigger first');return;} testModal.classList.add('open'); const box=$('#testItems'); box.innerHTML='Loading items from monday…';
  const t=w.nodes.find(n=>n.type==='trigger'); const board=(t.p.board||'Projects');
  try{const items=await api('GET','/setup/items?board='+encodeURIComponent(board)); box.innerHTML=`<button class="item" data-item="">Use the sample item from Details<small>Edit its values under Details → Test item</small></button>`+items.map(i=>`<button class="item" data-item="${i.id}">${esc(i.name)}<small>${esc(i.group?i.group.title:'')}</small></button>`).join('')+(items.length?'':'<p class="hint">No items found. Pick the board under Setup first.</p>')+'<p class="hint"><a href="#" id="testCancel">Cancel</a></p>';}
  catch(e){box.innerHTML=`<p class="bad">${esc(e.message)}</p><button class="item" data-item="">Use the sample item instead</button><p class="hint"><a href="#" id="testCancel">Cancel</a></p>`;}});
testModal.addEventListener('click',async e=>{if(e.target===testModal||e.target.id==='testCancel'){e.preventDefault(); testModal.classList.remove('open'); return;} const b=e.target.closest('[data-item]'); if(!b)return; testModal.classList.remove('open'); await runTest(b.dataset.item);});
async function runTest(itemId){if(running)return; const w=cur(); running=true; clearRun(); logList.innerHTML=''; logEl.classList.add('open'); closeInsp(); $('#logSub').textContent=w.name; logLine('Reading the item from monday…','end');
  let res; try{res=await api('POST','/workflows/'+w.id+'/test',{itemId:itemId||undefined});}catch(e){logLine('Could not run: '+e.message,'end'); running=false; return;} logList.innerHTML='';
  // replay the log on the canvas: match steps to nodes in order
  const order=[]; let node=w.nodes.find(n=>n.type==='trigger'); const seen={}; let k=0;
  for(const line of res.log){const el=node?nodeEl(node.id):null; if(el){el.classList.add('active'); await sleep(380); el.classList.remove('active'); el.classList.add('visited');}
    logLine(line.text,line.kind==='yes'?'yes':line.kind==='no'?'no':'',KC[line.kind]);
    if(!node)continue; let port='out'; if(line.kind==='yes')port='yes'; if(line.kind==='no'&&node.type==='condition')port='no'; const edge=w.edges.find(e=>e.from===node.id&&e.port===port); if(edge){const p=edgeLayer.querySelector(`.edge[data-key="${edgeKey(edge)}"]`); if(p)p.classList.add('taken'); node=byId(edge.to);} else node=null;}
  logLine('Test finished — nothing was written to monday.','end'); running=false;}

/* ---------- screens ---------- */
function switchScreen(id){$$('.nav button').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.screen===id))); $$('.panel').forEach(p=>p.classList.toggle('show',p.id===id)); if(id==='canvasPanel')requestAnimationFrame(()=>{renderEdges(); fit();}); if(id==='runsPanel')renderRuns(); if(id==='setupPanel')renderSetup();}
$$('.nav button').forEach(b=>b.addEventListener('click',()=>switchScreen(b.dataset.screen)));
$('#btnLogout').addEventListener('click',async()=>{await fetch('/logout',{method:'POST'}); location.href='/login';});

async function renderRuns(){const el=$('#runsBody'); el.innerHTML='<h1>Runs</h1><p class="lead">Every time a workflow fired, what it saw and what it did (or would have done, in watch mode).</p><p>Loading…</p>';
  try{const runs=await api('GET','/runs?limit=200');
    el.innerHTML=`<h1>Runs</h1><p class="lead">Every time a workflow fired, what it saw and what it did — or would have done, in watch mode. Newest first.</p><div class="card">${runs.length?`<table class="t"><thead><tr><th>When</th><th>Workflow</th><th>Item</th><th>Trigger</th><th>Mode</th><th>Status</th><th>Steps</th></tr></thead><tbody>${runs.map(r=>`<tr class="row" data-run="${r.id}"><td>${new Date(r.started_at).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</td><td>${esc(r.workflow_name.split(' — ')[0])}</td><td>${esc(r.item_name||r.item_id||'sample')}</td><td>${esc(r.trigger||'')}</td><td><span class="pill ${r.mode}">${r.mode}</span></td><td><span class="pill ${r.status}">${r.status}${r.status==='waiting'&&r.resume_at?' · '+new Date(r.resume_at).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):''}</span>${r.error?`<div class="bad" style="font-size:12px">${esc(r.error)}</div>`:''}</td><td>${r.steps}</td></tr>`).join('')}</tbody></table>`:'<p class="hint">No runs yet. Runs appear here when a status changes on your board (after webhooks are registered under Setup), or when you press Run test on the canvas.</p>'}</div><div id="runDetail"></div>`;}
  catch(e){el.innerHTML+=`<p class="bad">${esc(e.message)}</p>`;}}
$('#runsBody').addEventListener('click',async e=>{const tr=e.target.closest('[data-run]'); if(tr){const r=await api('GET','/runs/'+tr.dataset.run); $('#runDetail').innerHTML=`<div class="card"><h2>${esc(r.workflow_name)} · ${esc(r.item_name||'sample')} · <span class="pill ${r.status}">${r.status}</span></h2><ol class="runlog">${(r.log||[]).map(l=>`<li style="--c:${KC[l.kind]||'#888'}"><i></i><span>${esc(l.text)}<small>${new Date(l.t).toLocaleTimeString('en-GB')}</small></span></li>`).join('')}</ol><div class="row">${r.status==='parked'?`<button class="btn small" data-retry="${r.id}">Retry</button>`:''}${r.status==='waiting'?`<button class="btn small danger" data-cancel="${r.id}">Cancel this run</button>`:''}</div></div>`; $('#runDetail').scrollIntoView({behavior:'smooth'}); return;}
  const rt=e.target.closest('[data-retry]'); if(rt){await api('POST','/runs/'+rt.dataset.retry+'/retry'); toast('Will retry within a minute'); renderRuns(); return;}
  const cn=e.target.closest('[data-cancel]'); if(cn){await api('POST','/runs/'+cn.dataset.cancel+'/cancel'); toast('Cancelled'); renderRuns(); return;}});

async function renderSetup(){const el=$('#setupBody'); el.innerHTML='<h1>Setup</h1><p>Loading…</p>';
  try{const s=await api('GET','/setup'); let boards=[]; let berr=''; try{boards=await api('GET','/setup/boards');}catch(e){berr=e.message;}
    const sel=(name)=>`<select class="sel" data-board="${name}"><option value="">— choose —</option>${boards.map(b=>`<option value="${b.id}" ${String(s.boards[name])===String(b.id)?'selected':''}>${esc(b.name)}</option>`).join('')}</select>`;
    el.innerHTML=`<h1>Setup</h1><p class="lead">Three steps, in order. Green means done.</p>
    <div class="card"><h2>1 · monday connection</h2>${s.tokenSet?(s.me?`<p class="ok">Connected as ${esc(s.me.name)} (${esc(s.me.email)})</p>`:`<p class="bad">Token is set but monday refused it: ${esc(s.error||'')}</p>`):'<p class="bad">MONDAY_TOKEN is not set. Render → stronghold-layer → Environment → add it, then redeploy.</p>'}</div>
    <div class="card"><h2>2 · Boards</h2>${berr?`<p class="bad">${esc(berr)}</p>`:''}<div class="kv"><label>Projects board</label>${sel('Projects')}</div><div class="kv"><label>Leads board</label>${sel('Leads')}</div><div class="kv"><label>Accounts board</label>${sel('Accounts')}</div><div class="kv"><label>T&C's Agreements</label>${sel("T&C's Agreements")}</div><div class="kv"><label>Warranties and O&M</label>${sel('Warranties and O&M')}</div><div class="kv"><label>Maintenance</label>${sel('Maintenance')}</div><div class="kv"><label>Debt</label>${sel('Debt')}</div><div class="row"><button class="btn small" id="saveBoards">Save boards</button></div><div id="mapping"></div></div>
    <div class="card"><h2>3 · Webhooks (how monday tells the layer something changed)</h2><p class="hint">Public address: <b>${esc(s.publicUrl||'unknown until deployed on Render')}</b></p><div id="hooks">Loading…</div><div class="row"><button class="btn small" id="regHooks" ${s.boards.Projects?'':'disabled'}>Register webhooks on the chosen boards</button><button class="btn small" id="showEvents">Show last events received</button></div><div id="events"></div></div>
    <div class="card"><h2>Reset</h2><p class="hint">Reloads WF0–WF7 and Lead intake as agreed in the prototype, all in watch mode, overwriting canvases with the same ids.</p><button class="btn small danger" id="resetDefaults">Reload default workflows</button></div>`;
    renderMapping(); renderHooks();}
  catch(e){el.innerHTML+=`<p class="bad">${esc(e.message)}</p>`;}}
async function renderMapping(){const m=$('#mapping'); if(!m)return; try{const r=await api('GET','/setup/mapping'); if(!r.board){m.innerHTML='<p class="hint">Choose and save the Projects board to check column names.</p>';return;} const missing=r.used.filter(u=>!u.found);
  m.innerHTML=`<h2 style="margin-top:12px">Column check on "${esc(r.board.name)}"</h2>${missing.length?`<p class="warn">${missing.length} name(s) used on the canvas don't exist on the board. Rename them on the canvas (or in monday) before going live:</p><table class="t"><thead><tr><th>Used on the canvas</th><th>Where</th></tr></thead><tbody>${missing.map(u=>`<tr><td class="bad">${esc(u.title)}</td><td>${esc(u.where.join(', '))}</td></tr>`).join('')}</tbody></table>`:'<p class="ok">All column and group names used by the workflows exist on the board.</p>'}<p class="hint">Board columns: ${r.board.columns.map(esc).join(' · ')}<br>Groups: ${r.board.groups.map(esc).join(' · ')}</p>`;}catch(e){m.innerHTML=`<p class="bad">${esc(e.message)}</p>`;}}
async function renderHooks(){const h=$('#hooks'); if(!h)return; try{const r=await api('GET','/setup/webhooks'); const names=Object.keys(r); if(!names.length){h.innerHTML='<p class="hint">Save the boards first.</p>';return;} h.innerHTML=names.map(n=>`<p><b>${esc(n)}</b>: ${r[n].error?`<span class="bad">${esc(r[n].error)}</span>`:(r[n].length?`<span class="ok">${r[n].length} webhook(s)</span> — ${r[n].map(w=>esc(w.event)).join(', ')}`:'<span class="warn">none yet</span>')}</p>`).join('');}catch(e){h.innerHTML=`<p class="bad">${esc(e.message)}</p>`;}}
$('#setupBody').addEventListener('click',async e=>{const id=e.target.id;
  if(id==='saveBoards'){const map={}; $$('[data-board]').forEach(s=>{if(s.value)map[s.dataset.board]=s.value;}); await api('POST','/setup/boards',map); toast('Boards saved'); renderSetup(); return;}
  if(id==='regHooks'){e.target.disabled=true; try{const r=await api('POST','/setup/webhooks'); const bad=r.made.filter(m=>m.error); toast(bad.length?'Some webhooks failed — see below':'Webhooks registered'); if(bad.length)$('#events').innerHTML=`<p class="bad">${bad.map(m=>esc(m.board+' '+m.event+': '+m.error)).join('<br>')}</p>`;}catch(err){toast(err.message);} renderHooks(); e.target.disabled=false; return;}
  if(id==='showEvents'){const ev=await api('GET','/events'); $('#events').innerHTML=ev.length?`<table class="t"><thead><tr><th>Received</th><th>Type</th><th>Item</th><th>Column</th><th>Value</th></tr></thead><tbody>${ev.map(x=>{const b=x.body.event||{}; return `<tr><td>${new Date(x.received_at).toLocaleString('en-GB')}</td><td>${esc(x.kind)}</td><td>${esc(b.pulseName||b.pulseId||'')}</td><td>${esc(b.columnTitle||'')}</td><td>${esc((b.value&&(b.value.label&&b.value.label.text||b.value.label||b.value.date||b.value.text))||'')}</td></tr>`;}).join('')}</tbody></table>`:'<p class="hint">Nothing received yet. Change a status on the board and refresh.</p>'; return;}
  if(id==='resetDefaults'){if(confirm('Reload the default workflows? Canvases with the same ids (WF0–WF7, lead) are overwritten and set to watch.')){await api('POST','/workflows/reset-defaults'); await load(0); toast('Defaults reloaded');} return;}});

/* ---------- boot ---------- */
window.addEventListener('resize',()=>{renderEdges();});
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(()=>renderEdges());
(async()=>{try{const s=await api('GET','/setup'); $('#whoami').textContent=s.me?'monday: '+s.me.name:(s.tokenSet?'monday token refused — see Setup':'monday not connected — see Setup');}catch(e){$('#whoami').textContent='';} await load(0); if(!state.workflows.length){toast('No workflows yet — reload defaults under Setup');}})();
})();
