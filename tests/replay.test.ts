import { expect, it } from 'vitest';
import { dates, initialState, type Criteria } from '../src/lib/domain';
import { recordedReplay } from '../src/lib/replay';

const at = '2026-09-26T15:00:00Z';
function source() {
  const state = initialState();
  state.confirmedCriteria = Object.keys(state.criteria) as (keyof Criteria)[];
  state.messages.push({ id:'a', role:'assistant', text:'This is the checked room price; transport still needs checking.', at });
  state.candidates.push({ id:'krakow', name:'Kraków', country:'Poland', airport:'KRK', image:'', summary:'A partial recorded result', highlights:[], sources:[], status:'partial', stay:{ total:400,currency:'GBP',travellers:2,...dates(state.criteria),checkedAt:at,url:'https://example.com/stay',label:'Fixture quote',scope:'whole-stay',includes:'Five nights',provider:'Test',rawId:'recorded-receipt' } });
  return state;
}
it('keeps a recorded partial result partial and does not change the source', () => {
  const original=source(); const replay=recordedReplay(original,at);
  expect(replay.replay).toBe(true); expect(replay.candidates[0].status).toBe('partial'); expect(original.replay).toBe(false);
});
it('does not turn an active or unevidenced run into a demo', () => {
  const active=source(); active.actions.push({id:'job',label:'Checking',provider:'Test',status:'running',startedAt:at,kind:'stays'});
  expect(()=>recordedReplay(active,at)).toThrow('finish');
  const noReceipt=source(); delete noReceipt.candidates[0].stay!.rawId;
  expect(()=>recordedReplay(noReceipt,at)).toThrow('real dated quote');
  const unknown=source(); unknown.confirmedCriteria=[];
  expect(()=>recordedReplay(unknown,at)).toThrow('Confirm');
});
