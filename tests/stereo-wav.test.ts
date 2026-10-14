import test from 'node:test';
import assert from 'node:assert/strict';
import { stereoWav } from '../src/core/gemini/stereoWav.js';
function mono(){const wav=Buffer.alloc(50);wav.write('RIFF');wav.writeUInt32LE(42,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(6,40);[-32768,0,32767].forEach((n,i)=>wav.writeInt16LE(n,44+i*2));return wav;}
test('TTS stereo preserves samples, duration and level',()=>{const out=stereoWav(mono());assert.equal(out.readUInt16LE(22),2);assert.equal(out.readUInt32LE(28),96000);assert.equal(out.readUInt32LE(40),12);assert.deepEqual(Array.from({length:6},(_,i)=>out.readInt16LE(44+i*2)),[-32768,-32768,0,0,32767,32767]);assert.equal(stereoWav(out),out);});
test('reject malformed WAV without emitting corrupt audio',()=>{assert.throws(()=>stereoWav(Buffer.alloc(44)));assert.throws(()=>stereoWav(mono().subarray(0,48)));});
