import { CalendarDays, ChevronDown, Plane, Settings2, SlidersHorizontal, Users } from 'lucide-react';
import { formatMoney, visibleCriteria, type TripState } from '@/lib/domain';

function dateLabel(value: string) { return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(value + 'T12:00:00Z')); }
export default function TripCriteriaCard({ state, disabled, onEdit }: { state: TripState; disabled: boolean; onEdit: () => void }) {
  const c = visibleCriteria(state);
  const date = c.departureDate ? dateLabel(c.departureDate) : c.departureStart && c.departureEnd ? `${dateLabel(c.departureStart)}–${dateLabel(c.departureEnd)}` : c.departureStart ? `From ${dateLabel(c.departureStart)}` : 'Dates not set';
  const people = c.travellers ? `${c.travellers} ${c.travellers === 1 ? 'person' : 'people'}` : 'People not set';
  const summary = [c.departureDate ? dateLabel(c.departureDate) : null, c.travellers ? people : null, c.budget ? formatMoney(c.budget) : null].filter(Boolean).join(' · ');
  const card = <div className="criteria-card"><div className="section-label"><span><Plane size={15}/>Trip details</span><button type="button" onClick={onEdit} disabled={disabled}>Edit<Settings2 size={14}/></button></div><div className="route-line"><span><small>From</small><strong>{c.origin || 'Departure not set'}</strong></span><div className="route-dots"><span/><Plane size={16}/><span/></div><span><small>To</small><strong>{c.region || 'Destination open'}</strong></span></div><div className="criteria-grid"><span><CalendarDays size={16}/>{date}<small>{c.nights ? `${c.nights} nights` : 'Length not set'}</small></span><span><Users size={16}/>{people}<small>{c.budget ? `${formatMoney(c.budget)} total budget` : 'Budget not set'}</small></span></div></div>;
  return state.candidates.length ? <details className="trip-details-fold"><summary><SlidersHorizontal size={16}/><strong>Trip details</strong><span>{summary}</span><ChevronDown size={15}/></summary>{card}</details> : card;
}
