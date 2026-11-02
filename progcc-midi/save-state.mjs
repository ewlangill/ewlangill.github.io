import {encodeBank,decodeBank} from './codec.mjs';
// Connection-local evidence only: a RAM read never proves persistent storage.
export class SaveState {
  constructor(){this.epoch=0;this.reset();}
  reset(){this.epoch++;this.applied=null;this.acknowledged=false;this.unknown=false;this.pending=false;}
  observed(bank){this.applied=encodeBank(bank);this.acknowledged=false;this.unknown=false;}
  invalidate(){this.applied=null;this.acknowledged=false;this.unknown=true;}
  matches(bank){try{const b=encodeBank(bank);return !!this.applied&&!b.some((x,i)=>x!==this.applied[i]);}catch{return false;}}
  canSave(bank){return !this.pending&&this.matches(bank)&&!this.acknowledged;}
  description(bank){
    if(this.pending)return 'Saving the applied bank…';
    if(this.unknown)return 'Save not confirmed. Read the controller before another deliberate Save; RAM readback alone does not confirm storage.';
    if(!this.applied)return 'Read or apply this bank before saving. Storage has not been confirmed.';
    if(!this.matches(bank))return 'Draft differs from the last verified controller bank. Apply temporarily before saving this draft.';
    return this.acknowledged?'Save acknowledged for this bank during this connection. Physical power-cycle verification is separate.':'Bank matches the last read or apply. Save current bank writes it to controller storage; Download bank keeps a file.';
  }
  async save(client,bank){
    if(!this.canSave(bank))throw new Error('Read or apply a matching bank before choosing Save.');
    const snapshot=decodeBank(encodeBank(bank)),epoch=this.epoch;
    this.pending=true;this.acknowledged=false;
    try{
      const actual=await client.saveCurrentBank(snapshot);
      if(epoch!==this.epoch)throw new Error('Connection changed. Save outcome is not confirmed.');
      const bytes=encodeBank(actual),expected=encodeBank(snapshot);
      if(bytes.some((x,i)=>x!==expected[i]))throw new Error('Save readback differs; saving this bank is not confirmed.');
      this.applied=bytes;this.acknowledged=true;this.unknown=false;
      return actual;
    }catch(error){if(epoch===this.epoch)this.invalidate();throw error;}
    finally{if(epoch===this.epoch)this.pending=false;}
  }
}
