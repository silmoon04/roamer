import fs from 'node:fs';
fs.mkdirSync('public/images',{recursive:true});
const photos=[];
for(const [city,id] of [['Kraków','krakow'],['Ljubljana','ljubljana'],['Porto','porto']]) {
 const summary=await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/'+encodeURIComponent(city),{headers:{'User-Agent':'RoamerDemo/0.1'}}).then(r=>r.json());
 const source=summary.thumbnail.source.split('?')[0];
 const file=decodeURIComponent(source.split('/').at(-2));
 const query=new URLSearchParams({action:'query',titles:'File:'+file,prop:'imageinfo',iiprop:'url|extmetadata',iiurlwidth:'1280',format:'json',origin:'*'});
 const info=await fetch('https://commons.wikimedia.org/w/api.php?'+query,{headers:{'User-Agent':'RoamerDemo/0.1'}}).then(r=>r.json());
 const image=Object.values(info.query.pages)[0].imageinfo[0];
 const response=await fetch(image.thumburl??image.url);if(!response.ok)throw new Error('Image fetch failed: '+city);
 fs.writeFileSync(`public/images/${id}.jpg`,Buffer.from(await response.arrayBuffer()));
 photos.push({id,city,path:`/images/${id}.jpg`,source:image.descriptionurl,author:image.extmetadata.Artist?.value,license:image.extmetadata.LicenseShortName?.value,licenseUrl:image.extmetadata.LicenseUrl?.value,changes:'Resized and cropped in the interface.'});
 console.log(city+': '+image.extmetadata.LicenseShortName?.value);
}
fs.writeFileSync('public/images/attribution.json',JSON.stringify(photos,null,2));
const css=await fetch('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'}}).then(r=>r.text());
fs.mkdirSync('public/fonts',{recursive:true});
let local=css;let n=0;
for(const url of new Set([...css.matchAll(/url\((https:\/\/[^)]+)\)/g)].map(m=>m[1]))) {
 const path=`/fonts/inter-${n++}.${url.includes('.woff2')?'woff2':'ttf'}`;
 const response=await fetch(url);if(!response.ok)throw new Error('Font fetch failed.');
 fs.writeFileSync('public'+path,Buffer.from(await response.arrayBuffer()));local=local.replaceAll(url,path);
}
fs.writeFileSync('src/app/fonts.css',local);
console.log('Destination photographs, attribution and Inter saved.');
