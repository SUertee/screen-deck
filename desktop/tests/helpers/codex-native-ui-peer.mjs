// Synthetic app-server used only by UI tests. It writes only under the selected temporary workspace.
import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('codex-cli 0.133.0');process.exit(0);}
const textOnly=process.argv.includes('features.shell_tool=false'),nativeThread=textOnly?'text-thread':'native-thread';
const home=process.env.CODEX_HOME;let signed=fs.existsSync(path.join(home,'signed')),turn=0,cwd;const pending=new Map();
const notify=(method,params)=>console.log(JSON.stringify({method,params}));
const end=(n,status='completed',allowed=false)=>{if(!pending.has(n))return;pending.delete(n);if(allowed)fs.writeFileSync(path.join(cwd,'approved-'+n+'.txt'),'synthetic-ui-write');notify('item/completed',{threadId:nativeThread,turnId:'turn-'+n,item:{id:'command-'+n,type:'commandExecution',command:'synthetic write',status:allowed?'completed':'declined',aggregatedOutput:allowed?'synthetic-ui-write':'denied'}});if(status==='completed')notify('item/agentMessage/delta',{threadId:nativeThread,turnId:'turn-'+n,itemId:'message-'+n,delta:'Codex 合成回复 '+n});notify('turn/completed',{threadId:nativeThread,turn:{id:'turn-'+n,status}});};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);fs.appendFileSync(path.join(home,'fixture-requests.jsonl'),JSON.stringify(q)+'\n');
 if(!q.method){const n=Number(String(q.id).replace('approval-',''));if(pending.has(n))setTimeout(()=>end(n,'completed',q.result?.decision==='accept'),30);return;}
 if(!q.id)return;const reply=result=>console.log(JSON.stringify({id:q.id,result}));
 if(q.method==='initialize')reply({userAgent:'fixture/0.133.0'});
 else if(q.method==='account/read')reply({account:signed?{type:'chatgpt',email:'fixture@example.invalid',planType:'plus'}:null,requiresOpenaiAuth:true});
 else if(q.method==='account/login/start'){reply({type:'chatgpt',loginId:'fixture-login',authUrl:'https://auth.openai.com/oauth/authorize?state=fixture'});setTimeout(()=>{signed=true;fs.writeFileSync(path.join(home,'signed'),'fixture');notify('account/login/completed',{loginId:'fixture-login',success:true,error:null});},30);}
 else if(q.method==='model/list')reply({data:[{model:'gpt-5.5',isDefault:true,hidden:false}]});
 else if(q.method==='thread/start'){cwd=q.params.cwd;reply({thread:{id:nativeThread},cwd,model:'gpt-5.5',modelProvider:'openai',approvalPolicy:q.params.approvalPolicy,sandbox:q.params.sandbox==='workspace-write'?{type:'workspaceWrite',networkAccess:false,writableRoots:[],excludeSlashTmp:true,excludeTmpdirEnvVar:true}:{type:'readOnly',networkAccess:false}});}
 else if(q.method==='turn/start'&&textOnly){const n=++turn;reply({turn:{id:'turn-'+n,status:'inProgress'}});notify('item/agentMessage/delta',{threadId:nativeThread,turnId:'turn-'+n,itemId:'message-'+n,delta:'Codex 纯聊天回复 '+n});notify('turn/completed',{threadId:nativeThread,turn:{id:'turn-'+n,status:'completed'}});}
 else if(q.method==='turn/start'){const n=++turn;pending.set(n,true);reply({turn:{id:'turn-'+n,status:'inProgress'}});notify('item/started',{threadId:nativeThread,turnId:'turn-'+n,item:{id:'command-'+n,type:'commandExecution',command:'Synthetic write approved-'+n+'.txt',status:'inProgress'}});console.log(JSON.stringify({id:'approval-'+n,method:'item/commandExecution/requestApproval',params:{threadId:nativeThread,turnId:'turn-'+n,itemId:'command-'+n,command:'Synthetic write approved-'+n+'.txt',cwd,reason:'Synthetic UI approval'}}));}
 else if(q.method==='turn/interrupt'){reply({});end(Number(q.params.turnId.replace('turn-','')),'interrupted');}
 else reply({});
});
