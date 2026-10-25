// The workflows as agreed in the prototype, WF0–WF7 plus Lead intake.
// Loaded into the database on first start; after that the canvas is the source of truth.
const GAPY=175, GAPX=300;
const N=(id,type,title,p)=>({id,type,title,p:p||{}});
const E=(from,port,to)=>({from,port,to});
const R=(col,op,val)=>({col,op,val:val||''});
const C=(id,title,rules,match)=>N(id,'condition',title,{match:match||'all',rules});

// How each workflow is triggered for real (the trigger card on the canvas shows this).
export const TRIGGERS={
  wf0:{board:'Projects',event:'create_item'},
  wf1:{board:'Projects',event:'change_column_value',columns:['Deposit Status']},
  wf2:{board:'Projects',event:'change_column_value',columns:['Deposit Status'],when:{col:'Deposit Status',val:'Received'}},
  wf3:{board:'Projects',event:'change_column_value',columns:['60% Deposit','Deposit Status','CAD status','Survey Approved','Factory Payments']},
  wf4:{board:'Projects',event:'change_column_value',columns:['Installation']},
  wf5:{board:'Projects',event:'change_column_value',columns:['Installation'],when:{col:'Installation',val:'Done'}},
  wf6:{board:'Projects',event:'change_column_value',columns:['Move to Finished']},
  wf7:{board:'Projects',event:'change_column_value',columns:['3rd INV'],when:{col:'3rd INV',val:'Unpaid'}},
  lead:{board:'Leads',event:'create_item'}
};

function WF(){return [
 {id:'wf0',name:'WF0 — New project',color:'#8A6D3B',sample:{'Group':'New Projects','Customer Email':'jane@example.com','SDF Reference':'SDF-2417'},
  desc:'The moment a project is created: makes the Accounts item and sends the customer their order link.',
  nodes:[N('t','trigger','New project created',{board:'Projects',event:'A new item is created'}),
   N('cr','create','Accounts item',{board:'Accounts',item:'{Project name}'}),
   N('e','email','Send the order link',{to:'Customer Email column',subject:'Your Stronghold order {SDF Reference}',body:'Thanks for choosing Stronghold. Your order account is here: {portal link}. You can see progress, documents and what we need from you next.'}),
   N('x','exit','Waits for the deposit',{note:'WF1 takes over when the Deposit Status changes.'})],
  edges:[E('t','out','cr'),E('cr','out','e'),E('e','out','x')]},

 {id:'wf1',name:'WF1 — Deposit & invoicing',color:'#7A68F0',sample:{'Group':'New Projects','Deposit Status':'Received','Customer Email':'jane@example.com'},
  desc:'Reacts to every Deposit Status label: raises the invoice, sends terms, reminds once, thanks the customer, or cancels the order.',
  nodes:[N('t','trigger','Deposit Status changes',{board:'Projects',event:'Someone picks a Deposit Status label'}),
   C('c1','Invoice requested?',[R('Deposit Status','is','Invoice Requested')]),
   N('n1','notify','Raise the deposit invoice',{who:'Accounts team',msg:'Please raise the deposit invoice for {SDF Reference}.'}),
   N('x1','exit','Waits for sending',{note:'Accounts sets the label to Invoice / T&C\'s Sent.'}),
   C('c2','Invoice & T&C\'s sent?',[R('Deposit Status','is','Invoice/T&C\'s Sent')]),
   N('cr1','create','Agreement record',{board:'T&C\'s Agreements',item:'{SDF Reference} — terms v3'}),
   N('e1','email','Invoice, terms and order link',{to:'Customer Email column',subject:'Your deposit invoice and terms — {SDF Reference}',body:'Your deposit invoice is attached. Please read and accept our terms in your order account, then pay the deposit to start your order.'}),
   N('w1','wait','Wait',{for:'5 days'}),
   C('c3','Still waiting for the deposit?',[R('Deposit Status','is','Invoice/T&C\'s Sent')]),
   N('e2','email','Deposit reminder (once)',{to:'Customer Email column',subject:'A gentle reminder — {SDF Reference}',body:'We haven\'t received your deposit yet. Your order starts as soon as it arrives.'}),
   N('x2','exit','Owner decides',{note:'Chase by phone, or mark the project LOST.'}),
   N('x3','exit','Deposit arrived',{note:'Nothing more to do here.'}),
   C('c4','Deposit received?',[R('Deposit Status','is','Received')]),
   N('s1','status','Record the date',{col:'Date deposit received',val:'Today'}),
   N('n2','notify','Deposit is in',{who:'Owner',msg:'Deposit received for {SDF Reference}.'}),
   N('e3','email','Thank you',{to:'Customer Email column',subject:'Deposit received — thank you',body:'We\'ve received your deposit. Your order is now live.'}),
   N('e4','email','What happens next',{to:'Customer Email column',subject:'What happens next',body:'Next: drawings for you to sign off, then a survey visit, then your doors go into production (about 8 weeks).'}),
   N('x4','exit','Hands over to WF2',{note:'Drawings & survey starts.'}),
   C('c5','Marked LOST?',[R('Deposit Status','is','LOST')]),
   N('m1','move','Move to Lost',{group:'Lost'}),
   N('s2','status','Close the record',{col:'Completion date',val:'Today'}),
   N('e5','email','Order cancelled',{to:'Customer Email column',subject:'Your order has been cancelled',body:'Dear {Customer name}, we\'ve closed your order. If this is a mistake, reply to this email.'}),
   N('x5','exit','Project lost',{note:'Leaves the normal flow.'}),
   N('x6','exit','Nothing for this label',{note:'Part Received does nothing on its own.'})],
  edges:[E('t','out','c1'),E('c1','yes','n1'),E('n1','out','x1'),E('c1','no','c2'),E('c2','yes','cr1'),E('cr1','out','e1'),E('e1','out','w1'),E('w1','out','c3'),E('c3','yes','e2'),E('e2','out','x2'),E('c3','no','x3'),E('c2','no','c4'),E('c4','yes','s1'),E('s1','out','n2'),E('n2','out','e3'),E('e3','out','e4'),E('e4','out','x4'),E('c4','no','c5'),E('c5','yes','m1'),E('m1','out','s2'),E('s2','out','e5'),E('e5','out','x5'),E('c5','no','x6')]},

 {id:'wf2',name:'WF2 — Drawings & survey',color:'#0EA5C6',sample:{'Group':'New Projects','CAD status':'','Survey Approved':'','Customer Email':'jane@example.com'},
  desc:'Starts drawings once the deposit is in, nudges the owner until they are approved, then does the same for the survey.',
  nodes:[N('t','trigger','Deposit received',{board:'Projects',event:'Deposit Status changes to Received'}),
   C('c1','Drawings not started yet?',[R('CAD status','is empty'),R('Group','is','New Projects')]),
   N('x1','exit','Already underway',{note:'Drawings were started earlier.'}),
   N('s1','status','Start drawings',{col:'CAD status',val:'To Do'}),
   N('e1','email','Drawings on the way',{to:'Customer Email column',subject:'Your drawings are being prepared',body:'We\'re preparing your door drawings. You\'ll get an email when they are ready to sign off in your order account.'}),
   N('w1','wait','Wait',{for:'2 days'}),
   C('c2','Drawings approved?',[R('CAD status','is','Approved')]),
   N('n1','notify','Drawings still not approved',{who:'Owner',msg:'Drawings for {SDF Reference} are still waiting for approval.'}),
   N('s2','status','Start the survey',{col:'Survey Approved',val:'To Do'}),
   N('n2','notify','Book the survey',{who:'Owner',msg:'Drawings approved for {SDF Reference} — book the survey.'}),
   N('w2','wait','Wait',{for:'1 day'}),
   C('c3','Survey approved?',[R('Survey Approved','is','Approved')]),
   N('n3','notify','Survey still not approved',{who:'Owner',msg:'Survey for {SDF Reference} is still waiting.'}),
   N('x2','exit','Hands over to WF3',{note:'Factory order gate can now pass.'})],
  edges:[E('t','out','c1'),E('c1','no','x1'),E('c1','yes','s1'),E('s1','out','e1'),E('e1','out','w1'),E('w1','out','c2'),E('c2','no','n1'),E('n1','out','w1'),E('c2','yes','s2'),E('s2','out','n2'),E('n2','out','w2'),E('w2','out','c3'),E('c3','no','n3'),E('n3','out','w2'),E('c3','yes','x2')]},

 {id:'wf3',name:'WF3 — Factory order & payments',color:'#E9752F',sample:{'Group':'New Projects','60% Deposit':'Received','CAD status':'Approved','Survey Approved':'Approved','Factory Payments':'50%','Factory Email':'rita@factory.example','Customer Email':'customer@example.com'},
  desc:'When deposit, drawings and survey are all done and the factory is part-paid: one order confirmation, due date set, project moved to In Production. Chases the factory deposit if it isn\'t started.',
  nodes:[N('t1','trigger','A status changes',{board:'Projects',event:'60% Deposit, CAD status, Survey Approved or Factory Payments changes'}),
   C('c1','Ready to order?',[R('Group','is','New Projects'),R('60% Deposit','is','Received'),R('CAD status','is','Approved'),R('Survey Approved','is','Approved'),R('Factory Payments','is any of','50%, 100%')]),
   N('s1','status','Set the due date',{col:'Due Date',val:'Today + 8 weeks'}),
   N('e1','email','Order confirmation to factory',{to:'Factory Email column',subject:'{SDF Reference} Order Confirmation',body:'Dear Rita & Algis,\n\nThis order has been approved and paid for:\nDrawing Status – {CAD status}\nSTR Approval – {Survey Approved}\nFactory Payment – {Factory Payments}\nDeposit Status – {60% Deposit}\nOrder Type – {Type}\n\nPlease proceed with manufacturing as soon as possible. Due date is set 8 weeks from today.\n\nAny questions please contact {Owner}.'}),
   N('m1','move','Into production',{group:'In Production'}),
   N('e2','email','Tell the customer',{to:'Customer Email column',subject:'Your doors are in production',body:'Good news — your doors are now being made. Manufacturing takes about 8 weeks and we will be in touch to book installation.'}),
   N('w1','wait','Wait',{for:'Until 2 weeks before Due Date'}),
   C('c3','Factory fully paid?',[R('Factory Payments','is','100%')]),
   N('x1','exit','All good',{note:'Nothing more to do — installation flow (WF4) takes over.'}),
   N('n1','notify','Risk alert to owner',{who:'Owner',msg:'This order may be late — the factory is not fully paid yet.'}),
   N('x2','exit','Stops after the alert',{note:'Owner decides what to do next.'}),
   C('c2','Factory payment not started?',[R('Factory Payments','is empty')]),
   N('s2','status','Flag factory payment',{col:'Factory Payments',val:'To Do'}),
   N('w2','wait','Wait',{for:'1 day'}),
   C('c4','Factory deposit paid?',[R('Factory Payments','is any of','25%, 50%, 100%')]),
   N('x4','exit','Stops for now',{note:'The gate re-checks the moment the next status changes.'}),
   N('n2','notify','Chase accounts',{who:'Accounts team',msg:'Factory deposit is still not paid — please chase it.'}),
   N('x3','exit','Nothing to do yet',{note:'Waits for the next status change.'})],
  edges:[E('t1','out','c1'),E('c1','yes','s1'),E('c1','no','c2'),E('s1','out','e1'),E('e1','out','m1'),E('m1','out','e2'),E('e2','out','w1'),E('w1','out','c3'),E('c3','yes','x1'),E('c3','no','n1'),E('n1','out','x2'),E('c2','yes','s2'),E('c2','no','x3'),E('s2','out','w2'),E('w2','out','c4'),E('c4','yes','x4'),E('c4','no','n2'),E('n2','out','w2')]},

 {id:'wf4',name:'WF4 — Installation',color:'#2F74E8',sample:{'Group':'In Production','Installation':'Date set','Installation Date':'12 Nov 2026','Deal type':'Standard','2nd INV':'','Customer Email':'jane@example.com'},
  desc:'Reacts to the Installation status: nudges the owner to book, moves the project when a date is set, tells the customer and raises the 30% pre-install invoice.',
  nodes:[N('t','trigger','Installation status changes',{board:'Projects',event:'Someone picks an Installation label'}),
   C('c1','Date set?',[R('Installation','is','Date set')]),
   N('m1','move','Move to Installation',{group:'Installation'}),
   N('e1','email','Installation booked',{to:'Customer Email column',subject:'Your installation is booked for {Installation Date}',body:'Our fitters will arrive on {Installation Date}. Please make sure the area around the door is clear.'}),
   C('c2','Old 60/40 deal?',[R('Deal type','is','Old 60/40')]),
   N('x1','exit','No pre-install invoice',{note:'Old deals have no 30% stage.'}),
   N('s1','status','Request the 30% invoice',{col:'2nd INV',val:'Invoice Requested'}),
   N('n1','notify','Raise the 30% invoice',{who:'Accounts team',msg:'Raise the 30% pre-install invoice for {SDF Reference}.'}),
   N('w1','wait','Wait',{for:'2 days'}),
   C('c3','30% invoice paid?',[R('2nd INV','is','Received')]),
   N('x2','exit','Ready to fit',{note:'Nothing more until installation day.'}),
   N('n2','notify','30% invoice still open',{who:'Accounts team',msg:'The 30% invoice for {SDF Reference} is still unpaid.'}),
   C('c4','Set to To Do?',[R('Installation','is','To Do')]),
   N('n3','notify','Book the installation',{who:'Owner',msg:'Doors for {SDF Reference} are nearly ready — book the installation.'}),
   N('w2','wait','Wait',{for:'2 days'}),
   C('c5','Still not booked?',[R('Installation','is','To Do')]),
   N('n4','notify','Installation still not booked',{who:'Owner',msg:'{SDF Reference} still has no installation date.'}),
   N('x3','exit','Booked',{note:'The Date set branch handles the rest.'}),
   C('c6','Done?',[R('Installation','is','Done')]),
   N('x4','exit','Hands over to WF5',{note:'Balance & review starts.'}),
   N('x5','exit','Nothing for this label',{note:''})],
  edges:[E('t','out','c1'),E('c1','yes','m1'),E('m1','out','e1'),E('e1','out','c2'),E('c2','yes','x1'),E('c2','no','s1'),E('s1','out','n1'),E('n1','out','w1'),E('w1','out','c3'),E('c3','yes','x2'),E('c3','no','n2'),E('n2','out','w1'),E('c1','no','c4'),E('c4','yes','n3'),E('n3','out','w2'),E('w2','out','c5'),E('c5','yes','n4'),E('n4','out','w2'),E('c5','no','x3'),E('c4','no','c6'),E('c6','yes','x4'),E('c6','no','x5')]},

 {id:'wf5',name:'WF5 — Balance & review',color:'#E04E78',sample:{'Group':'Installation','3rd INV':'Received','Days overdue':'0','Customer Email':'jane@example.com'},
  desc:'After fitting: raises the balance invoice, chases it, then asks for a review and sends the warranty.',
  nodes:[N('t','trigger','Installation marked Done',{board:'Projects',event:'Installation changes to Done'}),
   N('s1','status','Request the balance invoice',{col:'3rd INV',val:'Invoice Requested'}),
   N('n1','notify','Raise the balance invoice',{who:'Accounts team',msg:'Raise the final balance invoice for {SDF Reference}.'}),
   N('e1','email','Final invoice',{to:'Customer Email column',subject:'Your doors are in — final balance',body:'Thank you for having us. Your final invoice is in your order account.'}),
   N('w1','wait','Wait',{for:'7 days'}),
   C('c1','Balance received?',[R('3rd INV','is','Received')]),
   N('w3','wait','Wait',{for:'5 days'}),
   N('e2','email','Ask for a review',{to:'Customer Email column',subject:'How did we do?',body:'If you\'re happy with your doors, a Google review would mean a lot: {review link}.'}),
   N('n2','notify','Call about the review',{who:'Owner',msg:'Call {Customer name} about the review.'}),
   N('s2','status','Send the warranty',{col:'Warranty Gen.',val:'Sent'}),
   N('cr1','create','Warranty & O&M record',{board:'Warranties and O&M',item:'{SDF Reference}'}),
   N('e3','email','Warranty and care guide',{to:'Customer Email column',subject:'Your warranty and care guide',body:'Your warranty certificate and O&M guide are now in your order account.'}),
   N('x1','exit','Hands over to WF6',{note:'Ready to be finished.'}),
   N('e4','email','Balance reminder',{to:'Customer Email column',subject:'Reminder — final balance',body:'Your final balance is now due. Pay from your order account.'}),
   N('n3','notify','Balance overdue',{who:'Owner',msg:'Balance for {SDF Reference} is overdue.'}),
   N('w2','wait','Wait',{for:'3 days'}),
   C('c2','Received now?',[R('3rd INV','is','Received')]),
   C('c3','More than 14 days overdue?',[R('Days overdue','is at least','14')]),
   N('s3','status','Mark unpaid',{col:'3rd INV',val:'Unpaid'}),
   N('x2','exit','WF7 takes over',{note:'Legal action lane.'})],
  edges:[E('t','out','s1'),E('s1','out','n1'),E('n1','out','e1'),E('e1','out','w1'),E('w1','out','c1'),E('c1','yes','w3'),E('w3','out','e2'),E('e2','out','n2'),E('n2','out','s2'),E('s2','out','cr1'),E('cr1','out','e3'),E('e3','out','x1'),E('c1','no','e4'),E('e4','out','n3'),E('n3','out','w2'),E('w2','out','c2'),E('c2','yes','w3'),E('c2','no','c3'),E('c3','yes','s3'),E('s3','out','x2'),E('c3','no','w2')]},

 {id:'wf6',name:'WF6 — Finish',color:'#2E9E5B',sample:{'Group':'Installation','Deposit Status':'Received','Factory Payments':'100%','3rd INV':'Received','Customer Email':'jane@example.com'},
  desc:'The Move to Finished button: only works when everything is paid. Closes the project and creates the maintenance record.',
  nodes:[N('t','trigger','Move to Finished clicked',{board:'Projects',event:'Someone presses the Move to Finished button'}),
   C('c1','All paid?',[R('Deposit Status','is','Received'),R('Factory Payments','is','100%'),R('3rd INV','is','Received')]),
   N('n1','notify','Can\'t finish yet',{who:'Owner',msg:'{SDF Reference} still has payments outstanding.'}),
   N('x1','exit','Nothing happens',{note:'Button is ignored until paid.'}),
   N('s1','status','Completion date',{col:'Completion date',val:'Today'}),
   N('m1','move','Move to Finished',{group:'Finished Projects'}),
   N('cr1','create','Maintenance record',{board:'Maintenance',item:'{SDF Reference}'}),
   N('e1','email','Handover complete',{to:'Customer Email column',subject:'All done — thank you',body:'Your project is complete. Your warranty, care guide and invoices stay in your order account.'}),
   N('x2','exit','Project finished',{note:''})],
  edges:[E('t','out','c1'),E('c1','no','n1'),E('n1','out','x1'),E('c1','yes','s1'),E('s1','out','m1'),E('m1','out','cr1'),E('cr1','out','e1'),E('e1','out','x2')]},

 {id:'wf7',name:'WF7 — Legal action',color:'#A32D2D',sample:{'Group':'Installation','3rd INV':'Unpaid'},
  desc:'When the balance is marked Unpaid: moves the project out of the normal flow and opens a Debt record.',
  nodes:[N('t','trigger','Balance marked Unpaid',{board:'Projects',event:'3rd INV changes to Unpaid'}),
   N('m1','move','Move to Legal Action',{group:'Legal Action'}),
   N('cr1','create','Debt record',{board:'Debt',item:'{SDF Reference}'}),
   N('n1','notify','Legal action started',{who:'Owner',msg:'{SDF Reference} moved to Legal Action.'}),
   N('x1','exit','Leaves the normal flow',{note:'Bad Debt is a manual move later.'})],
  edges:[E('t','out','m1'),E('m1','out','cr1'),E('cr1','out','n1'),E('n1','out','x1')]},

 {id:'lead',name:'Lead intake — with AI blocks',color:'#B23A7A',sample:{'Group':'New leads','Lead email':'jane@example.com','Door type':'Front door, RC3','Score':'8','Replied':'No'},
  desc:'A new enquiry is scored by AI, a reply is drafted for sales to approve, and the lead is nudged if it goes quiet.',
  nodes:[N('t','trigger','New lead arrives',{board:'Leads',event:'A new item is created'}),
   N('a1','ai','Score the lead',{task:'Score this enquiry 1–10',prompt:'Read the enquiry, door type, postcode and budget. Score 1–10 for how likely it is to become an order. Reply with the number only.',out:'Score'}),
   C('c1','Worth a fast reply?',[R('Score','is at least','7')]),
   N('a2','ai','Draft a reply',{task:'Write a warm first reply',prompt:'Draft a short, friendly reply in Stronghold\'s voice. Confirm the door type, suggest a showroom visit in Beckenham and ask for a photo of the opening. No prices.',out:'Draft reply'}),
   N('n1','notify','Sales approves the draft',{who:'Sales',msg:'A new lead is ready — check the AI draft and approve it.'}),
   N('e1','email','Send the reply',{to:'Lead email column',subject:'Your enquiry — Stronghold Security Doors',body:'{Draft reply}'}),
   N('s1','status','Mark as contacted',{col:'Status',val:'Contacted'}),
   N('w1','wait','Wait',{for:'3 days'}),
   C('c2','Did they reply?',[R('Replied','is','Yes')]),
   N('x1','exit','Sales takes it from here',{note:'Lead is live and in conversation.'}),
   N('n2','notify','Nudge sales',{who:'Sales',msg:'No reply after 3 days — send a follow-up?'}),
   N('s2','status','Park it',{col:'Status',val:'Nurture'}),
   N('x2','exit','Stops',{note:'Lead joins the monthly newsletter list instead.'})],
  edges:[E('t','out','a1'),E('a1','out','c1'),E('c1','yes','a2'),E('c1','no','s2'),E('a2','out','n1'),E('n1','out','e1'),E('e1','out','s1'),E('s1','out','w1'),E('w1','out','c2'),E('c2','yes','x1'),E('c2','no','n2'),E('n2','out','w1'),E('s2','out','x2')]}
];}

function autoLayout(wf){
  const has=id=>wf.nodes.some(n=>n.id===id);
  const out={}; wf.edges.forEach(e=>{if(has(e.from)&&has(e.to))(out[e.from]=out[e.from]||[]).push(e);});
  const color={}, back=new Set();
  function dfs(u){color[u]=1; for(const e of out[u]||[]){ if(color[e.to]===1) back.add(e); else if(!color[e.to]) dfs(e.to);} color[u]=2;}
  wf.nodes.filter(n=>n.type==='trigger').concat(wf.nodes).forEach(n=>{if(!color[n.id])dfs(n.id);});
  const fwd={}, pred={}, indeg={}; wf.nodes.forEach(n=>indeg[n.id]=0);
  wf.edges.forEach(e=>{if(back.has(e)||!has(e.from)||!has(e.to))return; (fwd[e.from]=fwd[e.from]||[]).push(e.to); (pred[e.to]=pred[e.to]||[]).push(e); indeg[e.to]++;});
  const rank={}; const q=wf.nodes.filter(n=>indeg[n.id]===0).map(n=>n.id); q.forEach(id=>rank[id]=0); const order=[];
  while(q.length){const u=q.shift(); order.push(u); for(const v of fwd[u]||[]){rank[v]=Math.max(rank[v]||0,rank[u]+1); if(--indeg[v]===0)q.push(v);}}
  wf.nodes.forEach(n=>{if(rank[n.id]==null){rank[n.id]=0; order.push(n.id);}});
  const cols={}; order.forEach(id=>{(cols[rank[id]]=cols[rank[id]]||[]).push(id);});
  const y={}; const maxR=Math.max(0,...Object.keys(cols).map(Number));
  for(let r=0;r<=maxR;r++){const c=cols[r]||[];
    const want=c.map(id=>{const ps=(pred[id]||[]).filter(e=>y[e.from]!=null); if(!ps.length)return {id,y:0};
      const ys=ps.map(e=>y[e.from]+(e.port==='yes'?-60:e.port==='no'?60:0)); return {id,y:ys.reduce((a,b)=>a+b,0)/ys.length};});
    want.sort((a,b)=>a.y-b.y); let last=-Infinity; want.forEach(w=>{let yy=w.y; if(yy<last+GAPY)yy=last+GAPY; y[w.id]=yy; last=yy;});}
  const minY=Math.min(0,...Object.values(y));
  wf.nodes.forEach(n=>{n.x=40+(rank[n.id]||0)*GAPX; n.y=Math.round(40+(y[n.id]||0)-minY);});
  wf.view=null;
}


export function defaults(){const ws=WF(); ws.forEach(w=>{const t=w.nodes.find(n=>n.type==='trigger'); const tr=TRIGGERS[w.id]; if(t&&tr){t.p.board=tr.board; t.p.trigger=tr.event; t.p.columns=(tr.columns||[]).join(', '); if(tr.when)t.p.when=tr.when.col+' = '+tr.when.val;} autoLayout(w);}); return ws;}
export { autoLayout };
