import {BANK_BYTES,decodeBank,encodeBank} from './codec.mjs';
export const OP={INFO:1,BEGIN:2,CHUNK:3,APPLY:4,CANCEL:5,READ:6,SAVE:7,ACK:64,INFO_REPLY:65,DATA:66};
export const STATUS=['OK','Busy','Invalid request/bank','Incomplete bank','Transfer expired','Unsupported command','Pending cleanup','Storage failure; saving was not confirmed','Save canceled'];
export function frame(command,transaction,offset=0,data=new Uint8Array()){
  if(!Number.isInteger(command)||command<0||command>127||!Number.isInteger(transaction)||transaction<1||transaction>16383||!Number.isInteger(offset)||offset<0||offset>16383||data.length>64)throw new Error('Invalid MIDI configuration frame.');
  const bytes=[0xf0,0x7d,0x50,0x4d,1,command,transaction&127,transaction>>7,offset&127,offset>>7,data.length];
  for(let i=0;i<data.length;){const n=Math.min(7,data.length-i);let high=0;for(let j=0;j<n;j++)high|=((data[i+j]>>7)&1)<<j;bytes.push(high);for(let j=0;j<n;j++)bytes.push(data[i++]&127);}
  bytes.push(0xf7);return Uint8Array.from(bytes);
}
export function parseFrame(input){
  const p=Uint8Array.from(input),length=p[10];
  if(p.length<12||p.length>86||p[0]!==0xf0||p[1]!==0x7d||p[2]!==0x50||p[3]!==0x4d||p[4]!==1||p.at(-1)!==0xf7||p.subarray(1,-1).some(x=>x>127)||length>64||p.length!==12+length+Math.ceil(length/7))return null;
  const transaction=p[6]|(p[7]<<7);if(!transaction)return null;
  const data=[];let at=11;while(data.length<length){const n=Math.min(7,length-data.length),high=p[at++];if(high>>n)return null;for(let j=0;j<n;j++)data.push(p[at++]|(((high>>j)&1)<<7));}
  return {command:p[5],transaction,offset:p[8]|(p[9]<<7),data:Uint8Array.from(data)};
}
export class MidiClient{
  constructor(input,output){this.input=input;this.output=output;this.nextTransaction=1;this.pending=null;this.handle=e=>this.receive(e.data);input.addEventListener('midimessage',this.handle);}
  transaction(){const value=this.nextTransaction;this.nextTransaction=value%16383+1;return value;}
  close(){if(this.pending)this.pending.reject(new Error('Controller connection closed. Apply/save outcome may be unknown. Reconnect and read before another deliberate action.'));this.input.removeEventListener('midimessage',this.handle);}
  receive(bytes){const r=parseFrame(bytes),p=this.pending;if(!r||!p||r.transaction!==p.transaction||r.offset!==p.offset)return;
    if(r.command===OP.ACK){if(r.data.length!==2||r.data[0]!==p.command)return;const status=r.data[1];if(status===6)return;if(status!==0){p.reject(new Error(STATUS[status]??'Unknown controller status.'));return;}if(p.command===OP.INFO||p.command===OP.READ)return;p.resolve(r);}
    else if((p.command===OP.INFO&&r.command===OP.INFO_REPLY)||(p.command===OP.READ&&r.command===OP.DATA))p.resolve(r);
  }
  request(command,transaction,offset=0,data=new Uint8Array()){
    if(this.pending)return Promise.reject(new Error('Wait for the current controller request.'));
    return new Promise((resolve,reject)=>{const bytes=frame(command,transaction,offset,data),longRequest=command===OP.APPLY||command===OP.SAVE,deadline=Date.now()+(longRequest?5000:2000);let timer,attempts=0;
      const finish=(fn,value)=>{clearTimeout(timer);this.pending=null;fn(value);};
      this.pending={command,transaction,offset,resolve:r=>finish(resolve,r),reject:e=>finish(reject,e)};
      const send=()=>{if(Date.now()>=deadline||attempts>=3){this.pending.reject(new Error('No complete reply. Apply/save outcome may be unknown. Reconnect and read before another deliberate action; RAM readback does not confirm storage.'));return;}try{attempts++;this.output.send(bytes);if(this.pending)timer=setTimeout(send,longRequest?1700:650);}catch(error){this.pending.reject(error);}};send();
    });
  }
  async info(){const r=await this.request(OP.INFO,this.transaction());const d=r.data;if(d.length!==11||d[0]!==1||d[1]!==1||d[2]!==4||d[3]!==19||d[4]!==7||d[5]!==64||d[6]>3)throw new Error('This port does not match the experimental ProGCC profile protocol.');return {active:d[6],generation:(d[7]|d[8]<<8|d[9]<<16|d[10]<<24)>>>0};}
  async readBank(){const before=await this.info(),bytes=new Uint8Array(BANK_BYTES);for(let at=0;at<bytes.length;at+=64){const n=Math.min(64,bytes.length-at),r=await this.request(OP.READ,this.transaction(),at,Uint8Array.of(n));if(r.data.length!==n)throw new Error('Incomplete controller bank reply.');bytes.set(r.data,at);}const after=await this.info();if(before.generation!==after.generation)throw new Error('The controller bank changed during reading. Read again.');return decodeBank(bytes);}
  async applyBank(bank){const bytes=encodeBank(bank),transaction=this.transaction();await this.request(OP.BEGIN,transaction,BANK_BYTES);for(let at=0;at<bytes.length;at+=64)await this.request(OP.CHUNK,transaction,at,bytes.subarray(at,at+64));await this.request(OP.APPLY,transaction);const actual=encodeBank(await this.readBank());if(actual.some((byte,i)=>byte!==bytes[i]))throw new Error('Read-back differs from the requested bank. Read the controller before retrying.');}
  // Explicitly saves only a bank already applied/read on the controller. Never uploads a draft.
  async saveCurrentBank(expectedBank){
    const expected=encodeBank(expectedBank),before=encodeBank(await this.readBank());
    if(before.some((byte,i)=>byte!==expected[i]))throw new Error('Controller bank differs. Read it or apply temporarily before choosing Save again. Nothing was sent to storage.');
    await this.request(OP.SAVE,this.transaction());
    const actual=await this.readBank();
    if(encodeBank(actual).some((byte,i)=>byte!==expected[i]))throw new Error('Save acknowledged, but current bank differs. Read the controller; saving the expected bank is not confirmed.');
    return actual;
  }
}
