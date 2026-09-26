import { useRef, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { visibleCriteria, type Criteria, type TripState } from '@/lib/domain';

export default function CriteriaForm({ state, disabled, onSave }: { state: TripState; disabled: boolean; onSave: (patch: Partial<Criteria>) => Promise<void> }) {
  const initial = useRef(Object.fromEntries(Object.entries(visibleCriteria(state)).filter(([,value]) => value!==null)) as Partial<Criteria>).current;
  const [values, setValues] = useState<Partial<Criteria>>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const changed=Object.entries(values).some(([key,value])=>value!==undefined&&JSON.stringify(value)!==JSON.stringify(initial[key as keyof Criteria]));
  const text = (key: keyof Criteria, value: string) => setValues(previous => ({ ...previous, [key]: value || undefined }));
  const number = (key: keyof Criteria, value: string) => setValues(previous => ({ ...previous, [key]: value ? Number(value) : undefined }));
  async function save(event: React.FormEvent) {
    event.preventDefault(); setError('');
    const patch = Object.fromEntries(Object.entries(values).filter(([key,value]) => value!==undefined && JSON.stringify(value)!==JSON.stringify(initial[key as keyof Criteria]))) as Partial<Criteria>;
    if (patch.budget!==undefined) patch.currency='GBP';
    if (patch.departureDate) {
      if (!values.departureStart || patch.departureDate<values.departureStart) patch.departureStart=patch.departureDate;
      if (!values.departureEnd || patch.departureDate>values.departureEnd) patch.departureEnd=patch.departureDate;
    } else if ((patch.departureStart || patch.departureEnd) && (!values.departureStart || !values.departureEnd)) {
      setError('Add both ends of the departure window, or choose a specific date.'); return;
    }
    setBusy(true); try { await onSave(patch); } finally { setBusy(false); }
  }
  return <form className="edit-form" onSubmit={event=>void save(event)}><p>Fill in what you know. Empty fields stay undecided.</p><div className="form-grid">
    <label>Leaving from<input value={values.origin??''} onChange={event=>text('origin',event.target.value)} placeholder="City or airport…"/></label>
    <label>Airport code (optional)<input value={values.originCode??''} maxLength={3} pattern="[A-Z]{3}" onChange={event=>text('originCode',event.target.value.toUpperCase())} placeholder="For example, LON…"/></label>
    <label>People<input type="number" inputMode="numeric" min={1} max={6} value={values.travellers??''} onChange={event=>number('travellers',event.target.value)} placeholder="How many…"/></label>
    <label>Total budget (£)<input type="number" inputMode="numeric" min={100} value={values.budget??''} onChange={event=>number('budget',event.target.value)} placeholder="For everyone…"/></label>
    <label>Specific departure (optional)<input type="date" value={values.departureDate??''} onChange={event=>setValues(previous=>({...previous,departureDate:event.target.value||null}))}/></label>
    <label>Nights<input type="number" inputMode="numeric" min={1} max={30} value={values.nights??''} onChange={event=>number('nights',event.target.value)} placeholder="How long…"/></label>
    <label>Earliest departure<input type="date" value={values.departureStart??''} onChange={event=>setValues(previous=>({...previous,departureStart:event.target.value||undefined,departureDate:null}))}/></label>
    <label>Latest departure<input type="date" value={values.departureEnd??''} min={values.departureStart} onChange={event=>text('departureEnd',event.target.value)}/></label>
  </div><label>Where you’re considering<input value={values.region??''} onChange={event=>text('region',event.target.value)} placeholder="A place or region…"/></label><label>What you enjoy<input value={values.interests?.join(', ')??''} onChange={event=>setValues(previous=>({...previous,interests:event.target.value.split(',').map(value=>value.trim()).filter(Boolean)}))} placeholder="Hiking, food, museums…"/></label><label>Your kind of stay<input value={values.stayStyle??''} onChange={event=>setValues(previous=>({...previous,stayStyle:event.target.value}))} placeholder="Small hotel, apartment, cosy cabin…"/></label><label className="checkbox-label"><input type="checkbox" checked={values.noCar===true} onChange={event=>setValues(previous=>({...previous,noCar:event.target.checked}))}/>We’ll be travelling without a car</label>{error&&<p className="error-text" role="alert">{error}</p>}<button className="button primary" disabled={disabled||busy||!changed}>{busy?<LoaderCircle className="spin" size={17}/>:<>Save trip details<Check size={17}/></>}</button></form>;
}
