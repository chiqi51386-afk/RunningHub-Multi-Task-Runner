/** Duplicate mono PCM samples into L/R without changing speed, pitch or level. */
export function stereoWav(wav: Buffer): Buffer {
  if(wav.length<44 || wav.toString('ascii',0,4)!=='RIFF' || wav.toString('ascii',8,12)!=='WAVE')throw new Error('无效的 WAV 音频');
  let format:Buffer|undefined,data:Buffer|undefined;
  for(let offset=12;offset+8<=wav.length;){
    const size=wav.readUInt32LE(offset+4),end=offset+8+size;
    if(end>wav.length)throw new Error('WAV 音频不完整');
    const id=wav.toString('ascii',offset,offset+4);
    if(id==='fmt ')format=wav.subarray(offset+8,end);
    if(id==='data')data=wav.subarray(offset+8,end);
    offset=end+(size%2);
  }
  if(!format || format.length<16 || !data || format.readUInt16LE(0)!==1 || format.readUInt16LE(14)!==16)throw new Error('仅支持 16 位 PCM WAV 音频');
  const channels=format.readUInt16LE(2),rate=format.readUInt32LE(4);
  if(channels===2)return wav;
  if(channels!==1 || data.length%2 || !rate)throw new Error('WAV 声道或采样数据无效');
  const out=Buffer.alloc(44+data.length*2);
  out.write('RIFF',0);out.writeUInt32LE(out.length-8,4);out.write('WAVEfmt ',8);out.writeUInt32LE(16,16);
  out.writeUInt16LE(1,20);out.writeUInt16LE(2,22);out.writeUInt32LE(rate,24);out.writeUInt32LE(rate*4,28);out.writeUInt16LE(4,32);out.writeUInt16LE(16,34);
  out.write('data',36);out.writeUInt32LE(data.length*2,40);
  for(let i=0;i<data.length;i+=2){const sample=data.readInt16LE(i);out.writeInt16LE(sample,44+i*2);out.writeInt16LE(sample,46+i*2);}
  return out;
}
