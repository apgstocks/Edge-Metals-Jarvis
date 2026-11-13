const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const D=fs.mkdtempSync(path.join(os.tmpdir(),'opc-'));
const S=(id,c,inv,item,t,bk='B1')=>({id,container_no:c,booking_no:bk,invoice_no:inv,item,weight:1,invoice_price:1,customer:'C',date:'2026-09-01',created_at:t});
fs.writeFileSync(D+'/sales.json',JSON.stringify([
 S('SALE_1_a','AAAA1111111','OLD','Alt','2026-09-01T00:00:00Z'),S('SALE_2_b','AAAA1111111','NEW','Alt','2026-09-05T00:00:00Z'),S('SALE_2_c','AAAA1111111','NEW','Starter','2026-09-05T00:00:00Z'),
 S('SALE_3_d','BBBB2222222','X1','Alt','2026-09-01T00:00:00Z'),S('SALE_3_e','BBBB2222222','X1','Starter','2026-09-01T00:00:00Z'),
 S('SALE_4_f','CCCC3333333','I1','Alt','2026-01-01T00:00:00Z','BK-JAN'),S('SALE_5_g','CCCC3333333','I2','Alt','2026-09-01T00:00:00Z','BK-SEP')]));
fs.writeFileSync(D+'/packing_lists.json',JSON.stringify([{id:'PL1',container_no:'DDDD4444444',rows:[],updated_at:'2026-09-01T00:00:00Z'},{id:'PL2',container_no:'dddd 4444444',rows:[],updated_at:'2026-09-09T00:00:00Z'},{id:'PL3',container_no:'EEEE5555555',rows:[],updated_at:'2026-09-01T00:00:00Z'}]));
const run=(...a)=>cp.spawnSync('node',['scripts/one-per-container.js',...a],{env:{...process.env,DATA_DIR:D,JARVIS_TEST:'1'},encoding:'utf8'});
let pass=0,fail=0;const ck=(n,c,d)=>{if(c)pass++;else{fail++;console.log('FAIL',n,d||'')}};
const dry=run();
ck('dry run plans 1 row (old invoice), no more',/Invoices: 1 row\(s\) to delete/.test(dry.stdout),dry.stdout+dry.stderr);
ck('combo (same invoice no.) untouched',!/BBBB2222222/.test(dry.stdout));
ck('same container, different booking untouched',!/CCCC3333333/.test(dry.stdout));
ck('dry run changes nothing',JSON.parse(fs.readFileSync(D+'/sales.json')).length===7);
const w=run('--write');
const left=JSON.parse(fs.readFileSync(D+'/sales.json')).map(r=>r.id).sort();
ck('old invoice removed, new + others kept',JSON.stringify(left)===JSON.stringify(['SALE_2_b','SALE_2_c','SALE_3_d','SALE_3_e','SALE_4_f','SALE_5_g']),left.join()+w.stdout+w.stderr);
const pl=JSON.parse(fs.readFileSync(D+'/packing_lists.json')).map(r=>r.id).sort();
ck('packing lists: latest per container kept',JSON.stringify(pl)===JSON.stringify(['PL2','PL3']),pl.join());
ck('removed list archived first',JSON.parse(fs.readFileSync(D+'/deleted_packing_lists.json'))[0].id==='PL1');
console.log(`${pass} passed, ${fail} failed`);process.exit(fail?1:0);
