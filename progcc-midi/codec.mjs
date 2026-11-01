// Original browser/Node codec for the explicitly versioned PMID bank, no device I/O.
export const BANK_BYTES=1136, BUTTONS=['A','B','X','Y','Up','Down','Left','Right','L','R','ZL','ZR','Plus','Minus','Home','Capture','Left stick click','Right stick click','Mode'];
export const AXES=['Left stick X','Left stick Y','Right stick X','Right stick Y','Gyro X','Gyro Y','Gyro Z'];
const fail=message=>{throw new Error(message);};
const integer=(value,min,max,label)=>Number.isInteger(value)&&value>=min&&value<=max||fail(`${label}: choose ${min}–${max}.`);
const number=(value,min,max,label)=>Number.isFinite(value)&&value>=min&&value<=max||fail(`${label}: choose ${min}–${max}.`);
export function label(bytes){return new TextDecoder().decode(Uint8Array.from(bytes)).replace(/\0+$/u,'');}
export function nameBytes(text){const bytes=new TextEncoder().encode(text);if(bytes.length>24)fail('Profile names can use up to 24 UTF-8 bytes.');return [...bytes,...Array(24-bytes.length).fill(0)];}
export function defaultBank(){const bank={active:0,profiles:Array.from({length:4},(_,p)=>({
  name:nameBytes(`Profile ${p+1}`),
  buttons:BUTTONS.map((_,i)=>({action:i===18?4:i===15?5:i===13?6:1,channel:1,number:48+i,low:0,high:100})),
  axes:AXES.map((_,i)=>({action:1,channel:1,controller:16+i,low:0,high:127,deadzone:0.02,invert:false,threshold:1,intervalUs:10000})),
  motion:Array.from({length:3},()=>({mode:0,velocityRange:180,relativeRange:90,filterUs:0}))
}))};
  bank.profiles[1].buttons[0]={action:1,channel:1,number:60,low:0,high:100};
  bank.profiles[1].axes[0]={action:2,channel:1,controller:0,low:0,high:16383,deadzone:0.02,invert:false,threshold:1,intervalUs:10000};
  return bank;
}
export function validateBank(bank){
  integer(bank?.active,0,3,'Active profile');if(!Array.isArray(bank.profiles)||bank.profiles.length!==4)fail('Four profiles are required.');
  bank.profiles.forEach((p,profile)=>{
    const prefix=`Profile ${profile+1}`;
    if(!Array.isArray(p.name)||p.name.length!==24)fail(`${prefix}: invalid label bytes.`);
    p.name.forEach(value=>integer(value,0,255,'Label byte'));
    if(p.buttons?.length!==19||p.axes?.length!==7||p.motion?.length!==3)fail(`${prefix}: input counts do not match.`);
    const outputs=new Map();const output=(key,input)=>{if(outputs.has(key))fail(`${prefix}: ${input} shares an output with ${outputs.get(key)}. Choose another CC or channel.`);outputs.set(key,input);};
    p.buttons.forEach((b,i)=>{
      const input=BUTTONS[i];integer(b.action,0,6,input);if(!b.action||b.action>=4)return;
      integer(b.channel,1,16,`${input} channel`);integer(b.number,0,b.action===1?127:119,`${input} note/CC`);
      integer(b.low,0,127,`${input} low`);integer(b.high,b.action===1?1:0,127,`${input} high`);
      if(b.action!==1)output(`${b.channel}:cc${b.number}`,input);
    });
    p.axes.forEach((a,i)=>{
      const input=AXES[i];integer(a.action,0,2,input);if(!a.action)return;
      const max=a.action===1?127:16383;integer(a.channel,1,16,`${input} channel`);
      integer(a.controller,0,a.action===1?119:0,`${input} CC`);integer(a.low,0,max,`${input} minimum`);integer(a.high,a.low,max,`${input} maximum`);
      number(a.deadzone,0,0.999499,`${input} deadzone`);if(typeof a.invert!=='boolean')fail(`${input}: invalid inversion flag.`);
      integer(a.threshold,1,max,`${input} change threshold`);integer(a.intervalUs,1000,1000000,`${input} interval`);
      output(`${a.channel}:${a.action===1?'cc'+a.controller:'pitch'}`,input);
    });
    p.motion.forEach((m,i)=>{integer(m.mode,0,1,`Gyro ${i+1} response`);number(m.velocityRange,0.01,10000,'Speed range');number(m.relativeRange,0.1,3600,'Angle range');integer(m.filterUs,0,1000000,'Smoothing');});
  });return bank;
}
export function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let j=0;j<8;j++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (~crc)>>>0;}
export function encodeBank(bank){
  validateBank(bank);const bytes=new Uint8Array(BANK_BYTES),v=new DataView(bytes.buffer);bytes.set([80,77,73,68]);v.setUint16(4,1,true);v.setUint16(6,BANK_BYTES,true);bytes.set([bank.active,4,19,7],16);
  bank.profiles.forEach((p,i)=>{
    let at=20+i*279;bytes.set(p.name,at);at+=24;
    for(const b of p.buttons){bytes[at]=b.action;if(b.action>0&&b.action<4)bytes.set([b.channel,b.number,b.low,b.high],at+1);at+=5;}
    for(const a of p.axes){if(a.action){bytes.set([a.action,a.channel,a.controller,Number(a.invert)],at);v.setUint16(at+4,a.low,true);v.setUint16(at+6,a.high,true);v.setUint16(at+8,Math.round(a.deadzone*1000),true);v.setUint16(at+10,a.threshold,true);v.setUint32(at+12,a.intervalUs,true);}at+=16;}
    for(const m of p.motion){bytes[at]=m.mode;v.setUint32(at+4,Math.round(m.velocityRange*1000),true);v.setUint32(at+8,Math.round(m.relativeRange*1000),true);v.setUint32(at+12,m.filterUs,true);at+=16;}
  });v.setUint32(8,crc32(bytes.subarray(16)),true);return bytes;
}
export function decodeBank(input){
  const bytes=Uint8Array.from(input);if(bytes.length!==BANK_BYTES)fail('This is not a complete 1136-byte PMID bank.');
  const v=new DataView(bytes.buffer);if(bytes[0]!==80||bytes[1]!==77||bytes[2]!==73||bytes[3]!==68||v.getUint16(4,true)!==1||v.getUint16(6,true)!==BANK_BYTES||v.getUint32(12,true)||v.getUint32(8,true)!==crc32(bytes.subarray(16))||bytes[17]!==4||bytes[18]!==19||bytes[19]!==7)fail('Unsupported or damaged profile bank.');
  const bank={active:bytes[16],profiles:[]};
  for(let i=0;i<4;i++){
    let at=20+i*279;const p={name:[...bytes.subarray(at,at+24)],buttons:[],axes:[],motion:[]};at+=24;
    for(let j=0;j<19;j++,at+=5){const b={action:bytes[at],channel:bytes[at+1],number:bytes[at+2],low:bytes[at+3],high:bytes[at+4]};if((!b.action||b.action>=4)&&bytes.subarray(at+1,at+5).some(Boolean))fail('Noncanonical button fields.');p.buttons.push(b);}
    for(let j=0;j<7;j++,at+=16){if(bytes[at+3]>1||(!bytes[at]&&bytes.subarray(at+1,at+16).some(Boolean)))fail('Invalid axis flags/disabled fields.');p.axes.push({action:bytes[at],channel:bytes[at+1],controller:bytes[at+2],invert:!!bytes[at+3],low:v.getUint16(at+4,true),high:v.getUint16(at+6,true),deadzone:v.getUint16(at+8,true)/1000,threshold:v.getUint16(at+10,true),intervalUs:v.getUint32(at+12,true)});}
    for(let j=0;j<3;j++,at+=16){if(bytes[at+1]||bytes[at+2]||bytes[at+3])fail('Unsupported motion flags.');p.motion.push({mode:bytes[at],velocityRange:v.getUint32(at+4,true)/1000,relativeRange:v.getUint32(at+8,true)/1000,filterUs:v.getUint32(at+12,true)});}
    bank.profiles.push(p);
  }return validateBank(bank);
}
