import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
const execute=promisify(execFile);
const cli='node_modules/grok-bot-cli/dist/bin/gbot.mjs';
const existing=JSON.parse((await readFile('.roamer/bots-before.json','utf8')).replace(/^\uFEFF/,''));
const specs=[['personal','Roamer Personal'],['personal-research','Roamer Personal Research'],['stress-careful','Roamer Test Careful'],['stress-slower','Roamer Test Slower'],['stress-friends','Roamer Test Friends']];
const created=[];
for(const [workspace,name]of specs){
 let bot=existing.find(b=>b.name===name);
 if(!bot){
   const description=`You work only on the ${workspace} Roamer travel workspace. Keep this bot's traveller preferences and trip context separate from every other tester. Follow the structured Roamer protocol supplied in each request. Use public travel sources; never book, purchase, send external messages, or sign into personal accounts. Use your own screen and browser tabs; do not close or change another bot's tabs. Preserve exact must-have wording, especially AND/OR conditions, and distinguish checked prices from unverified suitability.`;
   const {stdout}=await execute(process.execPath,[cli,'bots','create','--name',name,'--description',description,'--json'],{timeout:60000,maxBuffer:1024*1024,windowsHide:true});
   const result=JSON.parse(stdout);await writeFile(`.roamer/bot-${workspace}-created.json`,JSON.stringify(result,null,2));
   bot=result.bot??result.agent??result;
 }
 created.push({workspace,name,id:bot.id});await writeFile('.roamer/isolated-bots.json',JSON.stringify(created,null,2));
 console.log(JSON.stringify({workspace,name,id:bot.id,keys:Object.keys(bot)}));
}
