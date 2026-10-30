const dimensions={
 '1:1':'2048x2048',
 '4:3':'2368x1776',
 '3:4':'1776x2368',
 '16:9':'2816x1584',
 '9:16':'1584x2816',
 '3:2':'2496x1664',
 '2:3':'1664x2496',
};

export const imageSizeForRatio=ratio=>dimensions[ratio]||null;

export function requestedImageSize(text){
 const matches=[...String(text||'').matchAll(/(?:^|[^\d])(?:1\s*[:：]\s*1|4\s*[:：]\s*3|3\s*[:：]\s*4|16\s*[:：]\s*9|9\s*[:：]\s*16|3\s*[:：]\s*2|2\s*[:：]\s*3)(?!\d)/g)];
 const ratio=matches.at(-1)?.[0].replace(/[^\d:：]/g,'').replace('：',':')||null;
 return ratio?{ratio,size:dimensions[ratio]}:null;
}

export function imageDimensions(bytes){
 if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
 if(bytes.length<4||bytes[0]!==0xff||bytes[1]!==0xd8)return null;
 let offset=2;
 while(offset+4<bytes.length){
  if(bytes[offset]!==0xff){offset++;continue}
  const marker=bytes[offset+1];offset+=2;
  if(marker===0xd9||marker===0xda)break;
  if(marker===0xd8||marker===0x01||marker>=0xd0&&marker<=0xd7)continue;
  const length=bytes.readUInt16BE(offset);
  if(length<2||offset+length>bytes.length)break;
  if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker))return {height:bytes.readUInt16BE(offset+3),width:bytes.readUInt16BE(offset+5)};
  offset+=length;
 }
 return null;
}

export function matchesRequestedRatio(bytes,request){
 const actual=imageDimensions(bytes);
 if(!actual)return {ok:false,actual:null};
 const [width,height]=request.size.split('x').map(Number);
 return {ok:actual.width*height===actual.height*width,actual};
}
