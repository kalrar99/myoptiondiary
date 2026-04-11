// src/components/CalAdjustModal.jsx
// Calendar Spread & Diagonal Spread Adjustment Modal — 3-step wizard
// SESSION 112 FIXES:
//   CAL-D1: Tile list filters out invalid adjustments based on open leg state
//   CAL-D2: roll_short / roll_front_out hidden when no open short leg
//   CAL-D3: convert_diagonal hidden when no open long leg
//   CAL-D4: close_both adapts to partial chain (show only open legs)
//   CAL-D5: Hard stop — short expiry after long expiry blocked in validate()
//   CAL-D6: "Short expired, long only" advisory when short closed but long open
//   CAL-D7: Diagonal Spread support — shared modal, strategy-aware header
//   CAL-D8: Two extra adjustment types for Diagonal: convert_to_calendar, widen_diagonal
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

// All possible adjustment types — filtered per chain state in Step 1
const ALL_ADJUSTMENT_TYPES = [
  { id:'roll_short_leg',      label:'Roll short leg',           icon:'↩',  strategies:['Calendar Spread','Diagonal Spread'],
    desc:'Close the current short leg and re-sell at a new strike, new expiry, or both. Leave either field unchanged to roll only one dimension. Expiry must stay before the long anchor.',
    needsShort:true,  needsLong:false },
  { id:'roll_long_out',       label:'Roll long leg out',         icon:'⟳↑', strategies:['Calendar Spread','Diagonal Spread'],
    desc:'Close the current back month long leg and buy a new one further out in time at the same strike. Used when the long anchor is approaching 45 DTE and needs to be extended.',
    needsShort:false, needsLong:true },
  { id:'convert_diagonal',    label:'Convert to diagonal',      icon:'↗',  strategies:['Calendar Spread'],
    desc:'Roll the long (back month) leg to a different strike or expiry, transforming the calendar into a diagonal. Used when you want directional bias or better IV management.',
    needsShort:false, needsLong:true },
  { id:'convert_to_calendar', label:'Convert back to calendar', icon:'↔',  strategies:['Diagonal Spread'],
    desc:'Align the strikes of both legs to convert this diagonal back into a pure calendar spread. Choose whether to move the short leg (to the long strike) or the long leg (to the short strike).',
    needsShort:false, needsLong:false },
  { id:'close_one_leg',       label:'Close one leg',            icon:'✓',  strategies:['Calendar Spread','Diagonal Spread'],
    desc:'Close either the short leg (keep long anchor open) or the long leg (keep short running). Use to take partial profits or remove one side of the spread.',
    needsShort:false, needsLong:false },
  { id:'close_both',          label:'Close Position',           icon:'✕',  strategies:['Calendar Spread','Diagonal Spread'],
    desc:'Close all remaining open legs — at profit target, stop-loss, or ahead of a catalyst. Shows only legs that are still open.',
    needsShort:false, needsLong:false, isFullClose:true },
  { id:'reduce_position',     label:'Reduce Position',          icon:'⇊',  strategies:['Calendar Spread','Diagonal Spread'],
    desc:'Close some (not all) contracts on both legs. Locks in partial profit while keeping remaining contracts running.',
    needsShort:false, needsLong:false, isFullClose:false, isReducePosition:true },
];

const fmt    = n => n==null ? '—' : '$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtPnl = n => { if(n==null) return '—'; return (n>=0?'+':'')+fmt(n); };

const PnlBadge = ({ label, value, size=13 }) => value==null ? null : (
  <div style={{padding:'6px 10px',borderRadius:6,background:value>=0?'var(--green-bg)':'var(--red-bg)',border:`1px solid ${value>=0?'var(--green-border,#b7e3c0)':'var(--red-border,#f5c6cb)'}`}}>
    {label&&<div style={{fontSize:10,color:'var(--text-muted)',marginBottom:2}}>{label}</div>}
    <div style={{fontFamily:'var(--font-mono)',fontWeight:700,fontSize:size,color:value>=0?'var(--green)':'var(--red)'}}>{fmtPnl(value)}</div>
  </div>
);

export default function CalAdjustModal({ trade, chainTrades, onAdjust, historicalMode, onClose }) {
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
      const rect=modalRef.current?.getBoundingClientRect(); const w=rect?.width||540;
      setPos({x:Math.max(-w+80,Math.min(window.innerWidth-80,e.clientX-dragOffset.current.x)),y:Math.max(0,Math.min(window.innerHeight-80,e.clientY-dragOffset.current.y))});
    };
    const onUp=()=>setDragging(false);
    document.addEventListener('mousemove',onMove); document.addEventListener('mouseup',onUp);
    return()=>{document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);};
  },[dragging]);

  const [step,setStep]=useState(1);
  const [adjType,setAdjType]=useState(null);
  const [closeShortPx,setCloseShortPx]=useState('');
  const [closeLongPx,setCloseLongPx]=useState('');
  const [reduceShortN,setReduceShortN]=useState('');
  const [reduceLongN,setReduceLongN]=useState('');
  const [reduceShortPx,setReduceShortPx]=useState('');
  const [reduceLongPx,setReduceLongPx]=useState('');
  const [reduceShortTick,setReduceShortTick]=useState(true);
  const [reduceLongTick,setReduceLongTick]=useState(true);
  const [newShortStrike,setNewShortStrike]=useState('');
  const [newShortExpiry,setNewShortExpiry]=useState('');
  const [newShortPrem,setNewShortPrem]=useState('');
  const [newLongStrike,setNewLongStrike]=useState('');
  const [newLongExpiry,setNewLongExpiry]=useState('');
  const [newLongPrem,setNewLongPrem]=useState('');
  const [adjNotes,setAdjNotes]=useState('');
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const [moveShortLeg,setMoveShortLeg]=useState(true); // convert_to_calendar: true=move short, false=move long
  const [closeShortSide,setCloseShortSide]=useState(true); // close_one_leg: true=close short, false=close long

  const strategy = trade.strategy || 'Calendar Spread';
  const selected = ALL_ADJUSTMENT_TYPES.find(t=>t.id===adjType);
  const chainId  = trade.cal_chain_id||trade.id;

  const shortLeg = useMemo(()=>chainTrades.filter(t=>t.cal_leg==='short'&&t.status==='open').sort((a,b)=>(b.cal_seq||0)-(a.cal_seq||0))[0]||null,[chainTrades]);
  const longLeg  = useMemo(()=>chainTrades.filter(t=>t.cal_leg==='long' &&t.status==='open').sort((a,b)=>(b.cal_seq||0)-(a.cal_seq||0))[0]||null,[chainTrades]);

  // For long expiry hard-stop validation
  const longExpiry = longLeg?.expiration_back || longLeg?.expiration || null;

  // "Short expired, long only" advisory
  const shortExpiredAdvisory = useMemo(()=>{
    if(shortLeg) return null;
    if(!longLeg) return null;
    const anyShortClosed = chainTrades.some(t=>t.cal_leg==='short'&&t.status==='closed');
    if(anyShortClosed) return 'Front month short has expired or was closed — only the long anchor remains open. You can sell a new short (Roll front month out) or close the long leg.';
    return null;
  },[shortLeg,longLeg,chainTrades]);

  // Filter adjustment types by strategy and chain state
  const ADJUSTMENT_TYPES = useMemo(()=>ALL_ADJUSTMENT_TYPES.filter(t=>{
    if(!t.strategies.includes(strategy)) return false;
    if(t.needsShort && !shortLeg) return false;
    if(t.needsLong  && !longLeg)  return false;
    // close_both always shows if at least one leg is open
    if(t.isFullClose && !shortLeg && !longLeg) return false;
    return true;
  }),[strategy,shortLeg,longLeg]);

  const realisedSoFar = useMemo(()=>chainTrades.reduce((s,t)=>s+(t.pnl||0)+(t.partial_close_pnl||0),0),[chainTrades]);

  // Live P&L preview
  const livePnl = useMemo(()=>{
    if(!adjType) return null;
    const csp=parseFloat(closeShortPx)||0;
    const clp=parseFloat(closeLongPx)||0;
    const nsp=parseFloat(newShortPrem)||0;
    const c = shortLeg?.contracts_open ?? shortLeg?.contracts ?? longLeg?.contracts_open ?? longLeg?.contracts ?? 1;

    if(adjType==='roll_short_leg'){
      const closingPnl=shortLeg&&csp>0?(shortLeg.entry_price-csp)*c*100:null;
      const netFromRoll=(nsp-csp)*c*100;
      return{closingPnl,netFromRoll,label:netFromRoll>=0?'Net credit from roll':'Net debit from roll'};
    }
    if(adjType==='convert_to_calendar'){
      if(moveShortLeg){
        // Move short: close short, re-sell at long's strike
        const closingPnl=shortLeg&&csp>0?(shortLeg.entry_price-csp)*c*100:null;
        const netFromRoll=(nsp-csp)*c*100;
        return{closingPnl,netFromRoll,label:netFromRoll>=0?'Net credit from conversion':'Net debit from conversion'};
      } else {
        // Move long: sell long, rebuy at short's strike
        const closingPnl=longLeg&&clp>0?(clp-longLeg.entry_price)*c*100:null;
        const newLongCost=(parseFloat(newLongPrem)||0)*c*100;
        const netCost=(clp>0&&parseFloat(newLongPrem)>0)?(newLongCost-(clp*c*100)):null;
        return{closingPnl,newLongCost,netCost,label:netCost!=null&&netCost<=0?'Net credit from conversion':'Net cost of conversion'};
      }
    }
    if(adjType==='roll_long_out'){
      const closingPnl=longLeg&&clp>0?(clp-longLeg.entry_price)*c*100:null;
      const newLongCost=(parseFloat(newLongPrem)||0)*c*100;
      const netCost=closingPnl!=null?closingPnl-newLongCost:null;
      return{closingPnl,newLongCost,netCost,label:netCost!=null&&netCost>=0?'Net credit from roll':'Net cost of roll'};
    }
    if(adjType==='convert_diagonal'){
      const closingPnl=longLeg&&clp>0?(clp-longLeg.entry_price)*c*100:null;
      const newLongCost=(parseFloat(newLongPrem)||0)*c*100;
      const netCost=(clp>0&&parseFloat(newLongPrem)>0)?(newLongCost-(clp*c*100)):null;
      return{closingPnl,newLongCost,netCost,label:netCost!=null&&netCost<=0?'Net credit from conversion':'Net cost of conversion'};
    }
    if(adjType==='close_one_leg'){
      if(closeShortSide){
        const pnl=shortLeg&&csp>0?(shortLeg.entry_price-csp)*c*100:null;
        return{shortClosePnl:pnl};
      } else {
        const pnl=longLeg&&clp>0?(clp-longLeg.entry_price)*c*100:null;
        return{longClosePnl:pnl};
      }
    }
    if(adjType==='close_both'){
      const shortPnl=shortLeg&&csp>=0?(shortLeg.entry_price-csp)*c*100:0;
      const longPnl =longLeg &&clp>=0?(clp-longLeg.entry_price)*c*100:0;
      return{shortClosePnl:shortLeg?shortPnl:null,longClosePnl:longLeg?longPnl:null,totalCampaignPnl:realisedSoFar+shortPnl+longPnl};
    }
    return null;
  },[adjType,closeShortPx,closeLongPx,newShortPrem,newLongPrem,shortLeg,longLeg,realisedSoFar]);

  // Golden rule for roll types
  const goldenRuleViolation = useMemo(()=>{
    if(adjType !== 'roll_short_leg' && !(adjType === 'convert_to_calendar' && moveShortLeg)) return null;
    const csp=parseFloat(closeShortPx)||0;
    const nsp=parseFloat(newShortPrem)||0;
    if(nsp>0&&nsp<csp) return `Net debit roll — new premium ($${nsp.toFixed(2)}) is less than buy-back ($${csp.toFixed(2)}). Only roll when collecting net credit.`;
    return null;
  },[adjType,closeShortPx,newShortPrem]);

  // Short-after-long expiry hard stop
  const expiryOrderError = useMemo(()=>{
    const isShortRoll = adjType==='roll_short_leg' || (adjType==='convert_to_calendar'&&moveShortLeg);
    if(!isShortRoll) return null;
    if(!newShortExpiry||!longExpiry) return null;
    // Prevent rolling to same or earlier expiry
    if(shortLeg?.expiration&&newShortExpiry<=shortLeg.expiration)
      return `New expiry (${newShortExpiry}) must be later than the current front month (${shortLeg.expiration}). Rolling out means moving to a later month.`;
    if(newShortExpiry>=longExpiry) return `Hard stop: new short expiry (${newShortExpiry}) is on or after your long anchor (${longExpiry}). Your short must always expire before your long — otherwise you have undefined risk with no hedge.`;
    return null;
  },[adjType,newShortExpiry,longExpiry,shortLeg,moveShortLeg]);

  // Fix 5 — Calendar amber warning: new short strike differs from long anchor (behaves as diagonal)
  const calendarStrikeWarn = useMemo(()=>{
    if(strategy !== 'Calendar Spread') return null;
    if(adjType !== 'roll_short_leg') return null;
    if(!newShortStrike || !longLeg) return null;
    const ns = parseFloat(newShortStrike);
    const ls = parseFloat(longLeg.strike_buy || longLeg.strike_sell) || 0;
    if(!ns || !ls || ns === ls) return null;
    return `New strike ($${ns}) differs from the long anchor ($${ls}) — this position now behaves as a diagonal. Use Convert to Diagonal to formally reclassify if needed.`;
  },[adjType,newShortStrike,longLeg,strategy]);

  // Fix 1 — Diagonal hard stop: short strike must not cross the long strike
  const diagonalStrikeError = useMemo(()=>{
    if(strategy !== 'Diagonal Spread') return null;
    if(adjType !== 'roll_short_leg') return null;
    if(!newShortStrike || !longLeg) return null;
    const ns = parseFloat(newShortStrike);
    const ls = parseFloat(longLeg.strike_buy || longLeg.strike_sell) || 0;
    if(!ns || !ls) return null;
    // option_type tracked on the trade record — used by fetch layer, not needed here
    // const isCall = longLeg.option_type !== 'put';
    // Both call and put diagonals: short leg is always BELOW the long leg strike.
    // Call: short call < long call (e.g. short $105C, long $110C)
    // Put:  short put  < long put  (e.g. short $95P,  long $100P)
    // Block in both cases if new short >= long strike (would cross or equal the long)
    if(ns >= ls) return `Hard stop: new short strike ($${ns}) must be below the long strike ($${ls}) — short leg must always be further OTM than the long anchor.`;
    return null;
  },[adjType,newShortStrike,longLeg,strategy]);

  function validate(){
    if(!adjType){setError('Please select an adjustment type.');return false;}
    if(adjType==='roll_short_leg'){
      if(!shortLeg){setError('No open short leg found on this chain.');return false;}
      if(!closeShortPx){setError('Enter the buy-back price for the current short leg.');return false;}
      if(!newShortPrem){setError('Enter the premium for the new short leg.');return false;}
      // Must change at least strike OR expiry
      const strikeChanged = newShortStrike && parseFloat(newShortStrike) !== parseFloat(shortLeg.strike_sell);
      const expiryChanged = newShortExpiry && newShortExpiry !== shortLeg.expiration;
      if(!strikeChanged && !expiryChanged){
        setError('Enter a new strike and/or a new expiry — at least one must change for this to be a roll.');return false;
      }
      if(expiryOrderError){setError(expiryOrderError);return false;}
      if(diagonalStrikeError){setError(diagonalStrikeError);return false;}
    }
    if(adjType==='convert_to_calendar'){
      if(moveShortLeg){
        if(!shortLeg){setError('No open short leg found on this chain.');return false;}
        if(!closeShortPx){setError('Enter the buy-back price for the short leg.');return false;}
        if(!newShortExpiry){setError('Enter the new expiry for the short leg.');return false;}
        if(expiryOrderError){setError(expiryOrderError);return false;}
        if(!newShortPrem){setError('Enter the premium for the new short leg.');return false;}
      } else {
        if(!longLeg){setError('No open long leg found on this chain.');return false;}
        if(!closeLongPx){setError('Enter the sell price for the current long leg.');return false;}
        if(!newLongExpiry){setError('Enter the new back month expiry.');return false;}
        if(!newLongPrem){setError('Enter the premium for the new long leg.');return false;}
        const curLongExpiry = longLeg.expiration_back || longLeg.expiration;
        if(curLongExpiry && newLongExpiry <= curLongExpiry){setError(`New long expiry (${newLongExpiry}) must be later than current (${curLongExpiry}).`);return false;}
        if(shortLeg?.expiration && newLongExpiry <= shortLeg.expiration){setError(`Hard stop: new long expiry (${newLongExpiry}) must be after the short leg (${shortLeg.expiration}).`);return false;}
      }
    }
    if(adjType==='roll_long_out'){
      if(!longLeg){setError('No open long leg found on this chain.');return false;}
      if(!closeLongPx){setError('Enter the price to sell the current long leg.');return false;}
      if(!newLongExpiry){setError('Enter the new back month expiry date.');return false;}
      if(!newLongPrem){setError('Enter the premium for the new long leg.');return false;}
      const curLongExpiry = longLeg.expiration_back || longLeg.expiration;
      if(curLongExpiry && newLongExpiry <= curLongExpiry)
        {setError(`New back month expiry (${newLongExpiry}) must be later than the current long expiry (${curLongExpiry}).`);return false;}
      if(shortLeg?.expiration && newLongExpiry <= shortLeg.expiration)
        {setError(`Hard stop: new long expiry (${newLongExpiry}) must be after the short leg (${shortLeg.expiration}).`);return false;}
    }
    if(adjType==='convert_diagonal'){
      if(!longLeg){setError('No open long leg found on this chain.');return false;}
      if(!closeLongPx){setError('Enter the price to close the current long leg.');return false;}
      if(!newLongExpiry){setError('Enter the new long expiry date.');return false;}
      if(!newLongPrem){setError('Enter the premium for the new long leg.');return false;}
      // L: new long must expire AFTER remaining short leg
      if(shortLeg?.expiration&&newLongExpiry<=shortLeg.expiration){
        setError(`Hard stop: new long expiry (${newLongExpiry}) must be after the short leg (${shortLeg.expiration}). Long must always outlive the short.`);
        return false;
      }
      // M: warn if new long strike matches short leg strike (still a Calendar, not a Diagonal)
      if(newLongStrike&&shortLeg?.strike_sell&&parseFloat(newLongStrike)===parseFloat(shortLeg.strike_sell)){
        setError(`New long strike ($${newLongStrike}) matches the short leg strike ($${shortLeg.strike_sell}) — this remains a Calendar. Enter a different strike to create a true diagonal.`);
        return false;
      }
    }
    if(adjType==='close_one_leg'){
      if(closeShortSide){
        if(!shortLeg){setError('No open short leg found on this chain.');return false;}
        if(!closeShortPx){setError('Enter the buy-back price for the short leg.');return false;}
      } else {
        if(!longLeg){setError('No open long leg found on this chain.');return false;}
        if(!closeLongPx){setError('Enter the sell price for the long leg.');return false;}
      }
    }
    if(adjType==='close_both'){
      if(shortLeg&&!closeShortPx){setError('Enter the price to close the short leg.');return false;}
      if(longLeg &&!closeLongPx){setError('Enter the price to close the long leg.');return false;}
    }
    if(adjType==='reduce_position'){
      if(!reduceShortTick&&!reduceLongTick){setError('Select at least one leg to reduce.');return false;}
      const sn=parseInt(reduceShortN)||0, ln=parseInt(reduceLongN)||0;
      if(reduceShortTick&&shortLeg){
        if(sn<=0){setError('Enter contracts to reduce on short leg (must be ≥ 1).');return false;}
        if(sn>=(shortLeg.contracts_open||shortLeg.contracts||1)){setError(`Short leg has ${shortLeg.contracts_open||shortLeg.contracts} contracts — reduce must leave at least 1 open.`);return false;}
        if(!reduceShortPx){setError('Enter the close price for the short leg.');return false;}
      }
      if(reduceLongTick&&longLeg){
        if(ln<=0){setError('Enter contracts to reduce on long leg (must be ≥ 1).');return false;}
        if(ln>=(longLeg.contracts_open||longLeg.contracts||1)){setError(`Long leg has ${longLeg.contracts_open||longLeg.contracts} contracts — reduce must leave at least 1 open.`);return false;}
        if(!reduceLongPx){setError('Enter the close price for the long leg.');return false;}
        if(!reduceShortTick){setError('');} // clear error — long-only is valid with warning
      }
    }
    return true;
  }

  async function submit(){
    if(!validate())return;
    setSaving(true);setError('');
    try{
      await onAdjust({
        chain_id:chainId, adjustment_type:adjType,
        close_short_price:parseFloat(closeShortPx)||null,
        close_long_price:parseFloat(closeLongPx)||null,
        new_short_strike:parseFloat(newShortStrike)||null,
        new_short_expiry:adjType==='roll_short_leg' ? (newShortExpiry||shortLeg?.expiration||null) : (newShortExpiry||null),
        new_short_premium:parseFloat(newShortPrem)||null,
        new_long_strike:parseFloat(newLongStrike)||null,
        new_long_expiry:newLongExpiry||null,
        new_long_premium:parseFloat(newLongPrem)||null,
        // reduce_position fields
        reduce_short_contracts:reduceShortTick ? (parseInt(reduceShortN)||null) : null,
        reduce_long_contracts:reduceLongTick ? (parseInt(reduceLongN)||null) : null,
        reduce_short_price:reduceShortTick ? (parseFloat(reduceShortPx)||null) : null,
        reduce_long_price:reduceLongTick ? (parseFloat(reduceLongPx)||null) : null,
        move_leg:adjType==='convert_to_calendar'?(moveShortLeg?'short':'long'):null,
        close_side:adjType==='close_one_leg'?(closeShortSide?'short':'long'):null,
        notes:adjNotes||null,
        date:localDateISO(),
      });
      onClose();
    }catch(e){
      setError(e.message||'Adjustment failed.');
    }
    setSaving(false);
  }

  const modalBg={position:'fixed',top:0,left:0,right:0,bottom:0,background:'rgba(0,0,0,0.5)',zIndex:5000,display:'flex',alignItems:pos?'flex-start':'center',justifyContent:pos?'flex-start':'center'};
  const modalBox=pos
    ?{position:'fixed',top:pos.y,left:pos.x,margin:0,background:'var(--bg-card)',borderRadius:'var(--radius-lg)',border:'1px solid var(--border)',padding:'20px 24px',width:540,maxHeight:'90vh',overflowY:'auto',boxShadow:'0 8px 40px rgba(0,0,0,0.22)'}
    :{background:'var(--bg-card)',borderRadius:'var(--radius-lg)',border:'1px solid var(--border)',padding:'20px 24px',width:540,maxHeight:'90vh',overflowY:'auto',boxShadow:'0 8px 40px rgba(0,0,0,0.22)'};
  const rowSt   ={display:'flex',gap:12,marginBottom:12};
  const labelSt ={fontSize:12,fontWeight:600,color:'var(--text-secondary)',marginBottom:4};
  const inputSt ={width:'100%',padding:'6px 8px',fontSize:13,fontFamily:'var(--font-mono)',border:'1px solid var(--border)',borderRadius:6,background:'var(--bg)',color:'var(--text-primary)'};
  const sectionHd={fontSize:11,fontWeight:700,color:'var(--text-muted)',letterSpacing:'0.06em',textTransform:'uppercase',marginBottom:8,marginTop:16};

  return(
    <div style={modalBg} onClick={e=>!dragging&&e.target===e.currentTarget&&onClose()}>
      <div style={modalBox} ref={modalRef}>

        {/* Header */}
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:12,cursor:dragging?'grabbing':'grab',userSelect:'none'}} onMouseDown={onMouseDownHeader} title="Drag to move">
          <div>
            <div style={{fontWeight:800,fontSize:15}}>{trade.ticker} — {strategy} Adjustment</div>
            <div style={{fontSize:11,color:'var(--text-muted)',marginTop:2}}>
              {chainTrades.length} legs in chain · Realised so far:{' '}
              <span style={{color:realisedSoFar>=0?'var(--green)':'var(--red)',fontWeight:600}}>{fmtPnl(realisedSoFar)}</span>
            </div>
          </div>
          <button className="modal-close" onMouseDown={e=>e.stopPropagation()} onClick={onClose} style={{fontSize:16}}>✕</button>
        </div>

        {/* Step indicators */}
        <div style={{display:'flex',gap:4,marginBottom:14,paddingBottom:12,borderBottom:'1px solid var(--border)'}}>
          {['Choose type','Enter details','Confirm'].map((s,i)=>(
            <div key={i} style={{display:'flex',alignItems:'center',gap:6,fontSize:12,
              color:step===i+1?'var(--accent)':step>i+1?'var(--green)':'var(--text-muted)',fontWeight:step===i+1?700:400}}>
              <span style={{width:20,height:20,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,
                background:step===i+1?'var(--accent)':step>i+1?'var(--green)':'var(--border)',color:step>=i+1?'#fff':'var(--text-muted)'}}>{step>i+1?'✓':i+1}</span>
              {s}{i<2&&<span style={{color:'var(--border-strong)',marginLeft:4}}>→</span>}
            </div>
          ))}
        </div>

        {/* Short-expired advisory */}
        {shortExpiredAdvisory&&(
          <div style={{background:'var(--blue-bg,#e8f4fd)',border:'1px solid var(--blue-border,#bee3f8)',borderRadius:6,padding:'8px 12px',marginBottom:12,fontSize:12,color:'var(--blue,#2b6cb0)'}}>
            ℹ️ {shortExpiredAdvisory}
          </div>
        )}

        {/* Current open legs summary */}
        <div style={{background:'var(--bg-hover)',borderRadius:8,padding:'10px 12px',marginBottom:14,fontSize:12}}>
          <div style={{fontWeight:700,color:'var(--text-secondary)',marginBottom:6}}>Current Open Legs</div>
          {shortLeg
            ?<div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
              <span>📉 Short (front): <strong>${shortLeg.strike_sell} exp {shortLeg.expiration}</strong>
                <span style={{marginLeft:8,color:'var(--text-muted)',fontWeight:400}}>
                  {shortLeg.contracts_open ?? shortLeg.contracts ?? 1} of {shortLeg.contracts_original ?? shortLeg.contracts ?? 1} contracts open
                </span>
              </span>
              <span style={{fontFamily:'var(--font-mono)'}}>Entry ${shortLeg.entry_price?.toFixed(2)}</span>
            </div>
            :<div style={{color:'var(--text-muted)',marginBottom:3}}>No open short leg</div>}
          {longLeg
            ?<div style={{display:'flex',justifyContent:'space-between'}}>
              <span>📈 Long (back): <strong>${longLeg.strike_buy} exp {longLeg.expiration_back||longLeg.expiration}</strong>
                <span style={{marginLeft:8,color:'var(--text-muted)',fontWeight:400}}>
                  {longLeg.contracts_open ?? longLeg.contracts ?? 1} of {longLeg.contracts_original ?? longLeg.contracts ?? 1} contracts open
                </span>
              </span>
              <span style={{fontFamily:'var(--font-mono)'}}>Entry ${longLeg.entry_price?.toFixed(2)}</span>
            </div>
            :<div style={{color:'var(--text-muted)'}}>No open long leg</div>}
        </div>

        {/* STEP 1 — Choose type */}
        {step===1&&(
          <>
            <div style={sectionHd}>Select Adjustment Type</div>
            {ADJUSTMENT_TYPES.length===0&&(
              <div className="alert alert-blue">All legs are closed — no adjustments available.</div>
            )}
            {ADJUSTMENT_TYPES.map(t=>(
              <div key={t.id} onClick={()=>setAdjType(t.id)}
                style={{display:'flex',alignItems:'flex-start',gap:10,padding:'10px 12px',marginBottom:6,
                  border:adjType===t.id?'2px solid var(--accent)':'1px solid var(--border)',
                  background:adjType===t.id?'var(--accent-light)':'var(--bg-card)',
                  borderRadius:8,cursor:'pointer'}}>
                <span style={{fontSize:20,minWidth:28,textAlign:'center',color:adjType===t.id?'var(--accent)':'var(--text-muted)'}}>{t.icon}</span>
                <div>
                  <div style={{fontWeight:700,fontSize:13,color:adjType===t.id?'var(--accent)':'var(--text-primary)'}}>{t.label}</div>
                  <div style={{fontSize:11,color:'var(--text-secondary)',marginTop:2,lineHeight:1.5}}>{t.desc}</div>
                </div>
                {adjType===t.id&&<span style={{marginLeft:'auto',color:'var(--accent)',fontSize:16,flexShrink:0}}>✓</span>}
              </div>
            ))}
            {error&&<div style={{color:'var(--red)',fontSize:12,marginTop:8}}>{error}</div>}
            <div style={{display:'flex',justifyContent:'flex-end',marginTop:16,gap:8}}>
              <button className="btn btn-outline" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" onClick={()=>{if(!adjType){setError('Select an adjustment type.');return;}setError('');setStep(2);}}>Next →</button>
            </div>
          </>
        )}

        {/* STEP 2 — Detail inputs */}
        {step===2&&selected&&(
          <>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
              <span style={{fontSize:20}}>{selected.icon}</span>
              <span style={{fontWeight:700,fontSize:14,color:'var(--accent)'}}>{selected.label}</span>
            </div>

            {/* ── roll_short_leg — unified roll: change strike, expiry, or both ── */}
            {adjType==='roll_short_leg'&&shortLeg&&(<>
              <div style={sectionHd}>Close Current Short Leg
                <span style={{fontSize:11,fontWeight:400,color:'var(--text-muted)',marginLeft:8}}>
                  {shortLeg.contracts_open ?? shortLeg.contracts ?? 1} of {shortLeg.contracts_original ?? shortLeg.contracts ?? 1} contracts open
                </span>
              </div>
              <div style={rowSt}>
                <div style={{flex:1}}>
                  <div style={labelSt}>Buy back at ($) *</div>
                  <input style={inputSt} type="number" step="0.01" placeholder="e.g. 2.90" value={closeShortPx} onChange={e=>setCloseShortPx(e.target.value)}/>
                  <div style={{fontSize:10,color:'var(--text-muted)',marginTop:2}}>
                    Sold at ${shortLeg.entry_price?.toFixed(2)} · {(parseFloat(closeShortPx)||0)<shortLeg.entry_price?'profit ✓':'loss'}
                  </div>
                </div>
              </div>
              {goldenRuleViolation&&(
                <div style={{background:'var(--amber-bg,#fff8e1)',border:'1px solid var(--amber-border,#f0d898)',borderRadius:6,padding:'8px 12px',marginBottom:8,fontSize:12,color:'var(--amber,#92600a)'}}>
                  ⚠ Golden rule: {goldenRuleViolation}
                </div>
              )}
              <div style={sectionHd}>New Short Leg <span style={{fontSize:11,fontWeight:400,color:'var(--text-muted)',marginLeft:6}}>— change strike, expiry, or both</span></div>
              <div style={rowSt}>
                <div style={{flex:1}}>
                  <div style={labelSt}>New Strike (blank = keep ${shortLeg.strike_sell})</div>
                  <input style={{...inputSt,borderColor:diagonalStrikeError?'var(--red,#c0392b)':undefined}}
                    type="number" step="0.5" placeholder={String(shortLeg.strike_sell)}
                    value={newShortStrike} onChange={e=>setNewShortStrike(e.target.value)}/>
                  {diagonalStrikeError&&<div style={{fontSize:11,color:'var(--red,#c0392b)',fontWeight:600,marginTop:3}}>✕ {diagonalStrikeError}</div>}
                  {calendarStrikeWarn&&<div style={{fontSize:11,color:'var(--amber)',marginTop:3}}>⚠ {calendarStrikeWarn}</div>}
                </div>
                <div style={{flex:1}}>
                  <div style={labelSt}>New Expiry (blank = keep {shortLeg.expiration}){longExpiry&&<span style={{color:'var(--text-muted)'}}> · before {longExpiry}</span>}</div>
                  <ExpiryDatePicker value={newShortExpiry} onChange={setNewShortExpiry} min={historicalMode ? undefined : localDateISO()}/>
                  {expiryOrderError&&<div style={{fontSize:11,color:'var(--red,#c0392b)',fontWeight:600,marginTop:3,lineHeight:1.4}}>✕ {expiryOrderError}</div>}
                </div>
              </div>
              <div style={rowSt}>
                <div style={{flex:1}}>
                  <div style={labelSt}>Premium received ($) *</div>
                  <input style={inputSt} type="number" step="0.01" placeholder="e.g. 1.45" value={newShortPrem} onChange={e=>setNewShortPrem(e.target.value)}/>
                </div>
                <div style={{flex:1,display:'flex',alignItems:'center',paddingTop:18}}>
                  {livePnl?.netFromRoll!=null&&closeShortPx!==''&&newShortPrem!==''&&!expiryOrderError&&(
                    <div style={{padding:'6px 10px',background:livePnl.netFromRoll>=0?'var(--green-bg)':'var(--red-bg)',borderRadius:6,width:'100%'}}>
                      <div style={{fontSize:10,color:'var(--text-muted)'}}>{livePnl.label}</div>
                      <div style={{fontFamily:'var(--font-mono)',fontWeight:700,fontSize:14,color:livePnl.netFromRoll>=0?'var(--green)':'var(--red)'}}>{fmtPnl(livePnl.netFromRoll)}</div>
                    </div>
                  )}
                </div>
              </div>
            </>)}

            {/* ── convert_to_calendar — radio: move short or move long ── */}
            {adjType==='convert_to_calendar'&&(<>
              <div style={{marginBottom:12}}>
                <div style={labelSt}>Which leg to move?</div>
                <div style={{display:'flex',gap:16,marginTop:6}}>
                  <label style={{display:'flex',alignItems:'center',gap:6,cursor:'pointer',fontSize:13}}>
                    <input type="radio" checked={moveShortLeg} onChange={()=>setMoveShortLeg(true)} style={{cursor:'pointer'}}/>
                    Move <strong>short leg</strong> to long's strike ({longLeg?.strike_buy||'—'})
                  </label>
                  <label style={{display:'flex',alignItems:'center',gap:6,cursor:'pointer',fontSize:13}}>
                    <input type="radio" checked={!moveShortLeg} onChange={()=>setMoveShortLeg(false)} style={{cursor:'pointer'}}/>
                    Move <strong>long leg</strong> to short's strike ({shortLeg?.strike_sell||'—'})
                  </label>
                </div>
              </div>
              {moveShortLeg&&shortLeg&&(<>
                <div style={sectionHd}>Close Current Short Leg</div>
                <div style={rowSt}>
                  <div style={{flex:1}}>
                    <div style={labelSt}>Buy back at ($) *</div>
                    <input style={inputSt} type="number" step="0.01" placeholder="e.g. 2.90" value={closeShortPx} onChange={e=>setCloseShortPx(e.target.value)}/>
                    <div style={{fontSize:10,color:'var(--text-muted)',marginTop:2}}>Sold at ${shortLeg.entry_price?.toFixed(2)} · {(parseFloat(closeShortPx)||0)<shortLeg.entry_price?'profit ✓':'loss'}</div>
                  </div>
                </div>
                <div style={sectionHd}>New Short Leg — strike locked to long ({longLeg?.strike_buy})</div>
                <div style={rowSt}>
                  <div style={{flex:1}}>
                    <div style={labelSt}>Strike (locked — must match long anchor)</div>
                    <input style={{...inputSt,background:'var(--bg-hover)',color:'var(--text-muted)',cursor:'not-allowed'}}
                      value={longLeg?.strike_buy||''} readOnly/>
                  </div>
                  <div style={{flex:1}}>
                    <div style={labelSt}>New Expiry *{longExpiry&&<span style={{color:'var(--text-muted)'}}> · before {longExpiry}</span>}</div>
                    <ExpiryDatePicker value={newShortExpiry} onChange={setNewShortExpiry} min={historicalMode ? undefined : localDateISO()}/>
                    {expiryOrderError&&<div style={{fontSize:11,color:'var(--red)',fontWeight:600,marginTop:3}}>✕ {expiryOrderError}</div>}
                  </div>
                </div>
                <div style={rowSt}>
                  <div style={{flex:1}}>
                    <div style={labelSt}>Premium received ($) *</div>
                    <input style={inputSt} type="number" step="0.01" placeholder="e.g. 1.45" value={newShortPrem} onChange={e=>setNewShortPrem(e.target.value)}/>
                  </div>
                  <div style={{flex:1,display:'flex',alignItems:'center',paddingTop:18}}>
                    {livePnl?.netFromRoll!=null&&closeShortPx!==''&&newShortPrem!==''&&(
                      <div style={{padding:'6px 10px',background:livePnl.netFromRoll>=0?'var(--green-bg)':'var(--red-bg)',borderRadius:6,width:'100%'}}>
                        <div style={{fontSize:10,color:'var(--text-muted)'}}>{livePnl.label}</div>
                        <div style={{fontFamily:'var(--font-mono)',fontWeight:700,fontSize:14,color:livePnl.netFromRoll>=0?'var(--green)':'var(--red)'}}>{fmtPnl(livePnl.netFromRoll)}</div>
                      </div>
                    )}
                  </div>
                </div>
              </>)}
              {!moveShortLeg&&longLeg&&(<>
                <div style={sectionHd}>Close Current Long Leg</div>
                <div style={rowSt}>
                  <div style={{flex:1}}>
                    <div style={labelSt}>Sell long at ($) *</div>
                    <input style={inputSt} type="number" step="0.01" placeholder="e.g. 3.80" value={closeLongPx} onChange={e=>setCloseLongPx(e.target.value)}/>
                    <div style={{fontSize:10,color:'var(--text-muted)',marginTop:2}}>Bought at ${longLeg.entry_price?.toFixed(2)} · {(parseFloat(closeLongPx)||0)>longLeg.entry_price?'profit ✓':'loss'}</div>
                  </div>
                </div>
                <div style={sectionHd}>New Long Leg — strike locked to short ({shortLeg?.strike_sell})</div>
                <div style={rowSt}>
                  <div style={{flex:1}}>
                    <div style={labelSt}>Strike (locked — must match short leg)</div>
                    <input style={{...inputSt,background:'var(--bg-hover)',color:'var(--text-muted)',cursor:'not-allowed'}}
                      value={shortLeg?.strike_sell||''} readOnly/>
                  </div>
                  <div style={{flex:1}}>
                    <div style={labelSt}>New Back Month Expiry * (after {shortLeg?.expiration})</div>
                    <ExpiryDatePicker value={newLongExpiry} onChange={setNewLongExpiry} min={historicalMode ? undefined : localDateISO()}/>
                  </div>
                </div>
                <div style={rowSt}>
                  <div style={{flex:1}}>
                    <div style={labelSt}>Premium paid ($) *</div>
                    <input style={inputSt} type="number" step="0.01" placeholder="e.g. 4.50" value={newLongPrem} onChange={e=>setNewLongPrem(e.target.value)}/>
                  </div>
                  <div style={{flex:1,display:'flex',alignItems:'center',paddingTop:18}}>
                    {livePnl?.netCost!=null&&closeLongPx!==''&&newLongPrem!==''&&(
                      <div style={{padding:'6px 10px',background:livePnl.netCost<=0?'var(--green-bg)':'var(--amber-bg,#fff8e1)',borderRadius:6,width:'100%'}}>
                        <div style={{fontSize:10,color:'var(--text-muted)'}}>{livePnl.label}</div>
                        <div style={{fontFamily:'var(--font-mono)',fontWeight:700,fontSize:14,color:livePnl.netCost<=0?'var(--green)':'var(--amber)'}}>{fmtPnl(-livePnl.netCost)}</div>
                      </div>
                    )}
                  </div>
                </div>
              </>)}
            </>)}

            {/* ── close_one_leg — radio: close short or close long ── */}
            {adjType==='close_one_leg'&&(<>
              <div style={{marginBottom:12}}>
                <div style={labelSt}>Which leg to close?</div>
                <div style={{display:'flex',gap:16,marginTop:6}}>
                  <label style={{display:'flex',alignItems:'center',gap:6,cursor:'pointer',fontSize:13}}>
                    <input type="radio" checked={closeShortSide} onChange={()=>setCloseShortSide(true)} style={{cursor:'pointer'}}/>
                    <strong>Short leg</strong>
                  </label>
                  <label style={{display:'flex',alignItems:'center',gap:6,cursor:'pointer',fontSize:13}}>
                    <input type="radio" checked={!closeShortSide} onChange={()=>setCloseShortSide(false)} style={{cursor:'pointer'}}/>
                    <strong>Long leg</strong> ⚠
                  </label>
                </div>
              </div>
              {closeShortSide&&shortLeg&&(<>
                <div style={sectionHd}>Close Short Leg
                  <span style={{fontSize:11,fontWeight:400,color:'var(--text-muted)',marginLeft:8}}>
                    {shortLeg.contracts_open ?? shortLeg.contracts ?? 1} of {shortLeg.contracts_original ?? shortLeg.contracts ?? 1} contracts open
                  </span>
                </div>
                <div style={rowSt}>
                  <div style={{flex:1}}>
                    <div style={labelSt}>Buy back at ($) *</div>
                    <input style={inputSt} type="number" step="0.01" placeholder="e.g. 0.35" value={closeShortPx} onChange={e=>setCloseShortPx(e.target.value)}/>
                    <div style={{fontSize:10,color:'var(--text-muted)',marginTop:2}}>Originally sold at ${shortLeg.entry_price?.toFixed(2)} · {(parseFloat(closeShortPx)||0)<shortLeg.entry_price?'profit ✓':'loss'}</div>
                  </div>
                  {livePnl?.shortClosePnl!=null&&closeShortPx!==''&&(
                    <div style={{flex:1,display:'flex',alignItems:'center',paddingTop:18}}>
                      <PnlBadge label="Short leg P&L" value={livePnl.shortClosePnl} size={13}/>
                    </div>
                  )}
                </div>
                <div style={{background:'var(--blue-bg,#e8f4fd)',border:'1px solid var(--blue-border,#bee3f8)',borderRadius:6,padding:'8px 12px',fontSize:12,color:'var(--blue,#2b6cb0)'}}>
                  ℹ️ Long anchor remains open — position becomes a straight long {trade.option_type==='put'?'put':'call'} after this close.
                </div>
              </>)}
              {!closeShortSide&&longLeg&&(<>
                <div style={sectionHd}>Close Long Leg
                  <span style={{fontSize:11,fontWeight:400,color:'var(--text-muted)',marginLeft:8}}>
                    {longLeg.contracts_open ?? longLeg.contracts ?? 1} of {longLeg.contracts_original ?? longLeg.contracts ?? 1} contracts open
                  </span>
                </div>
                <div style={rowSt}>
                  <div style={{flex:1}}>
                    <div style={labelSt}>Sell long at ($) *</div>
                    <input style={inputSt} type="number" step="0.01" placeholder="e.g. 3.80" value={closeLongPx} onChange={e=>setCloseLongPx(e.target.value)}/>
                    <div style={{fontSize:10,color:'var(--text-muted)',marginTop:2}}>Originally bought at ${longLeg.entry_price?.toFixed(2)} · {(parseFloat(closeLongPx)||0)>longLeg.entry_price?'profit ✓':'loss'}</div>
                  </div>
                  {livePnl?.longClosePnl!=null&&closeLongPx!==''&&(
                    <div style={{flex:1,display:'flex',alignItems:'center',paddingTop:18}}>
                      <PnlBadge label="Long leg P&L" value={livePnl.longClosePnl} size={13}/>
                    </div>
                  )}
                </div>
                <div style={{background:'var(--red-bg,#fff0f0)',border:'1px solid var(--red-border,#f5c6cb)',borderRadius:6,padding:'10px 12px',fontSize:12,color:'var(--red,#c0392b)'}}>
                  ⚠ <strong>Naked short warning:</strong> Closing the long leg removes your hedge. The remaining short will be uncovered with undefined risk. Only proceed if you intend to hold a naked short or will close it immediately.
                </div>
              </>)}
            </>)}

            {/* roll_long_out — close long, open new long at same strike, later expiry */}
            {adjType==='roll_long_out'&&longLeg&&(<>
              <div style={sectionHd}>Close Current Long Leg
                <span style={{fontSize:11,fontWeight:400,color:'var(--text-muted)',marginLeft:8}}>
                  {longLeg.contracts_open ?? longLeg.contracts ?? 1} of {longLeg.contracts_original ?? longLeg.contracts ?? 1} contracts open
                </span>
              </div>
              <div style={rowSt}>
                <div style={{flex:1}}>
                  <div style={labelSt}>Sell long at ($) *</div>
                  <input style={inputSt} type="number" step="0.01" placeholder="e.g. 3.80" value={closeLongPx} onChange={e=>setCloseLongPx(e.target.value)}/>
                  <div style={{fontSize:10,color:'var(--text-muted)',marginTop:2}}>Bought at ${longLeg.entry_price?.toFixed(2)} · {(parseFloat(closeLongPx)||0)>longLeg.entry_price?'profit ✓':'loss'}</div>
                </div>
              </div>
              <div style={sectionHd}>New Long Leg (same strike, later expiry)</div>
              <div style={rowSt}>
                <div style={{flex:1}}>
                  <div style={labelSt}>Strike (same as current: ${longLeg.strike_buy||longLeg.strike_sell})</div>
                  <input style={{...inputSt,background:'var(--bg-hover)',color:'var(--text-muted)',cursor:'not-allowed'}}
                    type="number" value={longLeg.strike_buy||longLeg.strike_sell||''} readOnly/>
                  <div style={{fontSize:10,color:'var(--text-muted)',marginTop:2}}>Strike locked — to change strike use Convert to Diagonal</div>
                </div>
                <div style={{flex:1}}>
                  <div style={labelSt}>New Back Month Expiry * (must be after current {longLeg.expiration_back||longLeg.expiration})</div>
                  <ExpiryDatePicker value={newLongExpiry} onChange={setNewLongExpiry} min={historicalMode ? undefined : localDateISO()}/>
                  {newLongExpiry && (longLeg.expiration_back||longLeg.expiration) && newLongExpiry<=(longLeg.expiration_back||longLeg.expiration) && (
                    <div style={{fontSize:11,color:'var(--red)',fontWeight:600,marginTop:3}}>✕ Must be later than current long expiry ({longLeg.expiration_back||longLeg.expiration})</div>
                  )}
                </div>
              </div>
              <div style={rowSt}>
                <div style={{flex:1}}>
                  <div style={labelSt}>Premium paid ($) *</div>
                  <input style={inputSt} type="number" step="0.01" placeholder="e.g. 4.80" value={newLongPrem} onChange={e=>setNewLongPrem(e.target.value)}/>
                  {newLongPrem && parseFloat(newLongPrem) < parseFloat(closeLongPx||0) && (
                    <div style={{fontSize:10,color:'var(--green)',marginTop:2}}>✓ Net credit roll — new long costs less than proceeds from closing old</div>
                  )}
                </div>
                <div style={{flex:1}}>
                  {livePnl?.netCost!=null&&closeLongPx!==''&&newLongPrem!==''&&(
                    <div style={{padding:'6px 10px',background:livePnl.netCost>=0?'var(--green-bg)':'var(--amber-bg,#fff8e1)',borderRadius:6,marginTop:18}}>
                      <div style={{fontSize:10,color:'var(--text-muted)'}}>{livePnl.label}</div>
                      <div style={{fontFamily:'var(--font-mono)',fontWeight:700,fontSize:14,color:livePnl.netCost>=0?'var(--green)':'var(--amber)'}}>{fmtPnl(livePnl.netCost)}</div>
                    </div>
                  )}
                </div>
              </div>
              {newLongExpiry&&parseInt(((new Date(newLongExpiry)-new Date())/86400000).toFixed(0))<45&&(
                <div style={{background:'var(--amber-bg,#fff8e1)',border:'1px solid var(--amber-border)',borderRadius:6,padding:'8px 12px',marginBottom:8,fontSize:12,color:'var(--amber)'}}>
                  ⚠ New back month is under 45 DTE — consider rolling further out to maintain sufficient time differential over the short leg.
                </div>
              )}
            </>)}

            {/* convert_diagonal — close long, open new long */}
            {adjType==='convert_diagonal'&&longLeg&&(<>
              <div style={sectionHd}>Close Current Long Leg
                <span style={{fontSize:11,fontWeight:400,color:'var(--text-muted)',marginLeft:8}}>
                  {longLeg.contracts_open ?? longLeg.contracts ?? 1} of {longLeg.contracts_original ?? longLeg.contracts ?? 1} contracts open
                </span>
              </div>
              <div style={rowSt}>
                <div style={{flex:1}}>
                  <div style={labelSt}>Sell long at ($) *</div>
                  <input style={inputSt} type="number" step="0.01" placeholder="e.g. 3.80" value={closeLongPx} onChange={e=>setCloseLongPx(e.target.value)}/>
                  <div style={{fontSize:10,color:'var(--text-muted)',marginTop:2}}>Bought at ${longLeg.entry_price?.toFixed(2)} · {(parseFloat(closeLongPx)||0)>longLeg.entry_price?'profit ✓':'loss'}</div>
                </div>
              </div>
              <div style={sectionHd}>New Long Leg (Diagonal)</div>
              <div style={rowSt}>
                <div style={{flex:1}}>
                  <div style={labelSt}>New Strike (different from short)</div>
                  <input style={inputSt} type="number" step="0.5" placeholder={String(longLeg.strike_buy)} value={newLongStrike} onChange={e=>setNewLongStrike(e.target.value)}/>
                  {occStrikeWarn(newLongStrike,longLeg.strike_buy)&&<div style={{fontSize:10,color:'var(--amber)',marginTop:3}}>⚠ {occStrikeWarn(newLongStrike,longLeg.strike_buy)}</div>}
                </div>
                <div style={{flex:1}}>
                  <div style={labelSt}>New Expiry * {shortLeg?`(must be after ${shortLeg.expiration})`:'(back month)'}</div>
                  <ExpiryDatePicker value={newLongExpiry} onChange={setNewLongExpiry} min={historicalMode ? undefined : localDateISO()}/>
                </div>
              </div>
              <div style={rowSt}>
                <div style={{flex:1}}>
                  <div style={labelSt}>Premium paid ($) *</div>
                  <input style={inputSt} type="number" step="0.01" placeholder="e.g. 4.50" value={newLongPrem} onChange={e=>setNewLongPrem(e.target.value)}/>
                </div>
                <div style={{flex:1,display:'flex',alignItems:'center',paddingTop:18}}>
                  {livePnl?.netCost!=null&&closeLongPx!==''&&newLongPrem!==''&&(
                    <div style={{padding:'6px 10px',background:livePnl.netCost<=0?'var(--green-bg)':'var(--amber-bg,#fff8e1)',borderRadius:6,width:'100%'}}>
                      <div style={{fontSize:10,color:'var(--text-muted)'}}>{livePnl.label}</div>
                      <div style={{fontFamily:'var(--font-mono)',fontWeight:700,fontSize:14,color:livePnl.netCost<=0?'var(--green)':'var(--amber)'}}>{fmtPnl(-livePnl.netCost)}</div>
                    </div>
                  )}
                </div>
              </div>
            </>)}

            {/* close_both — adaptive: show only open legs */}
            {(adjType==='close_both')&&(<>
              {!shortLeg&&!longLeg&&<div className="alert alert-blue">Both legs are already closed.</div>}
              {shortLeg&&(<>
                <div style={sectionHd}>Close Short Leg
                  <span style={{fontSize:11,fontWeight:400,color:'var(--text-muted)',marginLeft:8}}>
                    {shortLeg.contracts_open ?? shortLeg.contracts ?? 1} of {shortLeg.contracts_original ?? shortLeg.contracts ?? 1} contracts open
                  </span>
                </div>
                <div style={rowSt}>
                  <div style={{flex:1}}>
                    <div style={labelSt}>Buy back at ($) *</div>
                    <input style={inputSt} type="number" step="0.01" placeholder="e.g. 0.35" value={closeShortPx} onChange={e=>setCloseShortPx(e.target.value)}/>
                    <div style={{fontSize:10,color:'var(--text-muted)',marginTop:2}}>Originally sold at ${shortLeg.entry_price?.toFixed(2)}</div>
                  </div>
                  {livePnl?.shortClosePnl!=null&&closeShortPx!==''&&(
                    <div style={{flex:1,display:'flex',alignItems:'center',paddingTop:18}}>
                      <PnlBadge label="Short leg P&L" value={livePnl.shortClosePnl} size={13}/>
                    </div>
                  )}
                </div>
              </>)}
              {longLeg&&(<>
                <div style={sectionHd}>Close Long Leg
                  <span style={{fontSize:11,fontWeight:400,color:'var(--text-muted)',marginLeft:8}}>
                    {longLeg.contracts_open ?? longLeg.contracts ?? 1} of {longLeg.contracts_original ?? longLeg.contracts ?? 1} contracts open
                  </span>
                </div>
                <div style={rowSt}>
                  <div style={{flex:1}}>
                    <div style={labelSt}>Sell long at ($) *</div>
                    <input style={inputSt} type="number" step="0.01" placeholder="e.g. 3.10" value={closeLongPx} onChange={e=>setCloseLongPx(e.target.value)}/>
                    <div style={{fontSize:10,color:'var(--text-muted)',marginTop:2}}>Originally bought at ${longLeg.entry_price?.toFixed(2)}</div>
                  </div>
                  {livePnl?.longClosePnl!=null&&closeLongPx!==''&&(
                    <div style={{flex:1,display:'flex',alignItems:'center',paddingTop:18}}>
                      <PnlBadge label="Long leg P&L" value={livePnl.longClosePnl} size={13}/>
                    </div>
                  )}
                </div>
              </>)}
              {/* Show "short expired" note if short already closed */}
              {!shortLeg&&longLeg&&(
                <div style={{fontSize:11,color:'var(--text-muted)',marginBottom:8,fontStyle:'italic'}}>
                  ℹ️ Short leg already closed/expired — closing long anchor only.
                </div>
              )}
              {livePnl?.totalCampaignPnl!=null&&(closeShortPx||!shortLeg)&&(closeLongPx||!longLeg)&&(
                <div style={{marginTop:8}}>
                  <PnlBadge label="Total campaign P&L" value={livePnl.totalCampaignPnl} size={18}/>
                </div>
              )}
            </>)}

            {/* reduce_position — partial close one or both legs */}
            {adjType==='reduce_position'&&(<>
              <div style={{fontSize:11,color:'var(--text-muted)',marginBottom:12}}>
                Tick one or both legs to reduce. Each ticked leg must keep at least 1 contract open.
              </div>

              {/* Short leg */}
              {shortLeg&&(
                <div style={{marginBottom:14,padding:'10px 12px',background:reduceShortTick?'var(--bg-hover)':'transparent',border:'1px solid var(--border)',borderRadius:8}}>
                  <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',marginBottom:reduceShortTick?10:0}}>
                    <input type="checkbox" checked={reduceShortTick} onChange={e=>setReduceShortTick(e.target.checked)}
                      style={{width:15,height:15,cursor:'pointer'}}/>
                    <span style={{fontWeight:600,fontSize:13}}>📉 Short leg — ${shortLeg.strike_sell}</span>
                    <span style={{color:'var(--text-muted)',fontSize:11,marginLeft:4}}>
                      {shortLeg.contracts_open ?? shortLeg.contracts ?? 1} of {shortLeg.contracts_original ?? shortLeg.contracts ?? 1} contracts open · entry ${shortLeg.entry_price?.toFixed(2)}
                    </span>
                  </label>
                  {reduceShortTick&&(
                    <>
                      <div style={rowSt}>
                        <div style={{flex:1}}>
                          <div style={labelSt}>Contracts to close * <span style={{color:'var(--text-muted)'}}>(max {(shortLeg.contracts_open||shortLeg.contracts||1)-1})</span></div>
                          <input style={inputSt} type="number" min="1" max={(shortLeg.contracts_open||shortLeg.contracts||1)-1} step="1"
                            placeholder="e.g. 1" value={reduceShortN} onChange={e=>setReduceShortN(e.target.value)}/>
                        </div>
                        <div style={{flex:1}}>
                          <div style={labelSt}>Buy-back price ($) *</div>
                          <input style={inputSt} type="number" step="0.01" placeholder="e.g. 0.35"
                            value={reduceShortPx} onChange={e=>setReduceShortPx(e.target.value)}/>
                        </div>
                      </div>
                      {reduceShortPx!==''&&reduceShortN!==''&&(
                        <div style={{fontSize:11,color:'var(--text-muted)',marginTop:4}}>
                          Short P&L: {fmtPnl((shortLeg.entry_price-(parseFloat(reduceShortPx)||0))*(parseInt(reduceShortN)||0)*100)}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Long leg */}
              {longLeg&&(
                <div style={{marginBottom:14,padding:'10px 12px',background:reduceLongTick?'var(--bg-hover)':'transparent',border:'1px solid var(--border)',borderRadius:8}}>
                  <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',marginBottom:reduceLongTick?10:0}}>
                    <input type="checkbox" checked={reduceLongTick} onChange={e=>setReduceLongTick(e.target.checked)}
                      style={{width:15,height:15,cursor:'pointer'}}/>
                    <span style={{fontWeight:600,fontSize:13}}>📈 Long leg — ${longLeg.strike_buy||longLeg.strike_sell}</span>
                    <span style={{color:'var(--text-muted)',fontSize:11,marginLeft:4}}>
                      {longLeg.contracts_open ?? longLeg.contracts ?? 1} of {longLeg.contracts_original ?? longLeg.contracts ?? 1} contracts open · entry ${longLeg.entry_price?.toFixed(2)}
                    </span>
                  </label>
                  {reduceLongTick&&(
                    <>
                      <div style={rowSt}>
                        <div style={{flex:1}}>
                          <div style={labelSt}>Contracts to close * <span style={{color:'var(--text-muted)'}}>(max {(longLeg.contracts_open||longLeg.contracts||1)-1})</span></div>
                          <input style={inputSt} type="number" min="1" max={(longLeg.contracts_open||longLeg.contracts||1)-1} step="1"
                            placeholder="e.g. 1" value={reduceLongN} onChange={e=>setReduceLongN(e.target.value)}/>
                        </div>
                        <div style={{flex:1}}>
                          <div style={labelSt}>Sell price ($) *</div>
                          <input style={inputSt} type="number" step="0.01" placeholder="e.g. 4.20"
                            value={reduceLongPx} onChange={e=>setReduceLongPx(e.target.value)}/>
                        </div>
                      </div>
                      {reduceLongPx!==''&&reduceLongN!==''&&(
                        <div style={{fontSize:11,color:'var(--text-muted)',marginTop:4}}>
                          Long P&L: {fmtPnl(((parseFloat(reduceLongPx)||0)-longLeg.entry_price)*(parseInt(reduceLongN)||0)*100)}
                        </div>
                      )}
                      {reduceLongTick&&!reduceShortTick&&(
                        <div style={{background:'var(--amber-bg,#fff8e1)',border:'1px solid var(--amber-border)',borderRadius:6,padding:'6px 10px',marginTop:8,fontSize:11,color:'var(--amber)'}}>
                          ⚠ Closing long leg only — remaining short contracts will have no hedge.
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </>)}

            {/* Notes */}
            <div style={{marginTop:12}}>
              <div style={labelSt}>Notes (optional)</div>
              <input style={inputSt} type="text" placeholder="e.g. Re-centred tent after earnings move" value={adjNotes} onChange={e=>setAdjNotes(e.target.value)}/>
            </div>

            {error&&<div style={{color:'var(--red)',fontSize:12,marginTop:8}}>{error}</div>}
            <div style={{display:'flex',justifyContent:'space-between',marginTop:16,gap:8}}>
              <button className="btn btn-outline" onClick={()=>{setStep(1);setError('');}}>← Back</button>
              <button className="btn btn-primary" onClick={()=>{if(validate()){setError('');setStep(3);}}} disabled={!!expiryOrderError}>
                Review →
              </button>
            </div>
          </>
        )}

        {/* STEP 3 — Confirm */}
        {step===3&&selected&&(
          <>
            <div style={sectionHd}>Confirm Adjustment</div>
            <div style={{background:'var(--bg-hover)',borderRadius:8,padding:'14px 16px',marginBottom:16}}>
              <div style={{fontWeight:700,fontSize:13,marginBottom:10}}>{selected.icon} {selected.label} — {trade.ticker}</div>

              {adjType==='roll_short_leg'&&(<>
                <div style={{fontSize:12,marginBottom:4}}>Close short <strong>${shortLeg?.strike_sell}</strong> exp <strong>{shortLeg?.expiration}</strong> at <strong>${parseFloat(closeShortPx).toFixed(2)}</strong></div>
                <div style={{fontSize:12,marginBottom:4}}>Open new short strike <strong>${newShortStrike||shortLeg?.strike_sell}</strong> exp <strong>{newShortExpiry||shortLeg?.expiration}</strong> at <strong>${parseFloat(newShortPrem).toFixed(2)}</strong></div>
                {livePnl?.netFromRoll!=null&&<div style={{marginTop:8}}><PnlBadge label={livePnl.label} value={livePnl.netFromRoll} size={14}/></div>}
                {goldenRuleViolation&&<div style={{marginTop:8,background:'var(--amber-bg,#fff8e1)',border:'1px solid var(--amber-border,#f0d898)',borderRadius:6,padding:'6px 10px',fontSize:12,color:'var(--amber,#92600a)'}}>⚠ {goldenRuleViolation}</div>}
              </>)}

              {adjType==='convert_to_calendar'&&moveShortLeg&&(<>
                <div style={{fontSize:12,marginBottom:4}}>Close short <strong>${shortLeg?.strike_sell}</strong> at <strong>${parseFloat(closeShortPx).toFixed(2)}</strong></div>
                <div style={{fontSize:12,marginBottom:4}}>Open new short strike <strong>${longLeg?.strike_buy}</strong> exp <strong>{newShortExpiry}</strong> at <strong>${parseFloat(newShortPrem).toFixed(2)}</strong></div>
                {livePnl?.netFromRoll!=null&&<div style={{marginTop:8}}><PnlBadge label={livePnl.label} value={livePnl.netFromRoll} size={14}/></div>}
              </>)}

              {adjType==='convert_to_calendar'&&!moveShortLeg&&(<>
                <div style={{fontSize:12,marginBottom:4}}>Sell long <strong>${longLeg?.strike_buy||longLeg?.strike_sell}</strong> at <strong>${parseFloat(closeLongPx).toFixed(2)}</strong>{livePnl?.closingPnl!=null?` → ${fmtPnl(livePnl.closingPnl)}`:''}</div>
                <div style={{fontSize:12,marginBottom:4}}>Buy new long strike <strong>${shortLeg?.strike_sell}</strong> exp <strong>{newLongExpiry}</strong> at <strong>${parseFloat(newLongPrem).toFixed(2)}</strong></div>
                {livePnl?.netCost!=null&&<div style={{marginTop:8}}><PnlBadge label={livePnl.label} value={-livePnl.netCost} size={14}/></div>}
              </>)}

              {adjType==='close_one_leg'&&closeShortSide&&(<>
                <div style={{fontSize:12,marginBottom:4}}>Buy back short <strong>${shortLeg?.strike_sell}</strong> exp <strong>{shortLeg?.expiration}</strong> at <strong>${parseFloat(closeShortPx).toFixed(2)}</strong> → {fmtPnl(livePnl?.shortClosePnl)}</div>
                <div style={{fontSize:11,color:'var(--blue,#2b6cb0)',marginTop:4}}>Long anchor remains open.</div>
                {livePnl?.shortClosePnl!=null&&<div style={{marginTop:8}}><PnlBadge label="Short leg P&L" value={livePnl.shortClosePnl} size={14}/></div>}
              </>)}

              {adjType==='close_one_leg'&&!closeShortSide&&(<>
                <div style={{fontSize:12,marginBottom:4}}>Sell long <strong>${longLeg?.strike_buy||longLeg?.strike_sell}</strong> exp <strong>{longLeg?.expiration_back||longLeg?.expiration}</strong> at <strong>${parseFloat(closeLongPx).toFixed(2)}</strong> → {fmtPnl(livePnl?.longClosePnl)}</div>
                <div style={{fontSize:11,color:'var(--red,#c0392b)',marginTop:4,fontWeight:600}}>⚠ Short leg remains open — naked short position.</div>
                {livePnl?.longClosePnl!=null&&<div style={{marginTop:8}}><PnlBadge label="Long leg P&L" value={livePnl.longClosePnl} size={14}/></div>}
              </>)}

              {adjType==='convert_diagonal'&&(<>
                <div style={{fontSize:12,marginBottom:4}}>Close long <strong>${longLeg?.strike_buy}</strong> at <strong>${parseFloat(closeLongPx).toFixed(2)}</strong>{livePnl?.closingPnl!=null?` → ${fmtPnl(livePnl.closingPnl)}`:''}</div>
                <div style={{fontSize:12,marginBottom:4}}>Open new long strike <strong>${newLongStrike||longLeg?.strike_buy}</strong> exp <strong>{newLongExpiry}</strong> at <strong>${parseFloat(newLongPrem).toFixed(2)}</strong></div>
                {livePnl?.netCost!=null&&<div style={{marginTop:8}}><PnlBadge label={livePnl.label} value={-livePnl.netCost} size={14}/></div>}
              </>)}



              {(adjType==='close_both')&&(<>
                {shortLeg&&<div style={{fontSize:12,marginBottom:4}}>Close short <strong>${shortLeg.strike_sell}</strong> at <strong>${parseFloat(closeShortPx).toFixed(2)}</strong> → {fmtPnl(livePnl?.shortClosePnl)}</div>}
                {!shortLeg&&<div style={{fontSize:12,marginBottom:4,color:'var(--text-muted)',fontStyle:'italic'}}>Short leg: already closed/expired</div>}
                {longLeg&&<div style={{fontSize:12,marginBottom:4}}>Close long <strong>${longLeg.strike_buy}</strong> at <strong>${parseFloat(closeLongPx).toFixed(2)}</strong> → {fmtPnl(livePnl?.longClosePnl)}</div>}
                {livePnl?.totalCampaignPnl!=null&&<div style={{marginTop:8}}><PnlBadge label="Campaign total P&L" value={livePnl.totalCampaignPnl} size={18}/></div>}
              </>)}

              {adjType==='reduce_position'&&(<>
                {shortLeg&&reduceShortTick&&<div style={{fontSize:12,marginBottom:4}}>Close <strong>{reduceShortN}</strong> of <strong>{shortLeg.contracts_open||shortLeg.contracts}</strong> short contracts at <strong>${parseFloat(reduceShortPx).toFixed(2)}</strong> → {fmtPnl((shortLeg.entry_price-(parseFloat(reduceShortPx)||0))*(parseInt(reduceShortN)||0)*100)}</div>}
                {longLeg&&reduceLongTick&&<div style={{fontSize:12,marginBottom:4}}>Close <strong>{reduceLongN}</strong> of <strong>{longLeg.contracts_open||longLeg.contracts}</strong> long contracts at <strong>${parseFloat(reduceLongPx).toFixed(2)}</strong> → {fmtPnl(((parseFloat(reduceLongPx)||0)-longLeg.entry_price)*(parseInt(reduceLongN)||0)*100)}</div>}
                <div style={{fontSize:11,color:'var(--text-muted)',marginTop:6}}>Remaining contracts stay open.</div>
              </>)}

              {adjNotes&&<div style={{fontSize:11,color:'var(--text-muted)',marginTop:8}}>Notes: {adjNotes}</div>}
            </div>

            {error&&<div style={{color:'var(--red)',fontSize:12,marginBottom:8}}>{error}</div>}
            <div style={{display:'flex',justifyContent:'space-between',gap:8}}>
              <button className="btn btn-outline" onClick={()=>{setStep(2);setError('');}}>← Back</button>
              <button className="btn btn-primary" style={{background:'var(--green)',borderColor:'var(--green)'}} onClick={submit} disabled={saving}>
                {saving?'Saving...':'✓ Confirm Adjustment'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
