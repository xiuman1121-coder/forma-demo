import {catalog} from './zh-catalog.js';
const escapeRx=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const templates=Object.entries(catalog).filter(([k])=>k.includes('${')).map(([en,zh])=>{const keys=[];let last=0,rx='^';for(const m of en.matchAll(/\$\{([^}]+)\}/g)){rx+=escapeRx(en.slice(last,m.index))+'([\\s\\S]*?)';keys.push(m[1]);last=m.index+m[0].length}return {rx:new RegExp(rx+escapeRx(en.slice(last))+'$'),keys,zh}});
export function knownChinese(value){if(typeof value!=='string')return value;if(catalog[value])return catalog[value];for(const t of templates){const match=value.match(t.rx);if(match)return t.zh.replace(/\$\{([^}]+)\}/g,(_,key)=>knownChinese(match[t.keys.indexOf(key)+1]||''))}if(value.startsWith('Curated sample expression: '))return '静态示例素材 · 本地构图，并非实时图像生成。';if(value==='Curated image with campaign message composition.')return '静态图片与推广文案的初始构图。';return value}
export function migrateChinese(p){if(!p||p.uiLocale==='zh-CN')return;
 // Only known defaults in NOMA fields; never translate arbitrary user prose or feedback.
 if(p.brand==='NOMA'){for(const k of ['product','description','brandDescription','sellingPoints','goal','objective','audience','referenceNotes'])p[k]=knownChinese(p[k]);if(p.keywords)p.keywords=p.keywords.map(knownChinese)}
 for(const d of p.creativeDirections||[]){for(const k of ['name','concept','visualDirection','keyMessage','builtFrom'])d[k]=knownChinese(d[k]);d.mood=d.mood?.map(knownChinese)}
 for(const a of p.assets||[]){for(const k of ['type','format','expression'])a[k]=knownChinese(a[k]);for(const k of ['directionName','keyMessage','visualDirection','concept'])if(a.context?.[k])a.context[k]=knownChinese(a.context[k]);for(const v of a.versions||[]){v.text=knownChinese(v.text);v.change=knownChinese(v.change)}}
 if(p.brief){for(const k of Object.keys(p.brief))p.brief[k]=knownChinese(p.brief[k]);if(p.brand==='NOMA'&&p.brief.product?.startsWith('NOMA Portable Coffee Maker.'))p.brief.product=`NOMA ${p.product}。${p.description}`}
 for(const m of p.workspace?.messages||[]){if(m.role==='agent')m.text=knownChinese(m.text);else if(m.text===Object.keys(catalog).find(k=>k.startsWith('We’re launching this portable coffee maker next month.')))m.text=knownChinese(m.text);if(m.context)m.context=m.context.map(x=>x==='Product'?'产品':x.replace(/^Direction /,'方向 ').replace(/^Reference: /,'参考：'))}
 p.uiLocale='zh-CN';
}
