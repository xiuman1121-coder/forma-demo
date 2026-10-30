const encoder=new TextEncoder();
const crcTable=Array.from({length:256},(_,index)=>{let value=index;for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0});
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0}
function header(length){return new DataView(new ArrayBuffer(length))}
function bytes(view){return new Uint8Array(view.buffer)}
export function zipFiles(files){const parts=[],directory=[];let offset=0;
 for(const file of files){const name=encoder.encode(file.name),data=file.data,crc=crc32(data);if(name.length>65535||data.length>0xffffffff)throw Error('下载文件过大');
  const local=header(30);local.setUint32(0,0x04034b50,true);local.setUint16(4,20,true);local.setUint16(6,0x0800,true);local.setUint32(14,crc,true);local.setUint32(18,data.length,true);local.setUint32(22,data.length,true);local.setUint16(26,name.length,true);parts.push(bytes(local),name,data);
  const central=header(46);central.setUint32(0,0x02014b50,true);central.setUint16(4,20,true);central.setUint16(6,20,true);central.setUint16(8,0x0800,true);central.setUint32(16,crc,true);central.setUint32(20,data.length,true);central.setUint32(24,data.length,true);central.setUint16(28,name.length,true);central.setUint32(42,offset,true);directory.push(bytes(central),name);offset+=30+name.length+data.length;
 }
 const directorySize=directory.reduce((sum,part)=>sum+part.length,0),end=header(22);end.setUint32(0,0x06054b50,true);end.setUint16(8,files.length,true);end.setUint16(10,files.length,true);end.setUint32(12,directorySize,true);end.setUint32(16,offset,true);
 return new Blob([...parts,...directory,bytes(end)],{type:'application/zip'});
}
