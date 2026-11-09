const path=require('path'),fs=require('fs'),os=require('os');
const disk=require('./helpers/disk'); const {stub}=require('./helpers/disk/embedder'); const {createRunner}=require('./agents/teach');
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'smoke2-')); const q=[]; const notify=async(m)=>q.push(m);
  const M={by:'apsara',role:'manager'}; const mk=()=>createRunner({disk:disk.open({dir}),company:'edge_metals',embedder:stub(),notify});
  let r=mk();
  console.log('1',JSON.stringify(await r.start({text:'Rad Metal always pays on the 15th of the month',...M})));
  const s=await r.start({text:'rad metal pays on the 15th every month',...M}); console.log('2',s.status,s.candidates&&s.candidates.map(c=>c.id));
  r=mk(); console.log('3 waiting after restart',(await r.waiting()).length);
  console.log('4',JSON.stringify(await r.answer(s.threadId,'replace 1')));
  console.log('5 live notes',JSON.stringify(disk.open({dir}).for('edge_metals').notes.list().map(n=>n.id+':'+n.text)));
  console.log('6 history',JSON.stringify(disk.open({dir}).for('edge_metals').notes.history(2).map(n=>n.id+(n.live?'*':''))));
  console.log('7 recall',JSON.stringify((await r.recall('when does Rad Metal usually pay?')).notes.map(n=>n.id+' '+n.via+' '+n.score)));
  console.log('questions asked',q.length);
})().catch(e=>{console.error('ERR',e);process.exit(1)});
