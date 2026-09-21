/** Local-only deterministic OpenAI-compatible fixture. No credentials or bodies are logged. */
import http from 'node:http';
const records = [];
const server = http.createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(data)); };
    if (req.method === 'GET' && req.url === '/test/status') return send(200, records);
    if (req.method === 'GET' && req.url.endsWith('/models')) return send(200, {object:'list',data:[{id:'pf-integration-test',object:'model',owned_by:'local-fixture'}]});
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) return send(404,{error:{message:'Unknown fixture endpoint'}});
    let body='';for await (const chunk of req) body+=chunk;
    let payload;try {payload=JSON.parse(body);}catch{return send(400,{error:{message:'Invalid JSON'}});}
    const messages=payload.messages || [];
    const last=String([...messages].reverse().find(m=>m.role==='user')?.content || '');
    const mode=last.includes('PF_TEST_ABORT')?'abort':last.includes('PF_TEST_ON')?'on':last.includes('PF_TEST_ERROR')?'error':'off';
    const content=mode==='on'||mode==='abort'?'PF_TRIGGER Local integration response.':'Local integration response without the trigger.';
    const record={request:records.length+1,mode,stream:!!payload.stream,hasSentinel:messages.some(m=>String(m.content).includes('PF_AUTO_SENTINEL')),hasMain:messages.some(m=>String(m.content).includes("Write {{char}}")||String(m.content).includes('fictional chat')),messageCount:messages.length,finished:false,aborted:false};
    records.push(record);console.log(JSON.stringify(record));
    if(mode==='error'){record.finished=true;return send(500,{error:{message:'Intentional local integration test error'}});}
    const base={id:`pf-${records.length}`,created:Math.floor(Date.now()/1000),model:'pf-integration-test'};
    if(!payload.stream){record.finished=true;return send(200,{...base,object:'chat.completion',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:8,total_tokens:18}});}
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
    const chunk=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({...base,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}]})}\n\n`);
    chunk({role:'assistant'});chunk({content});
    const timer=setTimeout(()=>{if(res.destroyed)return;chunk({},'stop');res.write('data: [DONE]\n\n');record.finished=true;res.end();},mode==='abort'?15000:120);
    res.on('close',()=>{clearTimeout(timer);if(!record.finished)record.aborted=true;console.log(JSON.stringify({request:record.request,finished:record.finished,aborted:record.aborted}));});
});
server.listen(Number(process.env.PF_TEST_PORT || 0),'127.0.0.1',()=>console.log(`PF_TEST_URL=http://127.0.0.1:${server.address().port}/v1`));
