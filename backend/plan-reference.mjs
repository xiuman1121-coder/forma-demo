const designRevisions=task=>(task?.revisions||[]).filter(revision=>['analysis','design'].includes(revision.kind));
const sceneWords=['室内','挂拍','海边','海滩','沙滩','坐姿','背影','正面','深色','浅色','低饱和','留白','平铺','特写','户外','模特'];

export function directionOptions(task){
 return designRevisions(task).flatMap(revision=>String(revision.content||'').split('\n').flatMap(line=>{
  const heading=line.match(/^\s*#{1,6}\s*方向\s*([A-Z])\s*[｜|:：—-]\s*(.+)$/i);
  const inline=line.match(/^\s*(?:[-*]\s*)?\*\*([A-Z])[.、]\s*([^*：:\n]{2,50})\*\*/i);
  const match=heading||inline;
  return match?[{revisionId:revision.id,sourceJobId:revision.jobId,letter:match[1].toUpperCase(),label:match[2].replace(/\s*（[^）]*派）\s*$/,'').trim().slice(0,48)}]:[];
 }));
}

export function revisionLabel(revision){
 const content=String(revision.content||''),request=String(revision.request||'').trim();
 const options=directionOptions({revisions:[revision]});
 if(options.length>=2)return options.map(option=>option.label).join('、');
 const productTitle=content.match(/\*\*主图\s*1\s*[｜|:：]\s*([^*\n]+)/)?.[1]?.trim();
 if(productTitle)return productTitle;
 const heading=content.split('\n').find(line=>/^#\s+/.test(line)&&!/^(?:#+\s*)(?:产品读图|方案|建议)/.test(line))?.replace(/^#+\s*/, '').replace(/[「」*]/g,'').trim();
 const specificRequest=request&&request.length<=45&&!/^(帮我|请|给我|做一下|有没有).{0,20}(设计|做|制定|方案)/.test(request);
 const title=(specificRequest?request:heading||request||content.split(/[。\n]/)[0].trim()).slice(0,55);
 const words=specificRequest?[]:sceneWords.filter(word=>content.includes(word)&&!title.includes(word)).slice(0,4);
 return [title,words.length?`（${words.join('、')}）`:''].join('')||'未命名方案';
}

const question=labels=>({reason:'ambiguous_plan_reference',question:`你想做的是哪一种画面：${labels.map(label=>`「${label}」`).join('、')}？`});

export function clarifyPlanReference(task,text){
 const revisions=designRevisions(task),options=directionOptions(task),input=String(text||'');
 const letter=input.match(/(?:方向|提案)\s*([A-Z])\b/i)?.[1]?.toUpperCase();
 if(letter){
  const matches=options.filter(option=>option.letter===letter);
  if(matches.length===1)return null;
  if(matches.length>1)return question(matches.map(option=>option.label));
 }
 const relative=/(?:前面|之前|前一个|上一个|先前|早先).{0,8}(?:方案|方向|那个)|(?:方案|方向).{0,8}(?:前面|之前)/.test(input);
 const numeral=input.match(/(?:方案|方向|版本|提案)\s*([一二三四五六七八九十]|[1-9])/)?.[1];
 if(!relative&&!numeral)return null;
 if(/最早|最初|最前面|最开始|第一个版本|刚才.{0,20}(?:之前|前一个|上一个)/.test(input)||(/刚才|最新|刚刚/.test(input)&&!/(之前|前一个|上一个)/.test(input)))return null;
 const candidates=revisions.slice(-4);
 const cueWords=sceneWords.filter(word=>input.includes(word));
 if(cueWords.length){const matches=candidates.filter(revision=>cueWords.every(word=>`${revision.request||''}\n${revision.content||''}`.includes(word)));if(matches.length===1)return null}
 const index={'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9}[numeral]||Number(numeral)||null;
 if(index){
  const formal=candidates.find(revision=>revision.version===index),letter='ABCDEFGHIJKLMNOPQRSTUVWXYZ'[index-1];
  const numbered=options.filter(option=>option.letter===letter);
  if(formal&&numbered.length)return question([revisionLabel(formal),...numbered.map(option=>option.label)]);
  if(numbered.length>1)return question(numbered.map(option=>option.label));
  return null;
 }
 if(/方向/.test(input)&&options.length>1)return question(options.slice(-8).map(option=>option.label));
 if(candidates.length>1)return question(candidates.map(revision=>revisionLabel(revision)));
 return null;
}
