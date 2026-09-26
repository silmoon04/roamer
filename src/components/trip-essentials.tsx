import { useState } from 'react';
import { ArrowUp, LoaderCircle, MapPin, Users, Wallet } from 'lucide-react';
import { visibleCriteria, type TripState } from '@/lib/domain';

export default function TripEssentials({ state, disabled, onSend }: { state: TripState; disabled: boolean; onSend: (text: string) => Promise<boolean | undefined> }) {
  const known = visibleCriteria(state);
  const [origin, setOrigin] = useState('');
  const [travellers, setTravellers] = useState('');
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  if (known.origin && known.travellers && known.budget) return null;
  const text = [!known.origin && origin.trim() ? `Leaving from ${origin.trim()}.` : '', !known.travellers && travellers ? `${travellers} ${travellers === '1' ? 'traveller' : 'travellers'}.` : '', !known.budget && budget ? `£${budget} total budget for everyone.` : ''].filter(Boolean).join(' ');
  return <form className="trip-essentials" aria-label="Trip essentials" onSubmit={async event => { event.preventDefault(); if (!text || busy) return; setBusy(true); try { if (await onSend(text)) setSent(true); } finally { setBusy(false); } }}>
    <div className="essentials-heading"><h3>Trip essentials</h3><p>Add what you know in one go.</p></div>
    <div className="essentials-fields">
      {!known.origin && <label><span><MapPin size={14}/>Leaving from</span><input value={origin} onChange={event=>{setOrigin(event.target.value);setSent(false);}} placeholder="City or airport…" autoComplete="off"/></label>}
      {!known.travellers && <label><span><Users size={14}/>People</span><input type="number" inputMode="numeric" min={1} max={6} value={travellers} onChange={event=>{setTravellers(event.target.value);setSent(false);}} placeholder="How many…"/></label>}
      {!known.budget && <label><span><Wallet size={14}/>Total budget (£)</span><input type="number" inputMode="numeric" min={100} max={100000} value={budget} onChange={event=>{setBudget(event.target.value);setSent(false);}} placeholder="For everyone…"/></label>}
    </div>
    <div className="essentials-submit"><button type="submit" className="button primary" disabled={disabled || busy || sent || !text}>{busy?<LoaderCircle className="spin" size={16}/>:<ArrowUp size={16}/>}Send details</button>{sent&&<small role="status">Saved. Waiting for Grok to update the trip.</small>}</div>
  </form>;
}
