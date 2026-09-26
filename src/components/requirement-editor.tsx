import { useState } from 'react';
import { Check, LoaderCircle, Trash2 } from 'lucide-react';
import type { TripRequirement } from '@/lib/domain';

export default function RequirementEditor({ requirements, onSave }: { requirements: TripRequirement[]; onSave: (id: string, text: string | null) => Promise<boolean | undefined> }) {
  const [values, setValues] = useState(() => Object.fromEntries(requirements.map(requirement => [requirement.id, requirement.text])));
  const [busy, setBusy] = useState<string | null>(null);
  return <div className="requirement-editor"><p>Change a request if your plans have changed. Saving makes the affected checks need verification again.</p>{requirements.map((requirement, index) => {
    const value = values[requirement.id];
    const removal = !value.trim();
    return <form key={requirement.id} onSubmit={async event => { event.preventDefault(); setBusy(requirement.id); try { await onSave(requirement.id, removal ? null : value.trim()); } finally { setBusy(null); } }}>
      <label htmlFor={`requirement-${index}`}>Request {index + 1}</label>
      <textarea id={`requirement-${index}`} value={value} onChange={event => setValues(previous => ({ ...previous, [requirement.id]: event.target.value }))} rows={4} maxLength={5000}/>
      {removal && <p className="requirement-removal" role="status">This request will be removed when you save.</p>}
      <div><button className="button primary" disabled={busy!==null || value===requirement.text}>{busy===requirement.id?<LoaderCircle className="spin" size={16}/>:<Check size={16}/>} {removal?'Save removal':'Save changes'}</button><button className="text-button" type="button" disabled={busy!==null||removal} onClick={()=>setValues(previous=>({...previous,[requirement.id]:''}))}><Trash2 size={15}/>Remove request</button></div>
    </form>;
  })}</div>;
}
