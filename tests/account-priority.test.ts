import test from 'node:test';
import assert from 'node:assert/strict';
import {RunningHubBackend} from '../src/core/index.js';
import {NullLogger} from '../src/core/logger.js';
test('RunningHub priority persists and respects availability',async()=>{
 const b=new RunningHubBackend({databasePath:':memory:',logger:new NullLogger()});
 try{
  const ordinary=b.accounts.add('ordinary','a'),low=b.accounts.add('low','b'),high=b.accounts.add('high','c');
  for(const account of [ordinary,low,high])b.database.updateAccount(account.id,{state:'IDLE',coins:'100'});
  b.accounts.setPriority(low.id,true);b.accounts.setPriority(high.id,true);
  b.database.raw.prepare('UPDATE accounts SET priority_weight=100 WHERE id=?').run(low.id);
  b.database.updateAccount(low.id,{lastUsedAt:20});b.database.updateAccount(high.id,{lastUsedAt:10});
  assert.deepEqual(b.accounts.available().map(a=>a.id),[high.id,low.id,ordinary.id]);
  b.database.updateAccount(high.id,{cooldownUntil:Date.now()+60000});
  assert.deepEqual(b.accounts.available().map(a=>a.id),[low.id,ordinary.id]);
  assert.throws(()=>b.accounts.setPriority(low.id,'true'));
  b.accounts.setPriority(low.id,false);assert.equal(b.accounts.get(low.id)?.preferred,false);
 }finally{await b.close();}
});
