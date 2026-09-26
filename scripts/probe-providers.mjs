import fs from 'node:fs';
import { parseEnv } from 'node:util';
Object.assign(process.env,parseEnv(fs.readFileSync('.env.local','utf8')));
fs.mkdirSync('.roamer',{recursive:true});
const headers={Authorization:`Bearer ${process.env.APIFY_TOKEN}`,'Content-Type':'application/json'};
const probes=[
  ['flights','kaix~google-flights-scraper',{searches:[{origin:['LHR','LGW','LTN','STN'],destination:'KRK',departureDate:'2026-10-10',returnDate:'2026-10-15'}],adults:2,currency:'GBP',country:'GB',language:'en-GB',maxResults:5,includeBookingDetails:true,maxBookingDetails:2,sortBy:'price'}],
  ['stays','voyager~booking-scraper',{search:'Krakow, Poland',checkIn:'2026-10-10',checkOut:'2026-10-15',adults:2,rooms:1,children:0,currency:'GBP',language:'en-gb',maxItems:4,sortBy:'review_score_and_price',extractAdditionalHotelData:false}]
];
await Promise.all(probes.map(async([kind,actor,input])=>{
  const started=Date.now();const response=await fetch(`https://api.apify.com/v2/acts/${actor}/runs?timeout=150&maxTotalChargeUsd=0.25`,{method:'POST',headers,body:JSON.stringify(input)});const result=await response.json();
  if(!response.ok)throw new Error(`${kind} actor request returned HTTP ${response.status}`);
  let run=result.data;console.log(JSON.stringify({kind,runId:run.id,status:run.status}));
  while(!['SUCCEEDED','FAILED','TIMED-OUT','ABORTED'].includes(run.status)){
    await new Promise(r=>setTimeout(r,4000));const r=await fetch(`https://api.apify.com/v2/actor-runs/${run.id}`,{headers});run=(await r.json()).data;
  }
  const dataset=await fetch(`https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?clean=true&limit=10`,{headers}).then(r=>r.json());
  fs.writeFileSync(`.roamer/probe-${kind}.json`,JSON.stringify({input,run,dataset},null,2));
  console.log(JSON.stringify({kind,status:run.status,seconds:(Date.now()-started)/1000,cost:run.usageTotalUsd,count:dataset.length,fields:Object.keys(dataset[0]??{}).filter(k=>!/^googleResponses$/.test(k))}));
}));
