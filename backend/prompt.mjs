const clean=value=>String(value||'').trim();

// The Agent owns the image design. Only append a compact, already-bound product
// identity; never turn a discussion revision or a planning item into a new prompt.
export function buildImagePrompt({modelPrompt,productIdentity='',textIntent=null,traceMeta}){
 const prompt=clean(modelPrompt);
 if(!prompt)throw Error('Agent 未提供生图指令，本张图片未生成。');
 const identity=clean(productIdentity);
 const sections=[prompt];
 if(textIntent?.mode==='model_render')sections.push('Agent 指定的图片文字与排版（请逐字呈现，勿自行改写）：\n'+textIntent.content.map(({role,text,layout})=>`${role}「${text}」：${layout}`).join('\n'));
 else if(textIntent?.mode==='none')sections.push('本张无额外设计文字；保留商品本身已有的标签文字，不凭空增加标题、卖点或价格。');
 if(identity)sections.push(`必须保持的产品外观事实：${identity}`);
 const finalPrompt=sections.join('\n\n');
 if(finalPrompt.length>6000)throw Error('Agent 生图指令过长，请缩短后重试；本张图片未生成。');
 if(traceMeta&&typeof traceMeta==='object'){
  traceMeta.agentPromptLength=prompt.length;
  traceMeta.productIdentityAppended=!!identity;
  traceMeta.textMode=textIntent?.mode||null;
  traceMeta.finalPromptLength=finalPrompt.length;
 }
 return finalPrompt;
}
