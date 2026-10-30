import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readEnv} from '../backend/core.mjs';
import {IMAGE_MODEL} from '../backend/pricing.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const outputDir=path.join(root,'diagnostics','text-render-2026-10-12');
const source=path.join(root,'.private','media','c09264d1-c382-4f8e-ba7a-5e44fb285f74.jpg');
const image=`data:image/jpeg;base64,${readFileSync(source).toString('base64')}`;
const env=readEnv(path.join(root,'.env.local'));
if(!env.ARK_API_KEY)throw Error('ARK_API_KEY 未配置');
mkdirSync(outputDir,{recursive:true});

const common='以提供的奶油白耳机主图为参考，保持耳机的颜色、外形、位置、比例和雾蓝至暖白渐变背景。请直接在图像中完成中文电商主图文字设计，文字应当是画面设计的一部分：选择与背景和产品协调的字形、字重、间距、对齐与层级，不要只贴一行默认黑色系统字。下列引号中的每个汉字必须准确，不得改写、漏字、添加其他文案，也不要遮挡耳机。';
const cases={
 'short-a':`${common}\n主标题准确写“新品上市”；副标题准确写“奶油白耳机”。将标题和副标题排在顶部留白区域，使用深灰绿与灰蓝两级字色。`,
 'short-b':`${common}\n主标题准确写“新品上市”；副标题准确写“奶油白耳机”。将标题和副标题排在顶部留白区域，使用深灰绿与灰蓝两级字色。`,
 'long':`${common}\n主标题准确写“新品上市”；副标题准确写“一只好戴的头戴式耳机”；卖点行准确写“奶油白配色 · 柔软耳垫”。将三组文字排在顶部和右侧留白区域，形成明确的主次关系。`
};
const name=process.argv[2];
if(!Object.hasOwn(cases,name))throw Error(`选择 short-a、short-b 或 long；收到 ${name||'空'}`);
const prompt=cases[name];
writeFileSync(path.join(outputDir,`${name}.prompt.txt`),prompt+'\n',{mode:0o600});
const startedAt=new Date().toISOString();
const response=await fetch('https://ark.cn-beijing.volces.com/api/v3/images/generations',{
 method:'POST',
 headers:{Authorization:`Bearer ${env.ARK_API_KEY}`,'Content-Type':'application/json'},
 body:JSON.stringify({model:IMAGE_MODEL,prompt,image:[image],size:'2K',response_format:'b64_json',stream:false,watermark:false}),
 signal:AbortSignal.timeout(180000)
});
const data=await response.json();
const result={case:name,model:IMAGE_MODEL,source:path.relative(root,source),startedAt,finishedAt:new Date().toISOString(),status:response.status,request:{size:'2K',referenceImageCount:1,stream:false,watermark:false},expectedCopy:name==='long'?['新品上市','一只好戴的头戴式耳机','奶油白配色 · 柔软耳垫']:['新品上市','奶油白耳机']};
if(!response.ok||!data.data?.[0]?.b64_json){result.error=data.error||'未返回图片';writeFileSync(path.join(outputDir,`${name}.json`),JSON.stringify(result,null,2),{mode:0o600});throw Error(`生图失败：HTTP ${response.status} ${JSON.stringify(result.error)}`)}
const bytes=Buffer.from(data.data[0].b64_json,'base64');
const ext=bytes[0]===0x89?'png':'jpg';
writeFileSync(path.join(outputDir,`${name}.${ext}`),bytes,{mode:0o600});
result.output=`${name}.${ext}`;result.imageBytes=bytes.length;
writeFileSync(path.join(outputDir,`${name}.json`),JSON.stringify(result,null,2),{mode:0o600});
console.log(JSON.stringify({case:name,output:result.output,status:response.status,imageBytes:bytes.length}));
