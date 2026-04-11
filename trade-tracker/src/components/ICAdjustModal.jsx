// src/components/ICAdjustModal.jsx
// Iron Condor / Iron Butterfly Adjustment Modal — 3-step wizard
// SESSION 112 FIXES:
//   IC-R1: "Take Full Profit" → "Close Entire Position" (neutral name — works for profit AND stop-loss)
//   IC-R2: "Close Entire Position" adapts to partial chain — shows only open legs, hides closed ones
//   IC-R3: "Reduce Both Legs" → "Reduce Position" (neutral, works when only one leg remains)
//   IC-R4: "Reduce Position" adapts to open legs — per-leg contracts + price, independent validation
//   IC-R5: Per-leg contracts validation — blocks full close (>= open), blocks over-close (> open)
//   IC-R6: Tile list in Step 1 filters out invalid options based on chain state
//   IC-R7: "ATM body matches" green confirmation removed (was pushing Call Credit input down)
//   IC-R8: IB advisory when only one wing remains open
import React, { useState, useMemo, useEffect, useRef, useCallback} from 'react';
import ExpiryDatePicker from './ExpiryDatePicker';
const localDateISO = (d=new Date()) => { const yr=d.getFullYear(),mo=String(d.getMonth()+1).padStart(2,'0'),dy=String(d.getDate()).padStart(2,'0'); return `${yr}-${mo}-${dy}`; };

function occStrikeWarn(strike, spot) {
  if (!strike || !spot || isNaN(parseFloat(strike)) || isNaN(parseFloat(spot))) return null;
  const s = parseFloat(strike), p = parseFloat(spot);
  if (s <= 0 || p <= 0) return null;
  const incr = p < 5 ? 0.5 : p < 25 ? 1 : p < 200 ? 2.5 : 5;
  const remainder = Math.abs(Math.round(s / incr) * incr - s);
  if (remainder < 0.001) return null;
  const lo = (Math.floor(s / incr) * incr).toFixed(incr < 1 ? 1 : 0);
  const hi = (Math.ceil(s  / incr) * incr).toFixed(incr < 1 ? 1 : 0);
  return `$${s} may not be a valid strike — OCC increments for a $${p.toFixed(0)} stock are $${incr}. Nearest: $${lo} or $${hi}.`;
}

const ALL_ADJUSTMENT_TYPES = [
  { id:'roll_one_leg',      label:'Roll one leg',            icon:'↩',  desc:'Close the tested spread (put or call side) and reopen at new strikes or expiry for a credit. The other leg stays untouched.', needsLeg:true,  needsClose:true, needsNewLeg:true,  needsResize:false, requiresAnyOpen:true },
  { id:'roll_full',         label:'Roll full position',       icon:'↻',  desc:'Close all open legs simultaneously and reopen at a later expiry. For IC: same or wider strikes. For IB: same ATM body, adjust wing width only.', needsLeg:false, needsClose:true, needsNewLeg:true,  needsResize:false, requiresBothOpen:true },
  { id:'reduce_one',        label:'Reduce size — one leg',   icon:'½',  desc:'Close some (not all) contracts on one leg only. The remaining contracts stay open on both sides.', needsLeg:true,  needsClose:true, needsNewLeg:false, needsResize:false, isPartial:true, requiresAnyOpen:true },
  { id:'reduce_position',   label:'Reduce Position',         icon:'⇊',  desc:'Close some (not all) contracts on one or both open legs. Enter separate prices and contract counts per wing — they can differ.', needsLeg:false, needsClose:true, needsNewLeg:false, needsResize:false, isReducePosition:true, requiresAnyOpen:true },
  { id:'roll_resize',       label:'Roll + reduce',           icon:'↩½', desc:'Close the tested side fully and reopen with fewer contracts at new strikes. Reduces position risk while adjusting strikes.', needsLeg:true,  needsClose:true, needsNewLeg:true,  needsResize:true,  requiresAnyOpen:true },
  { id:'close_one',         label:'Close one leg',           icon:'✓',  desc:'Close one side entirely. Close the tested (losing) side to cut risk — the safe side collects at expiry. Or close the safe (winning) side to let the tested wing run solo as a credit spread. The other leg stays open either way.', needsLeg:true,  needsClose:true, needsNewLeg:false, needsResize:false, requiresAnyOpen:true },
  { id:'close_position',    label:'Close Position',          icon:'✕',  desc:'Close all remaining open legs — at profit target, stop-loss, or ahead of a catalyst. Shows only legs that are still open.', needsLeg:false, needsClose:true, needsNewLeg:false, needsResize:false, isClosePosition:true, requiresAnyOpen:true },

];

const fmt    = n => n==null ? '—' : '$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtPnl = n => { if(n==null) return '—'; return (n>=0?'+':'')+fmt(n); };

const PnlBadge = ({ label, value, size=13 }) => value==null ? null : (
  <div style={{padding:'6px 10px',borderRadius:6,background:value>=0?'var(--green-bg)':'var(--red-bg)',border:`1px solid ${value>=0?'var(--green-border,#b7e3c0)':'var(--red-border,#f5c6cb)'}`}}>
    {label&&<div style={{fontSize:10,color:'var(--text-muted)',marginBottom:2}}>{label}</div>}
    <div style={{fontFamily:'var(--font-mono)',fontWeight:700,fontSize:size,color:value>=0?'var(--green)':'var(--red)'}}>{fmtPnl(value)}</div>
  </div>
);

// LegCloseRow defined at module level to prevent React remounting input on every render.
// (Defining a component inside another component body causes React to treat it as a new
// component type on each render → unmounts + remounts → input loses focus after every keystroke.)
function LegCloseRow({side,legObj,priceVal,setPriceVal,contsVal,setContsVal,showContracts,contsError}){
  if(!legObj) return null;
  const pnl=priceVal!==''&&legObj?(legObj.entry_price-parseFloat(priceVal))*(contsVal?parseInt(contsVal):legObj.contracts_open)*100:null;
  const numVal=parseFloat(priceVal);
  return(
    <div style={{background:'var(--bg-hover)',borderRadius:8,padding:'10px 12px',marginBottom:10}}>
      <div style={{fontSize:11,fontWeight:700,color:'var(--text-secondary)',marginBottom:8}}>
        {side==='put'?'📉 Put Wing':'📈 Call Wing'} · entry ${legObj.entry_price?.toFixed(2)} · {legObj.contracts_open} contract{legObj.contracts_open!==1?'s':''} open
      </div>
      <div style={{display:'grid',gridTemplateColumns:showContracts?'1fr 1fr':'1fr',gap:8}}>
        {showContracts&&(
          <div className="form-group" style={{margin:0}}>
            <label className="form-label" style={{fontSize:11}}>Contracts to reduce * <span style={{color:'var(--text-muted)'}}>(max {legObj.contracts_open-1})</span></label>
            <input type="number" min="1" max={legObj.contracts_open-1} step="1"
              value={contsVal} onChange={e=>setContsVal(e.target.value)} placeholder="e.g. 1"
              style={{borderColor:contsError?'var(--red,#c0392b)':undefined}}/>
            {contsError&&<div style={{fontSize:10,color:'var(--red)',marginTop:2}}>{contsError}</div>}
          </div>
        )}
        <div className="form-group" style={{margin:0}}>
          <label className="form-label" style={{fontSize:11}}>Buy-back price ($/sh) *</label>
          <input type="number" step="0.01" min="0" value={priceVal} onChange={e=>setPriceVal(e.target.value)} placeholder="e.g. 0.32"
            style={{borderColor:priceVal!==''&&!isNaN(numVal)&&numVal>=(legObj.entry_price||99)?'var(--amber)':undefined}}/>
          {priceVal!==''&&!isNaN(numVal)&&<div style={{fontSize:10,color:numVal<legObj.entry_price?'var(--green)':'var(--amber)',marginTop:2}}>
            {numVal<legObj.entry_price?'✓ profit':'⚠ loss vs entry'}
          </div>}
        </div>
      </div>
      {pnl!=null&&<div style={{marginTop:8}}><PnlBadge label={`${side} leg P&L`} value={pnl} size={12}/></div>}
    </div>
  );
}

export default function ICAdjustModal({ trade, chainTrades, onAdjust, historicalMode, onClose }) {
  const [pos,setPos]=useState(null); const [dragging,setDragging]=useState(false);
  const dragOffset=useRef({x:0,y:0}); const modalRef=useRef(null);
  const onMouseDownHeader=useCallback(e=>{
    if(e.button!==0)return; e.preventDefault();
    const rect=modalRef.current?.getBoundingClientRect(); if(!rect)return;
    dragOffset.current={x:e.clientX-rect.left,y:e.clientY-rect.top};
    if(!pos)setPos({x:rect.left,y:rect.top}); setDragging(true);
  },[pos]);
  useEffect(()=>{
    if(!dragging)return;
    const onMove=e=>{
      const rect=modalRef.current?.getBoundingClientRect(); const w=rect?.width||560;
      setPos({x:Math.max(-w+80,Math.min(window.innerWidth-80,e.clientX-dragOffset.current.x)),y:Math.max(0,Math.min(window.innerHeight-80,e.clientY-dragOffset.current.y))});
    };
    const onUp=()=>setDragging(false);
    document.addEventListener('mousemove',onMove); document.addEventListener('mouseup',onUp);
    return()=>{document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);};
  },[dragging]);
  const modalStyle=pos?{position:'fixed',top:pos.y,left:pos.x,margin:0,maxHeight:'90vh',display:'flex',flexDirection:'column'}:{maxHeight:'90vh',display:'flex',flexDirection:'column'};

  const [step,setStep]=useState(1);
  const [adjType,setAdjType]=useState(null);
  const [leg,setLeg]=useState('put');
  // Single-leg ops
  const [closePrice,setClosePrice]=useState('');
  const [contractsToClose,setContractsToClose]=useState('');
  // close_position / reduce_position — per-leg state
  const [closePutPrice,setClosePutPrice]=useState('');
  const [closeCallPrice,setCloseCallPrice]=useState('');
  const [putContractsToClose,setPutContractsToClose]=useState('');
  const [callContractsToClose,setCallContractsToClose]=useState('');
  // roll_full new wings
  const [newStrikeBuy,setNewStrikeBuy]=useState('');
  const [newStrikeSell,setNewStrikeSell]=useState('');
  const [newExpiry,setNewExpiry]=useState('');
  const [newPremium,setNewPremium]=useState('');
  const [newContracts,setNewContracts]=useState('');
  const [putSellStrike,setPutSellStrike]=useState(''); const [putBuyStrike,setPutBuyStrike]=useState(''); const [putPremium,setPutPremium]=useState('');
  const [callSellStrike,setCallSellStrike]=useState(''); const [callBuyStrike,setCallBuyStrike]=useState(''); const [callPremium,setCallPremium]=useState('');
  const [adjDate,setAdjDate]=useState(localDateISO());
  const [notes,setNotes]=useState('');
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');

  const chainId=trade.condor_chain_id||trade.id;
  const allChain=chainTrades||[trade];
  const selected=ALL_ADJUSTMENT_TYPES.find(t=>t.id===adjType);
  const isIB=trade.strategy==='Iron Butterfly';

  // Dynamic section headers for Step 2 — change based on selected adjustment type
  const CLOSE_SECTION_LABELS = {
    roll_one_leg:    'Close tested leg',
    roll_full:       'Close all open legs',
    reduce_one:      'Reduce size — one leg',
    reduce_position: 'Reduce position size',
    roll_resize:     'Close tested leg',
    close_one:       'Close one leg',
    close_position:  'Close position',
  };
  const NEW_LEG_SECTION_LABELS = {
    roll_one_leg:  'New leg details',
    roll_full:     isIB ? 'New butterfly (same ATM body)' : 'New position',
    roll_resize:   'New leg details (reduced size)',
  };
  const closeSectionLabel = CLOSE_SECTION_LABELS[adjType] || 'Close existing position';
  const newLegSectionLabel = NEW_LEG_SECTION_LABELS[adjType] || 'New position';

  const openPutLeg  = useMemo(()=>allChain.filter(t=>(t.condor_leg==='put'||t.condor_leg==='full')&&(t.contracts_open||0)>0).sort((a,b)=>b.condor_seq-a.condor_seq)[0]||null,[allChain]);
  const openCallLeg = useMemo(()=>allChain.filter(t=>t.condor_leg==='call'&&(t.contracts_open||0)>0).sort((a,b)=>b.condor_seq-a.condor_seq)[0]||null,[allChain]);
  const bothOpen    = !!(openPutLeg && openCallLeg);
  const anyOpen     = !!(openPutLeg || openCallLeg);
  const maxContracts= leg==='put'?(openPutLeg?.contracts_open||trade.contracts||1):(openCallLeg?.contracts_open||trade.contracts||1);
  const currentSeq  = Math.max(...allChain.map(t=>t.condor_seq||0));

  // Filter tile list based on chain state
  const ADJUSTMENT_TYPES = useMemo(()=>ALL_ADJUSTMENT_TYPES.filter(t=>{
    if(t.requiresBothOpen && !bothOpen) return false;
    if(t.requiresAnyOpen  && !anyOpen)  return false;
    return true;
  }),[bothOpen,anyOpen]);

  // IB one-wing-open advisory
  const ibOneWingAdvisory = useMemo(()=>{
    if(!isIB) return null;
    if(openPutLeg && !openCallLeg) return 'Call wing already closed — remaining position is a Bull Put Spread.';
    if(openCallLeg && !openPutLeg) return 'Put wing already closed — remaining position is a Bear Call Spread.';
    return null;
  },[isIB,openPutLeg,openCallLeg]);

  const chainPnL=useMemo(()=>{
    let p=0;
    allChain.forEach(t=>{if((t.contracts_closed||0)>0&&t.exit_price!=null)p+=(t.entry_price-t.exit_price)*t.contracts_closed*100;p+=t.partial_close_pnl||0;});
    return p;
  },[allChain]);

  // P&L preview
  const pnlPreview=useMemo(()=>{
    if(!adjType||!selected) return null;

    if(adjType==='close_position'){
      const pp=parseFloat(closePutPrice)||null;
      const cp=parseFloat(closeCallPrice)||null;
      const pc=openPutLeg?.contracts_open||1;
      const cc=openCallLeg?.contracts_open||1;
      const putPnl=pp!=null&&openPutLeg?(openPutLeg.entry_price-pp)*pc*100:null;
      const callPnl=cp!=null&&openCallLeg?(openCallLeg.entry_price-cp)*cc*100:null;
      const total=(putPnl??0)+(callPnl??0);
      const bothNeeded=(openPutLeg&&!pp)||(openCallLeg&&!cp);
      return{putPnl,callPnl,total,readyToReview:!bothNeeded};
    }

    if(adjType==='reduce_position'){
      const pp=parseFloat(closePutPrice)||null;
      const cp=parseFloat(closeCallPrice)||null;
      const pn=parseInt(putContractsToClose)||0;
      const cn=parseInt(callContractsToClose)||0;
      const putPnl=pp!=null&&openPutLeg&&pn>0?(openPutLeg.entry_price-pp)*pn*100:null;
      const callPnl=cp!=null&&openCallLeg&&cn>0?(openCallLeg.entry_price-cp)*cn*100:null;
      const total=(putPnl??0)+(callPnl??0);
      return{putPnl,callPnl,total,pn,cn};
    }

    if(adjType==='roll_full'){
      const pc=openPutLeg?.contracts_open||1; const cc=openCallLeg?.contracts_open||1;
      const nConts=parseInt(newContracts)||Math.max(pc,cc);
      const putClose=parseFloat(closePutPrice)||0; const callClose=parseFloat(closeCallPrice)||0;
      const putClosePnl=openPutLeg?(openPutLeg.entry_price-putClose)*pc*100:0;
      const callClosePnl=openCallLeg?(openCallLeg.entry_price-callClose)*cc*100:0;
      const newPutCredit=(parseFloat(putPremium)||0)*nConts*100;
      const newCallCredit=(parseFloat(callPremium)||0)*nConts*100;
      const closeDebit=(putClose*pc+callClose*cc)*100;
      return{putClosePnl,callClosePnl,closeTotal:putClosePnl+callClosePnl,newPutCredit,newCallCredit,netAdj:newPutCredit+newCallCredit-closeDebit};
    }

    // Single-leg
    const close=parseFloat(closePrice)||0;
    const nClose=parseInt(contractsToClose)||(selected?.isPartial?0:maxContracts);
    const nConts=parseInt(newContracts)||nClose;
    const srcLeg=leg==='put'?openPutLeg:openCallLeg;
    const closePnl=srcLeg?(srcLeg.entry_price-close)*nClose*100:0;
    const newCredit=selected?.needsNewLeg?(parseFloat(newPremium)||0)*nConts*100:0;
    const netAdj=selected?.needsNewLeg?newCredit-close*nClose*100:closePnl;
    return{closePnl,newCredit,netAdj};
  },[adjType,selected,closePutPrice,closeCallPrice,closePrice,contractsToClose,putContractsToClose,callContractsToClose,newContracts,newPremium,putPremium,callPremium,openPutLeg,openCallLeg,leg,maxContracts]);

  const goldenRuleViolation=useMemo(()=>{
    if(!['roll_one_leg','roll_resize','roll_full'].includes(adjType)) return null;
    if(adjType==='roll_full'){
      const pc=openPutLeg?.contracts_open||1; const cc=openCallLeg?.contracts_open||1;
      const nConts=parseInt(newContracts)||Math.max(pc,cc);
      const putClose=parseFloat(closePutPrice)||0; const callClose=parseFloat(closeCallPrice)||0;
      const netPerShare=(parseFloat(putPremium)||0)+(parseFloat(callPremium)||0)-putClose*(pc/nConts)-callClose*(cc/nConts);
      if(((parseFloat(putPremium)||0)>0||(parseFloat(callPremium)||0)>0)&&netPerShare<0)
        return 'Net debit roll — new total credit is less than the buy-back cost. Only roll when collecting net credit.';
    } else {
      const close=parseFloat(closePrice)||0; const np=parseFloat(newPremium)||0;
      if(np>0&&np<close) return `Net debit roll — new premium ($${np.toFixed(2)}) is less than buy-back ($${close.toFixed(2)}). Only roll when collecting net credit.`;
    }
    return null;
  },[adjType,closePrice,closePutPrice,closeCallPrice,newPremium,putPremium,callPremium,newContracts,openPutLeg,openCallLeg]);

  // Per-leg contracts validation errors (reduce_position)
  const legContractErrors=useMemo(()=>{
    const errs={put:null,call:null};
    if(adjType!=='reduce_position') return errs;
    if(openPutLeg){
      const n=parseInt(putContractsToClose)||0;
      const avail=openPutLeg.contracts_open;
      if(n<=0) errs.put='Enter at least 1 contract.';
      else if(n>avail) errs.put=`Only ${avail} contract${avail!==1?'s':''} open on put leg.`;
      else if(n>=avail) errs.put=`Closing all ${avail} contract${avail!==1?'s':''} fully closes this leg — use "Close Entire Position" instead.`;
    }
    if(openCallLeg){
      const n=parseInt(callContractsToClose)||0;
      const avail=openCallLeg.contracts_open;
      if(n<=0) errs.call='Enter at least 1 contract.';
      else if(n>avail) errs.call=`Only ${avail} contract${avail!==1?'s':''} open on call leg.`;
      else if(n>=avail) errs.call=`Closing all ${avail} contract${avail!==1?'s':''} fully closes this leg — use "Close Entire Position" instead.`;
    }
    return errs;
  },[adjType,openPutLeg,openCallLeg,putContractsToClose,callContractsToClose]);

  function validate(){
    if(!adjType){setError('Please select an adjustment type.');return false;}

    if(adjType==='close_position'){
      if(openPutLeg&&!closePutPrice){setError('Enter the put wing buy-back price.');return false;}
      if(openCallLeg&&!closeCallPrice){setError('Enter the call wing buy-back price.');return false;}
      return true;
    }

    if(adjType==='reduce_position'){
      if(openPutLeg){
        const n=parseInt(putContractsToClose)||0;
        if(n<=0){setError('Enter at least 1 contract to reduce on put leg.');return false;}
        if(n>=openPutLeg.contracts_open){setError(`Reducing all ${openPutLeg.contracts_open} put contracts fully closes this leg — use "Close Entire Position" instead.`);return false;}
        if(n>openPutLeg.contracts_open){setError(`Only ${openPutLeg.contracts_open} contracts open on put leg.`);return false;}
        if(!closePutPrice){setError('Enter the put wing close price.');return false;}
      }
      if(openCallLeg){
        const n=parseInt(callContractsToClose)||0;
        if(n<=0){setError('Enter at least 1 contract to reduce on call leg.');return false;}
        if(n>=openCallLeg.contracts_open){setError(`Reducing all ${openCallLeg.contracts_open} call contracts fully closes this leg — use "Close Entire Position" instead.`);return false;}
        if(n>openCallLeg.contracts_open){setError(`Only ${openCallLeg.contracts_open} contracts open on call leg.`);return false;}
        if(!closeCallPrice){setError('Enter the call wing close price.');return false;}
      }
      return true;
    }

    if(adjType==='roll_full'){
      if(!closePutPrice&&openPutLeg){setError('Enter put wing buy-back price.');return false;}
      if(!closeCallPrice&&openCallLeg){setError('Enter call wing buy-back price.');return false;}
      if(!newExpiry){setError('Enter new expiration for the rolled condor.');return false;}
      if(newExpiry<localDateISO()){setError('New expiration must be in the future.');return false;}
      if(!putSellStrike||!putBuyStrike||!putPremium){setError('Enter all put wing fields (sell strike, buy strike, credit).');return false;}
      if(!callSellStrike||!callBuyStrike||!callPremium){setError('Enter all call wing fields (sell strike, buy strike, credit).');return false;}
      if(parseFloat(putSellStrike)<=parseFloat(putBuyStrike)){setError('Put sell strike must be above put buy strike.');return false;}
      if(parseFloat(callSellStrike)>=parseFloat(callBuyStrike)){setError('Call sell strike must be below call buy strike.');return false;}
      if(parseFloat(callSellStrike)<=parseFloat(putSellStrike)){setError('Call sell strike must be above put sell strike — wings overlap!');return false;}
      // IB: both sell strikes must be equal (same ATM body) — that is what defines the butterfly.
      if(isIB && parseFloat(putSellStrike) !== parseFloat(callSellStrike)){
        setError(`Iron Butterfly: put sell strike ($${putSellStrike}) and call sell strike ($${callSellStrike}) must be the same ATM body.`);
        return false;
      }
      return true;
    }

    if(!closePrice){setError('Enter the buy-back price.');return false;}
    if(selected?.isPartial){
      const n=parseInt(contractsToClose)||0;
      if(n<=0){setError('Enter at least 1 contract to reduce.');return false;}
      if(n>=maxContracts){setError(`Cannot reduce all ${maxContracts} contracts — use Close one leg to close the full side.`);return false;}
    }
    if(selected?.needsNewLeg){
      if(!newExpiry){setError('Enter the new expiration date.');return false;}
      if(newExpiry<localDateISO()){setError('New expiration must be in the future.');return false;}
      if(!newPremium){setError('Enter the new premium.');return false;}
      // IB: sell strike (ATM body) must match the original — cannot change on a roll.
      if(isIB){
        const originalSell = parseFloat(leg==='put' ? openPutLeg?.strike_sell : openCallLeg?.strike_sell) || null;
        const enteredSell  = parseFloat(newStrikeSell) || null;
        if(enteredSell && originalSell && enteredSell !== originalSell){
          setError(`Iron Butterfly: sell strike must stay at $${originalSell} (the ATM body). Only the buy strike and expiry can change.`);
          return false;
        }
      }
    }
    if(selected?.needsResize){
      const nc=parseInt(newContracts)||0;
      if(nc<=0){setError('Enter the number of contracts to reopen (at least 1).');return false;}
      if(nc>=maxContracts){setError(`New contracts (${nc}) must be fewer than current ${maxContracts} — Roll + Reduce must reduce size. Use Roll one leg to keep the same size.`);return false;}
    }
    return true;
  }

  async function submit(){
    if(!validate())return;
    setSaving(true);setError('');
    try{
      const isDualClose=['close_position','roll_full'].includes(adjType);
      const isReducePos=adjType==='reduce_position';
      const body={
        chain_id:chainId, adjustment_type:adjType,
        leg:selected?.needsLeg?leg:'both',
        contracts_to_close:selected?.isPartial?(parseInt(contractsToClose)||maxContracts):maxContracts,
        close_price:(!isDualClose&&!isReducePos)?(parseFloat(closePrice)||0):null,
        // close_position / reduce_position / roll_full per-leg prices
        close_put_price:(isDualClose||isReducePos)?(parseFloat(closePutPrice)||null):null,
        close_call_price:(isDualClose||isReducePos)?(parseFloat(closeCallPrice)||null):null,
        // reduce_position per-leg contracts
        put_contracts_to_close:isReducePos?(parseInt(putContractsToClose)||null):null,
        call_contracts_to_close:isReducePos?(parseInt(callContractsToClose)||null):null,
        date:adjDate, notes,
        new_strike_buy:adjType==='roll_full'?null:(parseFloat(newStrikeBuy)||null),
        // IB: sell strike is locked to ATM body — send the original leg's strike_sell, not newStrikeSell state (which is '' when readOnly)
        new_strike_sell:adjType==='roll_full'?null:
          isIB?(parseFloat(leg==='put'?openPutLeg?.strike_sell:openCallLeg?.strike_sell)||parseFloat(newStrikeSell)||null)
              :(parseFloat(newStrikeSell)||null),
        new_expiry:newExpiry||null,
        new_premium:adjType==='roll_full'?null:(parseFloat(newPremium)||null),
        new_contracts:parseInt(newContracts)||null,
        roll_full_put_sell:adjType==='roll_full'?(parseFloat(putSellStrike)||null):null,
        roll_full_put_buy:adjType==='roll_full'?(parseFloat(putBuyStrike)||null):null,
        roll_full_put_credit:adjType==='roll_full'?(parseFloat(putPremium)||null):null,
        roll_full_call_sell:adjType==='roll_full'?(isIB?(parseFloat(putSellStrike)||null):(parseFloat(callSellStrike)||null)):null,
        roll_full_call_buy:adjType==='roll_full'?(parseFloat(callBuyStrike)||null):null,
        roll_full_call_credit:adjType==='roll_full'?(parseFloat(callPremium)||null):null,
      };
      await onAdjust(body);
      onClose();
    }catch(e){setError(e.message||'Adjustment failed.');}
    setSaving(false);
  }

  // Reusable per-leg close row


  return(
    <div className="modal-backdrop" onClick={e=>!dragging&&e.target===e.currentTarget&&onClose()}
      style={{alignItems:pos?'flex-start':'center',justifyContent:pos?'flex-start':'center'}}>
      <div className="modal modal-lg" ref={modalRef} style={modalStyle}>
        <div className="modal-header" onMouseDown={onMouseDownHeader} title="Drag to move"
          style={{cursor:dragging?'grabbing':'grab',userSelect:'none'}}>
          <div>
            <h3>Adjust {trade.strategy} — {trade.ticker}</h3>
            <div style={{fontSize:12,color:'var(--text-muted)',marginTop:3}}>
              Chain #{Math.abs(chainId)} · Seq {currentSeq} · Running P&L:{' '}
              <span style={{color:chainPnL>=0?'var(--green)':'var(--red)',fontWeight:600}}>{fmtPnl(chainPnL)}</span>
            </div>
          </div>
          <button className="modal-close" onMouseDown={e=>e.stopPropagation()} onClick={onClose}>✕</button>
        </div>

        {/* IB one-wing advisory */}
        {ibOneWingAdvisory&&(
          <div style={{background:'var(--blue-bg,#e8f4fd)',border:'1px solid var(--blue-border,#bee3f8)',borderRadius:6,padding:'7px 12px',margin:'0 0 8px',fontSize:12,color:'var(--blue,#2b6cb0)'}}>
            ℹ️ {ibOneWingAdvisory}
          </div>
        )}

        {/* Step indicators */}
        <div style={{display:'flex',gap:4,padding:'8px 0 14px',borderBottom:'1px solid var(--border)'}}>
          {['Choose type','Enter details','Confirm'].map((s,i)=>(
            <div key={i} style={{display:'flex',alignItems:'center',gap:6,fontSize:12,
              color:step===i+1?'var(--accent)':step>i+1?'var(--green)':'var(--text-muted)',fontWeight:step===i+1?700:400}}>
              <span style={{width:20,height:20,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,
                background:step===i+1?'var(--accent)':step>i+1?'var(--green)':'var(--border)',
                color:step>=i+1?'#fff':'var(--text-muted)'}}>{step>i+1?'✓':i+1}</span>
              {s}{i<2&&<span style={{color:'var(--border-strong)',marginLeft:4}}>→</span>}
            </div>
          ))}
        </div>

        {/* STEP 1 */}
        {step===1&&(
          <div style={{overflowY:'auto',flex:1,minHeight:0,paddingBottom:8}}>
            <div className="modal-section-title">What would you like to do?</div>
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {ADJUSTMENT_TYPES.map(t=>(
                <div key={t.id} onClick={()=>setAdjType(t.id)}
                  style={{padding:'10px 14px',borderRadius:'var(--radius-md)',cursor:'pointer',
                    border:adjType===t.id?'2px solid var(--accent)':'1px solid var(--border)',
                    background:adjType===t.id?'var(--accent-light)':'var(--bg-card)',
                    display:'flex',alignItems:'flex-start',gap:12}}>
                  <span style={{fontSize:18,fontFamily:'var(--font-mono)',color:adjType===t.id?'var(--accent)':'var(--text-muted)',minWidth:28,textAlign:'center'}}>{t.icon}</span>
                  <div>
                    <div style={{fontWeight:700,fontSize:13,color:adjType===t.id?'var(--accent)':'var(--text-primary)'}}>{t.label}</div>
                    <div style={{fontSize:12,color:'var(--text-secondary)',marginTop:2,lineHeight:1.5}}>{t.desc}</div>
                  </div>
                  {adjType===t.id&&<span style={{marginLeft:'auto',color:'var(--accent)',fontSize:16,flexShrink:0}}>✓</span>}
                </div>
              ))}
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" onClick={()=>{if(!adjType){setError('Select an adjustment type.');return;}setError('');setStep(2);}} disabled={!adjType}>Next →</button>
            </div>
            {error&&<div className="alert alert-red" style={{marginTop:8}}>{error}</div>}
          </div>
        )}

        {/* STEP 2 */}
        {step===2&&selected&&(
          <div style={{overflowY:'auto',flex:1,minHeight:0,paddingBottom:8}}>
            {selected.needsLeg&&(
              <>
                <div className="modal-section-title">Which leg?</div>
                <div style={{display:'flex',gap:10,marginBottom:14}}>
                  {[['put',openPutLeg],['call',openCallLeg]].map(([l,legObj])=>(
                    <button key={l} onClick={()=>setLeg(l)} className={`btn ${leg===l?'btn-primary':'btn-outline'} btn-sm`}
                      style={{flex:1,textTransform:'capitalize',opacity:legObj?1:0.45}} disabled={!legObj}>
                      {l} spread {legObj?`(${legObj.contracts_open} open)`:'(none)'}
                    </button>
                  ))}
                </div>
              </>
            )}

            <div className="modal-section-title">{closeSectionLabel}</div>
            <div className="form-group" style={{marginBottom:14}}>
              <label className="form-label">Adjustment date</label>
              <input type="date" value={adjDate} onChange={e=>setAdjDate(e.target.value)} style={{maxWidth:200}}/>
            </div>

            {/* close_position — adaptive per open leg */}
            {adjType==='close_position'&&(
              <>
                {!openPutLeg&&!openCallLeg&&(
                  <div className="alert alert-blue" style={{marginBottom:12}}>Both legs are already closed — this chain is fully closed.</div>
                )}
                <LegCloseRow side="put"  legObj={openPutLeg}  priceVal={closePutPrice}  setPriceVal={setClosePutPrice}  showContracts={false}/>
                <LegCloseRow side="call" legObj={openCallLeg} priceVal={closeCallPrice} setPriceVal={setCloseCallPrice} showContracts={false}/>
                {pnlPreview?.readyToReview&&(openPutLeg||openCallLeg)&&(
                  <div style={{marginTop:4}}><PnlBadge label={`Total P&L — ${[openPutLeg&&'put',openCallLeg&&'call'].filter(Boolean).join(' + ')} leg${(openPutLeg&&openCallLeg)?'s':''}`} value={pnlPreview.total} size={16}/></div>
                )}
              </>
            )}

            {/* reduce_position — per-leg contracts + price */}
            {adjType==='reduce_position'&&(
              <>
                {ibOneWingAdvisory&&<div style={{background:'var(--blue-bg,#e8f4fd)',border:'1px solid var(--blue-border,#bee3f8)',borderRadius:6,padding:'6px 10px',marginBottom:10,fontSize:12,color:'var(--blue,#2b6cb0)'}}>ℹ️ {ibOneWingAdvisory}</div>}
                <LegCloseRow side="put"  legObj={openPutLeg}  priceVal={closePutPrice}  setPriceVal={setClosePutPrice}
                  contsVal={putContractsToClose}  setContsVal={setPutContractsToClose}  showContracts={true} contsError={legContractErrors.put}/>
                <LegCloseRow side="call" legObj={openCallLeg} priceVal={closeCallPrice} setPriceVal={setCloseCallPrice}
                  contsVal={callContractsToClose} setContsVal={setCallContractsToClose} showContracts={true} contsError={legContractErrors.call}/>
                {(pnlPreview?.putPnl!=null||pnlPreview?.callPnl!=null)&&(
                  <div style={{marginTop:4}}><PnlBadge label="Total P&L this reduction" value={pnlPreview.total} size={16}/></div>
                )}
              </>
            )}

            {/* roll_full */}
            {adjType==='roll_full'&&(
              <>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
                  {[['put','📉 Close Put Wing',openPutLeg,closePutPrice,setClosePutPrice],
                    ['call','📈 Close Call Wing',openCallLeg,closeCallPrice,setCloseCallPrice]].map(([side,lbl,legObj,val,setVal])=>(
                    <div key={side}>
                      <div style={{fontSize:11,fontWeight:700,color:'var(--text-secondary)',marginBottom:6}}>{lbl}</div>
                      <div className="form-group" style={{margin:0}}>
                        <label className="form-label" style={{fontSize:11}}>Buy-back * {legObj?`(entry: $${legObj.entry_price?.toFixed(2)})`:'—'}</label>
                        <input type="number" step="0.01" value={val} onChange={e=>setVal(e.target.value)} placeholder="e.g. 0.20"/>
                      </div>
                      {val!==''&&legObj&&<div style={{marginTop:4}}><PnlBadge label={`${side} close P&L`} value={(legObj.entry_price-parseFloat(val))*(legObj.contracts_open||1)*100} size={11}/></div>}
                    </div>
                  ))}
                </div>
                <div className="modal-section-title" style={{marginTop:16}}>{newLegSectionLabel}</div>
                {isIB&&(
                  <div style={{background:'var(--blue-bg,#e8f4fd)',border:'1px solid var(--blue-border,#bee3f8)',
                    borderRadius:6,padding:'8px 12px',marginBottom:10,fontSize:12,color:'var(--blue,#2b6cb0)'}}>
                    ℹ️ <strong>Iron Butterfly:</strong> both wings must share the same ATM body (sell strike).
                    Enter the ATM body once in the put wing — the call sell strike will match automatically.
                    Adjust wing width (buy strikes) and credit on each side independently.
                  </div>
                )}
                <div style={{maxWidth:260}}><div className="form-group"><label className="form-label">New expiration *</label><ExpiryDatePicker value={newExpiry} onChange={setNewExpiry} min={historicalMode ? undefined : localDateISO()}/></div></div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginTop:8}}>
                  <div>
                    <div style={{fontSize:11,fontWeight:700,color:'var(--green)',marginBottom:6}}>📉 New Put Wing</div>
                    <div className="form-grid-2" style={{gap:8}}>
                      <div className="form-group" style={{margin:0}}>
                        <label className="form-label" style={{fontSize:11}}>{isIB?'ATM body (sell strike) *':'Sell put strike *'}</label>
                        <input type="number" step="0.5" value={putSellStrike} onChange={e=>setPutSellStrike(e.target.value)} placeholder="e.g. 625"
                          style={putSellStrike&&putBuyStrike&&parseFloat(putSellStrike)<=parseFloat(putBuyStrike)?{borderColor:'var(--red)'}:{}}/>
                        {putSellStrike&&!isIB&&<div style={{fontSize:10,color:'var(--text-muted)',marginTop:2}}>must be above buy strike</div>}
                        {putSellStrike&&isIB&&<div style={{fontSize:10,color:'var(--blue,#2b6cb0)',marginTop:2}}>call sell strike will match automatically</div>}
                      </div>
                      <div className="form-group" style={{margin:0}}>
                        <label className="form-label" style={{fontSize:11}}>Buy put strike *</label>
                        <input type="number" step="0.5" value={putBuyStrike} onChange={e=>setPutBuyStrike(e.target.value)} placeholder="e.g. 615"
                          style={putSellStrike&&putBuyStrike&&parseFloat(putSellStrike)<=parseFloat(putBuyStrike)?{borderColor:'var(--red)'}:{}}/>
                        {putBuyStrike&&<div style={{fontSize:10,color:'var(--text-muted)',marginTop:2}}>must be below sell strike</div>}
                      </div>
                    </div>
                    <div className="form-group" style={{marginTop:8}}>
                      <label className="form-label" style={{fontSize:11}}>Put wing credit *</label>
                      <input type="number" step="0.01" value={putPremium} onChange={e=>setPutPremium(e.target.value)} placeholder="e.g. 1.40"/>
                    </div>
                  </div>
                  <div>
                    <div style={{fontSize:11,fontWeight:700,color:'var(--red)',marginBottom:6}}>📈 New Call Wing</div>
                    <div className="form-grid-2" style={{gap:8}}>
                      <div className="form-group" style={{margin:0}}>
                        <label className="form-label" style={{fontSize:11}}>Sell call strike *{isIB&&<span style={{color:'var(--text-muted)',fontWeight:400}}> (locked — ATM body)</span>}</label>
                        <input type="number" step="0.5"
                          value={isIB ? putSellStrike : callSellStrike}
                          onChange={e=>{ if(!isIB) setCallSellStrike(e.target.value); }}
                          readOnly={isIB}
                          placeholder="e.g. 675"
                          style={isIB
                            ? {background:'var(--bg-hover)',color:'var(--text-muted)',cursor:'not-allowed'}
                            : callSellStrike&&callBuyStrike&&parseFloat(callSellStrike)>=parseFloat(callBuyStrike)?{borderColor:'var(--red)'}
                            : callSellStrike&&putSellStrike&&parseFloat(callSellStrike)<=parseFloat(putSellStrike)?{borderColor:'var(--amber,#b7860a)'}
                            : {}}/>
                        {!isIB&&callSellStrike&&<div style={{fontSize:10,color:'var(--text-muted)',marginTop:2}}>must be above put sell strike</div>}
                        {isIB&&putSellStrike&&<div style={{fontSize:10,color:'var(--text-muted)',marginTop:2}}>auto-set from put wing ATM body</div>}
                        {isIB&&putSellStrike&&callSellStrike&&parseFloat(putSellStrike)!==parseFloat(callSellStrike)&&(
                          <div style={{fontSize:10,color:'var(--red)',marginTop:2}}>⚠ Must match put sell strike (${putSellStrike})</div>
                        )}
                      </div>
                      <div className="form-group" style={{margin:0}}>
                        <label className="form-label" style={{fontSize:11}}>Buy call strike *</label>
                        <input type="number" step="0.5" value={callBuyStrike} onChange={e=>setCallBuyStrike(e.target.value)} placeholder="e.g. 685"
                          style={callSellStrike&&callBuyStrike&&parseFloat(callSellStrike)>=parseFloat(callBuyStrike)?{borderColor:'var(--red)'}:{}}/>
                        {callBuyStrike&&<div style={{fontSize:10,color:'var(--text-muted)',marginTop:2}}>must be above sell strike</div>}
                      </div>
                    </div>
                    <div className="form-group" style={{marginTop:8}}>
                      <label className="form-label" style={{fontSize:11}}>Call wing credit *</label>
                      <input type="number" step="0.01" value={callPremium} onChange={e=>setCallPremium(e.target.value)} placeholder="e.g. 1.40"/>
                    </div>
                  </div>
                </div>
                {/* IB: show ATM body + wing widths. IC: show profit zone range */}
                {isIB&&putSellStrike&&putBuyStrike&&callBuyStrike&&putPremium&&callPremium&&(
                  <div style={{fontSize:11,background:'var(--green-bg)',border:'1px solid var(--green-border,#b7e3c0)',borderRadius:6,padding:'6px 10px',marginTop:8}}>
                    ATM body: ${putSellStrike} · Put wing: ${putSellStrike}/${putBuyStrike} · Call wing: ${putSellStrike}/${callBuyStrike} · Total credit: ${(parseFloat(putPremium||0)+parseFloat(callPremium||0)).toFixed(2)}/share
                  </div>
                )}
                {!isIB&&putSellStrike&&callSellStrike&&putPremium&&callPremium&&(
                  <div style={{fontSize:11,background:'var(--green-bg)',border:'1px solid var(--green-border,#b7e3c0)',borderRadius:6,padding:'6px 10px',marginTop:8}}>
                    New profit zone: ${putSellStrike} – ${callSellStrike} · Total credit: ${(parseFloat(putPremium||0)+parseFloat(callPremium||0)).toFixed(2)}/share
                  </div>
                )}
                {pnlPreview?.netAdj!=null&&(parseFloat(closePutPrice)||0)>0&&(parseFloat(closeCallPrice)||0)>0&&(
                  <div style={{marginTop:8}}><PnlBadge label="Net this adjustment" value={pnlPreview.netAdj} size={14}/></div>
                )}
              </>
            )}

            {/* Single-leg close */}
            {!['close_position','reduce_position','roll_full','reduce_one'].includes(adjType)&&(
              <div className="form-group">
                <label className="form-label">Buy-back price (per contract) *</label>
                <input type="number" step="0.01" value={closePrice} onChange={e=>setClosePrice(e.target.value)} placeholder="e.g. 1.80"/>
              </div>
            )}

            {/* reduce_one — contracts + price side by side with live validation */}
            {adjType==='reduce_one'&&(
              <div style={{marginTop:8}}>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
                  <div className="form-group" style={{margin:0}}>
                    <label className="form-label" style={{fontSize:11}}>
                      Contracts to close * <span style={{color:'var(--text-muted)',fontWeight:400}}>(max {Math.max(1,maxContracts-1)})</span>
                    </label>
                    <input type="number" min="1" max={maxContracts-1} step="1"
                      value={contractsToClose} onChange={e=>setContractsToClose(e.target.value)}
                      placeholder="e.g. 1"
                      style={contractsToClose&&(parseInt(contractsToClose)<1||parseInt(contractsToClose)>=maxContracts)?{borderColor:'var(--red)'}:{}}/>
                    {contractsToClose&&parseInt(contractsToClose)<1&&(
                      <div style={{fontSize:11,color:'var(--red)',marginTop:3}}>Must close at least 1 contract.</div>
                    )}
                    {contractsToClose&&parseInt(contractsToClose)>=maxContracts&&(
                      <div style={{fontSize:11,color:'var(--red)',marginTop:3}}>Must leave at least 1 open — use Close one leg to close all.</div>
                    )}
                  </div>
                  <div className="form-group" style={{margin:0}}>
                    <label className="form-label" style={{fontSize:11}}>Buy-back price * <span style={{color:'var(--text-muted)',fontWeight:400}}>($/contract)</span></label>
                    <input type="number" step="0.01" value={closePrice} onChange={e=>setClosePrice(e.target.value)} placeholder="e.g. 1.80"/>
                  </div>
                </div>
                {contractsToClose&&closePrice&&parseInt(contractsToClose)>=1&&parseInt(contractsToClose)<maxContracts&&(
                  <div style={{marginTop:6}}>
                    <PnlBadge label="Partial close P&L" value={(((leg==='put'?openPutLeg:openCallLeg)?.entry_price||0)-parseFloat(closePrice))*(parseInt(contractsToClose)||0)*100} size={12}/>
                  </div>
                )}
              </div>
            )}

            {goldenRuleViolation&&(
              <div className="alert alert-amber" style={{marginTop:8,fontSize:12}}>⚠ Golden rule: {goldenRuleViolation}</div>
            )}

            {selected.needsNewLeg&&adjType!=='roll_full'&&(
              <>
                <div className="modal-section-title">{newLegSectionLabel}</div>
                {/* IB: sell strike (ATM body) is locked — cannot change on a roll.
                     Changing the body turns the IB into a condor. Only buy strike
                     (wing width) and expiry can be adjusted to collect net credit. */}
                {isIB&&(
                  <div style={{background:'var(--blue-bg,#e8f4fd)',border:'1px solid var(--blue-border,#bee3f8)',
                    borderRadius:6,padding:'8px 12px',marginBottom:10,fontSize:12,color:'var(--blue,#2b6cb0)'}}>
                    ℹ️ <strong>Iron Butterfly:</strong> the ATM body (sell strike) must stay fixed — it defines the tent centre.
                    You can widen or narrow the wing (buy strike) and choose a new expiry to collect net credit.
                  </div>
                )}
                <div className="form-grid-2">
                  <div className="form-group">
                    <label className="form-label">New sell strike {isIB&&<span style={{color:'var(--text-muted)',fontWeight:400,fontSize:11}}>(locked — ATM body)</span>}</label>
                    <input type="number" step="0.5"
                      value={isIB?(leg==='put'?openPutLeg?.strike_sell:openCallLeg?.strike_sell)||newStrikeSell:newStrikeSell}
                      onChange={e=>{ if(!isIB) setNewStrikeSell(e.target.value); }}
                      readOnly={isIB}
                      placeholder="e.g. 428"
                      style={isIB?{background:'var(--bg-hover)',color:'var(--text-muted)',cursor:'not-allowed'}:{}}/>
                    {isIB&&<div style={{fontSize:10,color:'var(--text-muted)',marginTop:2}}>Auto-set to original ATM body — cannot change</div>}
                    {!isIB&&occStrikeWarn(newStrikeSell,openPutLeg?.strike_sell||trade.strike_sell)&&<div style={{fontSize:10,color:'var(--amber)',marginTop:3}}>⚠ {occStrikeWarn(newStrikeSell,openPutLeg?.strike_sell||trade.strike_sell)}</div>}
                  </div>
                  <div className="form-group">
                    <label className="form-label">New buy strike {isIB&&<span style={{color:'var(--text-muted)',fontWeight:400,fontSize:11}}>(wing width)</span>}</label>
                    <input type="number" step="0.5" value={newStrikeBuy} onChange={e=>setNewStrikeBuy(e.target.value)} placeholder="e.g. 423"/>
                    {isIB&&newStrikeBuy&&openPutLeg?.strike_sell&&(
                      <div style={{fontSize:10,color:'var(--text-muted)',marginTop:2}}>
                        Wing width: ${Math.abs(parseFloat(newStrikeBuy||0)-(parseFloat(leg==='put'?openPutLeg?.strike_sell:openCallLeg?.strike_sell)||0)).toFixed(1)} pts
                      </div>
                    )}
                  </div>
                  <div className="form-group">
                    <label className="form-label">New expiration</label>
                    <ExpiryDatePicker value={newExpiry} onChange={setNewExpiry} min={historicalMode ? undefined : localDateISO()}/>
                  </div>
                  <div className="form-group">
                    <label className="form-label">New premium collected</label>
                    <input type="number" step="0.01" value={newPremium} onChange={e=>setNewPremium(e.target.value)} placeholder="1.10"/>
                  </div>
                </div>
                {pnlPreview?.netAdj!=null&&closePrice&&<PnlBadge label="Net this adjustment" value={pnlPreview.netAdj} size={14}/>}
              </>
            )}

            {selected.needsResize&&(
              <div className="form-group">
                <label className="form-label">New number of contracts <span style={{color:'var(--text-muted)',fontSize:11}}>(must be 1 – {maxContracts-1})</span></label>
                <input type="number" min="1" max={maxContracts-1} value={newContracts} onChange={e=>setNewContracts(e.target.value)} placeholder="e.g. 1"
                  style={{borderColor:newContracts!==''&&(parseInt(newContracts)<1||parseInt(newContracts)>=maxContracts)?'var(--red,#c0392b)':undefined}}/>
                {newContracts!==''&&parseInt(newContracts)<=0&&(
                  <div style={{fontSize:11,color:'var(--red)',marginTop:3}}>Must reopen at least 1 contract.</div>
                )}
                {newContracts!==''&&parseInt(newContracts)>=maxContracts&&(
                  <div style={{fontSize:11,color:'var(--red)',marginTop:3}}>Must be fewer than current {maxContracts} contracts — this is Roll + Reduce, not a full roll. Use Roll one leg to keep the same size.</div>
                )}
              </div>
            )}

            {!['close_position','reduce_position','roll_full','reduce_one'].includes(adjType)&&closePrice&&!selected.needsNewLeg&&(
              <div style={{marginTop:8}}><PnlBadge label="P&L this leg" value={pnlPreview?.closePnl} size={14}/></div>
            )}

            <div className="form-group" style={{marginTop:12}}>
              <label className="form-label">Notes (optional)</label>
              <input type="text" value={notes} onChange={e=>setNotes(e.target.value)} placeholder="e.g. Took profit at 50% max"/>
            </div>

            {error&&<div className="alert alert-red" style={{marginTop:8}}>{error}</div>}
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={()=>{setStep(1);setError('');}}>← Back</button>
              <button className="btn btn-primary" onClick={()=>{if(validate()){setError('');setStep(3);}}}>Review →</button>
            </div>
          </div>
        )}

        {/* STEP 3 — Confirm */}
        {step===3&&selected&&(
          <div style={{overflowY:'auto',flex:1,minHeight:0,paddingBottom:8}}>
            <div className="modal-section-title">Confirm adjustment</div>
            <div style={{background:'var(--bg)',borderRadius:'var(--radius-md)',border:'1px solid var(--border)',padding:'14px 16px',marginBottom:14}}>
              <div style={{fontWeight:700,fontSize:14,marginBottom:10}}>{selected.icon} {selected.label}</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'8px 16px',fontSize:13}}>
                <div><span style={{color:'var(--text-muted)'}}>Ticker:</span> <strong>{trade.ticker}</strong></div>
                <div><span style={{color:'var(--text-muted)'}}>Strategy:</span> <strong>{trade.strategy}</strong></div>

                {adjType==='close_position'&&(<>
                  {openPutLeg&&<div><span style={{color:'var(--text-muted)'}}>Put buy-back:</span> <strong style={{color:'var(--red)'}}>{fmt(parseFloat(closePutPrice))}/sh</strong></div>}
                  {openCallLeg&&<div><span style={{color:'var(--text-muted)'}}>Call buy-back:</span> <strong style={{color:'var(--red)'}}>{fmt(parseFloat(closeCallPrice))}/sh</strong></div>}
                  {pnlPreview?.putPnl!=null&&<div><span style={{color:'var(--text-muted)'}}>Put leg P&L:</span> <strong style={{color:pnlPreview.putPnl>=0?'var(--green)':'var(--red)'}}>{fmtPnl(pnlPreview.putPnl)}</strong></div>}
                  {pnlPreview?.callPnl!=null&&<div><span style={{color:'var(--text-muted)'}}>Call leg P&L:</span> <strong style={{color:pnlPreview.callPnl>=0?'var(--green)':'var(--red)'}}>{fmtPnl(pnlPreview.callPnl)}</strong></div>}
                  <div style={{gridColumn:'1/-1'}}><PnlBadge label="Total P&L this adjustment" value={pnlPreview?.total} size={16}/></div>
                </>)}

                {adjType==='reduce_position'&&(<>
                  {openPutLeg&&<div><span style={{color:'var(--text-muted)'}}>Put: close {putContractsToClose}c @ {fmt(parseFloat(closePutPrice))}/sh</span></div>}
                  {openCallLeg&&<div><span style={{color:'var(--text-muted)'}}>Call: close {callContractsToClose}c @ {fmt(parseFloat(closeCallPrice))}/sh</span></div>}
                  {pnlPreview?.putPnl!=null&&<div><span style={{color:'var(--text-muted)'}}>Put P&L:</span> <strong style={{color:pnlPreview.putPnl>=0?'var(--green)':'var(--red)'}}>{fmtPnl(pnlPreview.putPnl)}</strong></div>}
                  {pnlPreview?.callPnl!=null&&<div><span style={{color:'var(--text-muted)'}}>Call P&L:</span> <strong style={{color:pnlPreview.callPnl>=0?'var(--green)':'var(--red)'}}>{fmtPnl(pnlPreview.callPnl)}</strong></div>}
                  <div style={{gridColumn:'1/-1'}}><PnlBadge label="Total P&L this reduction" value={pnlPreview?.total} size={16}/></div>
                </>)}

                {adjType==='roll_full'&&(<>
                  <div><span style={{color:'var(--text-muted)'}}>Put close:</span> <strong style={{color:'var(--red)'}}>{fmt(parseFloat(closePutPrice))}/sh</strong></div>
                  <div><span style={{color:'var(--text-muted)'}}>Call close:</span> <strong style={{color:'var(--red)'}}>{fmt(parseFloat(closeCallPrice))}/sh</strong></div>
                  <div><span style={{color:'var(--text-muted)'}}>New put wing:</span> <strong>${putSellStrike}/{putBuyStrike} · {fmt(parseFloat(putPremium))}/sh</strong></div>
                  <div><span style={{color:'var(--text-muted)'}}>New call wing:</span> <strong>${callSellStrike}/{callBuyStrike} · {fmt(parseFloat(callPremium))}/sh</strong></div>
                  <div><span style={{color:'var(--text-muted)'}}>New expiry:</span> <strong>{newExpiry}</strong></div>
                  <div><span style={{color:'var(--text-muted)'}}>New profit zone:</span> <strong>${putSellStrike} – ${callSellStrike}</strong></div>
                  <div style={{gridColumn:'1/-1'}}><PnlBadge label="Net this adjustment" value={pnlPreview?.netAdj} size={14}/></div>
                </>)}

                {!['close_position','reduce_position','roll_full','reduce_one'].includes(adjType)&&(<>
                  <div><span style={{color:'var(--text-muted)'}}>Leg:</span> <strong style={{textTransform:'capitalize'}}>{selected.needsLeg?leg:'both'} spread</strong></div>
                  <div><span style={{color:'var(--text-muted)'}}>Buy-back cost:</span> <strong style={{color:'var(--red)'}}>{fmt(parseFloat(closePrice)*(selected.isPartial?parseInt(contractsToClose)||1:maxContracts)*100*-1)}</strong></div>
                  {selected.needsNewLeg&&<div><span style={{color:'var(--text-muted)'}}>New credit:</span> <strong style={{color:'var(--green)'}}>{fmt(parseFloat(newPremium)*(parseInt(newContracts)||maxContracts)*100)}</strong></div>}
                  <div><span style={{color:'var(--text-muted)'}}>Net this adj:</span> <strong style={{color:(pnlPreview?.netAdj||0)>=0?'var(--green)':'var(--red)'}}>{fmtPnl(pnlPreview?.netAdj)}</strong></div>
                  {selected.needsNewLeg&&<><div><span style={{color:'var(--text-muted)'}}>New expiry:</span> <strong>{newExpiry}</strong></div><div><span style={{color:'var(--text-muted)'}}>New strikes:</span> <strong>{isIB?(leg==='put'?openPutLeg?.strike_sell:openCallLeg?.strike_sell)||newStrikeSell||'—':newStrikeSell||'—'}/{newStrikeBuy||'—'}</strong></div></>}
                </>)}

                <div style={{gridColumn:'1/-1'}}>
                  <span style={{color:'var(--text-muted)',fontSize:12}}>Running chain P&L after: </span>
                  <strong style={{color:(chainPnL+(pnlPreview?.total??pnlPreview?.netAdj??0))>=0?'var(--green)':'var(--red)'}}>
                    {fmtPnl(chainPnL+(pnlPreview?.total??pnlPreview?.netAdj??0))}
                  </strong>
                </div>
              </div>
              {notes&&<div style={{marginTop:10,fontSize:12,color:'var(--text-secondary)'}}>Notes: {notes}</div>}
            </div>
            <div className="alert alert-blue" style={{marginBottom:14,fontSize:12.5}}>
              The chain will remain alive as long as any contracts are still open. Final P&L locks only when all legs reach zero open contracts.
            </div>
            {goldenRuleViolation&&<div className="alert alert-amber" style={{marginBottom:8,fontSize:12}}>⚠ Golden rule: {goldenRuleViolation}</div>}
            {error&&<div className="alert alert-red" style={{marginTop:8}}>{error}</div>}
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={()=>{setStep(2);setError('');}}>← Back</button>
              <button className="btn btn-primary" onClick={submit} disabled={saving}>{saving?'Saving...':'Confirm Adjustment'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
