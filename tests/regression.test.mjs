import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function load(file, bindings, names, tail = '') {
    let source = readFileSync(new URL(`../src/${file}.js`, import.meta.url), 'utf8')
        .replace(/^import .*?;\r?\n/gm, '').replace(/^export /gm, '')
        .replace("import('../../../../openai.js')", 'Promise.resolve(oaiModule)');
    const context = vm.createContext({ console, setTimeout, clearTimeout, structuredClone, ...bindings });
    const result = vm.runInContext(`${source}\n${tail}\n;({${names.join(',')}})`, context);
    return { ...result, context };
}
const plain = x => JSON.parse(JSON.stringify(x));
const defaults = () => ({ folders: [], assignments: {}, order: {}, collapsed: {}, folderDisabled: {}, folderSnapshot: {}, promptDesired: {}, excludedPrompts: {}, excludedFolders: {}, excludedAutoPrompts: {}, excludedAutoFolders: {}, autoFilters: [], matchPresets: [], chatMatchPresets: [] });
function model() {
    const settings = defaults();
    const state = load('state', { extension_settings: { prompt_folders: settings }, saveSettingsDebounced() {}, migrateAutoFilter: x => x, migrateMatchPreset: x => x, promptsInFolder: () => [] }, ['settings','parentOf','nameOf','joinPath','isDescendantOrSelf','rewritePathEverywhere','orderedChildren','moveEntryInOrder','flattenPromptOrder']);
    return { settings: state.settings(), state };
}

test('folder hierarchy, rename/move remaps state, delete clears nested mutes', () => {
    const { settings: s, state } = model();
    const folders = load('folders', { ...state, ROOT: '', settings: () => s, save() {}, renderTree() {}, toastWarn() {} }, ['createFolder','renameFolder','moveFolder','deleteFolder','assignPrompt']);
    folders.createFolder('', 'A'); folders.createFolder('A', 'B');
    s.assignments.p = 'A/B'; s.folderDisabled['A/B'] = true; s.folderSnapshot['A/B'] = {p:true}; s.collapsed['A/B'] = true;
    folders.renameFolder('A', 'C');
    assert.equal(s.assignments.p, 'C/B'); assert.equal(s.folderDisabled['C/B'], true);
    assert.equal(folders.moveFolder('C', 'C/B'), null);
    folders.deleteFolder('C');
    assert.equal(s.assignments.p, ''); assert.deepEqual(plain(s.folderDisabled), {}); assert.deepEqual(plain(s.folderSnapshot), {}); assert.deepEqual(plain(s.collapsed), {});
});

test('manual sibling ordering and unfiled are independent of named ancestors', () => {
    const { settings: s, state } = model(); s.folders = ['Z','A','A/B'];
    state.moveEntryInOrder({type:'folder',key:'Z'}, '', {type:'folder',key:'A'});
    assert.deepEqual(plain(state.orderedChildren('')).map(x=>x.key), ['Z','A']);
    assert.equal(state.isDescendantOrSelf('A/B', 'A'), true);
    assert.equal(state.isDescendantOrSelf('AB', 'A'), false);
    assert.equal(state.isDescendantOrSelf('A', ''), false);
});

function renderModel() {
    const { settings: s, state } = model();
    const prompts = [{identifier:'p',enabled:true},{identifier:'q',enabled:false},{identifier:'r',enabled:true}];
    const batches = [];
    s.folders = ['A','A/B']; s.assignments = {p:'A',q:'A/B',r:'A/B'};
    const render = load('render', { ...state, ROOT:'', settings:()=>s, save(){}, document:{ getElementById:()=>null }, toggleManyWithRetry: changes=>{batches.push(plain(changes));for (const c of changes) prompts.find(p=>p.identifier===c.identifier).enabled=c.enabled; return Promise.resolve(true);}, fixture:prompts }, ['setFolderMaster','setFolderAll','setPromptsLogicalState','isPromptLogicallyEnabled','isPromptSuppressed'], 'liveCache = fixture;');
    return {s,prompts,batches,render};
}
test('nested folder mute restores mixed intentions and independent child mute', async () => {
    const {s,prompts,render:r} = renderModel();
    await r.setFolderMaster('A/B',true); await r.setFolderMaster('A',true);
    assert.ok(prompts.every(p=>!p.enabled));
    await r.setFolderMaster('A',false);
    assert.deepEqual(prompts.map(p=>p.enabled),[true,false,false]);
    await r.setPromptsLogicalState([{identifier:'q',enabled:true}]);
    assert.equal(prompts[1].enabled,false);
    await r.setFolderMaster('A/B',false);
    assert.deepEqual(prompts.map(p=>p.enabled),[true,true,true]); assert.equal(s.promptDesired.q,true);
});
test('force all clears overlapping mutes and updates every intended state', async () => {
    const {s,prompts,render:r} = renderModel(); await r.setFolderMaster('A',true); await r.setFolderAll('A',false);
    assert.deepEqual(plain(s.folderDisabled),{}); assert.ok(prompts.every(p=>!p.enabled));
    await r.setFolderAll('A',true); assert.ok(prompts.every(p=>p.enabled));
});

function matcher() {
    const s = defaults(); s.assignments={a:'A',b:'A/B',c:'Other'};
    const contents={a:'Alice <char name="Alice" type="hero"/>',b:'alice <char name="Bob" type="villain"/>',c:'Rain'};
    return {s, api:load('bulk-match',{settings:()=>s,ROOT:'',isDescendantOrSelf:(p,a)=>p===a||p.startsWith(a+'/'),liveCache:Object.keys(contents).map(identifier=>({identifier})),peekContent:async id=>({content:contents[id]})},['parseXmlTagOccurrences','xmlContentMatches','computeMatches','migrateMatchPreset','isExcludedFromAutoFilter'])};
}
test('XML tags require all attributes on the same occurrence and exact tag boundaries', () => {
    const {api:m}=matcher();
    assert.equal(m.xmlContentMatches('<character name="Alice"/>','char',[]),false);
    assert.equal(m.xmlContentMatches('<char name="Alice"/><char type="hero"/>','char',[{name:'name',value:'Alice'},{name:'type',value:'hero'}]),false);
    assert.equal(m.xmlContentMatches("<char name='Alice' type='hero'/>",'char',[{name:'name',value:'alice'},{name:'type',value:'__ALL__'}]),true);
});
test('word, case sensitivity, regex errors, scope, independent exclusions', async () => {
    const {api:m,s}=matcher();
    assert.equal((await m.computeMatches('A',{type:'word',text:'alice'})).matched.length,2);
    assert.equal((await m.computeMatches('A',{type:'word',text:'Alice',caseSensitive:true})).matched.length,1);
    assert.equal((await m.computeMatches(null,{type:'regex',text:'['})).error,'bad-regex');
    s.excludedFolders.A=true;
    assert.equal((await m.computeMatches(null,{type:'word',text:'alice'})).matched.length,0);
    assert.equal((await m.computeMatches(null,{type:'word',text:'alice'},null,'auto')).matched.length,2);
    s.excludedAutoPrompts.a=true;
    assert.equal((await m.computeMatches(null,{type:'regex',text:'alice'},null,'auto')).matched.length,1);
});
test('legacy presets and auto rules migrate without losing meaning', () => {
    const {api:m}=matcher();
    assert.equal(m.migrateMatchPreset({params:{type:'xml',xmlType:'char',xmlValue:'Alice'}}).params.type,'word');
    const a=load('auto-filter',{LEGACY_XML_TAGS:{character:'char_slc'}},['migrateAutoFilter']);
    const rule=a.migrateAutoFilter({id:'old',matchType:'char',value:'Alice',depth:3});
    assert.equal(rule.condition.matchType,'word'); assert.equal(rule.condition.depth,3); assert.equal(rule.effect.text,'Alice');
});
test('auto conditions: depth zero, recent messages, case sensitivity and invalid regex', async () => {
    const a=load('auto-filter',{getContext:()=>({chat:[{mes:'old Alice'},{mes:'rain'}]})},['evaluateAutoCondition']);
    const check=c=>a.evaluateAutoCondition(c,new Map());
    assert.equal(await check({depth:0}),true);
    assert.equal(await check({depth:1,matchType:'word',value:'Alice'}),false);
    assert.equal(await check({depth:2,matchType:'word',value:'alice'}),true);
    assert.equal(await check({depth:2,matchType:'word',value:'alice',caseSensitive:true}),false);
    assert.equal(await check({depth:2,matchType:'regex',value:'['}),false);
});

class Element {
    constructor(tag='div') {this.tagName=tag;this.children=[];this.attrs={};this.events={};this.classList={add:()=>{},toggle:(k,v)=>{this.attrs[k]=v;},contains:k=>!!this.attrs[k]};}
    append(...children){this.children.push(...children);} appendChild(child){this.append(child);return child;}
    setAttribute(k,v){this.attrs[k]=v;} toggleAttribute(k,v){if(v)this.attrs[k]='';else delete this.attrs[k];}
    addEventListener(k,f){this.events[k]=f;}
    fire(k){return this.events[k]?.();}
}
const el=(tag,cls,attrs)=>{const e=new Element(tag);e.className=cls;for(const [k,v] of Object.entries(attrs||{})) {if(k==='text')e.textContent=v;else e.setAttribute(k,v);}return e;};
const walk=e=>[e,...e.children.flatMap(walk)];
test('filter group create, nested move, mute, collapse, rename and delete preserve items', () => {
    const s={}; let answer='A';const items=[{name:'one',enabled:false}];
    const g=load('filter-groups',{el,settings:()=>s,save(){},toastWarn(){},prompt:()=>answer},['buildFilterGroups','isFilterGroupDisabled','groupState']);
    let root;const refresh=()=>{root=new Element();const view=g.buildFilterGroups(root,'autoFilters',items,refresh);view.add(new Element(),items[0]);};
    const click=title=>{
        walk(root).find(e=>e.attrs.title===title).fire('click');
        const form=walk(root).find(e=>e.className==='pf-group-name-form');
        if(form){form.children[0].value=answer;form.events.submit({preventDefault(){}});}
    };
    refresh();click('New filter group');answer='B';click('New subgroup in A');
    const select=walk(root).find(e=>e.attrs['aria-label']==='Move filter one to group');select.value='A/B';select.fire('change');
    click('Enable/disable group A (preserves individual settings)');assert.equal(g.isFilterGroupDisabled('autoFilters',items[0]),true);assert.equal(items[0].enabled,false);
    click('Expand/collapse A');assert.equal(g.groupState('autoFilters').collapsed.A,true);
    answer='C';click('Rename group A');assert.equal(items[0].group,'C/B');assert.equal(g.isFilterGroupDisabled('autoFilters',items[0]),true);
    click('Delete group C, keep filters');assert.equal(items[0].group,'');assert.equal(items.length,1);assert.equal(items[0].enabled,false);
});

function nativeModel() {
    const entries=[{identifier:'a',enabled:true},{identifier:'b',enabled:true}];
    const dock=new Element(); dock.children=[new Element()]; let rendered=[true,true];let release;let renders=0,saves=0;const errors=[];
    const manager={activeCharacter:{id:1},getPromptOrderEntry:(_,id)=>entries.find(e=>e.identifier===id),tokenHandler:{getCounts:()=>({})},saveServiceSettings:async()=>{saves++;},tryGenerate:()=>new Promise(resolve=>{release=resolve;}),renderPromptManager:async()=>{},renderPromptManagerListItems:async()=>{renders++;rendered=entries.map(e=>e.enabled);},makeDraggable(){}};
    const list={querySelectorAll:()=>entries.map((e,i)=>({getAttribute:()=>e.identifier,querySelector:()=>({classList:{contains:()=>rendered[i]}})}))};
    const document={getElementById:id=>id==='pf-dock'?dock:null,querySelector:()=>list};
    const n=load('native',{document,SELECTORS:{promptList:'list',promptItem:'li'},oaiModule:{oai_settings:{prompts:[]},promptManager:manager},renderTree(){},toastError:e=>errors.push(e)},['toggleManyWithRetry','getOaiModule']);
    return {n,entries,dock,errors,manager,release:()=>release(),stats:()=>({renders,saves}),tick:()=>new Promise(setImmediate)};
}
test('native batch stays busy until actual work completes, renders/saves once and no-op does not load',async()=>{
    const m=nativeModel();const done=m.n.toggleManyWithRetry([{identifier:'a',enabled:false},{identifier:'b',enabled:false}]);
    await m.tick();assert.equal(m.dock.attrs['aria-busy'],'true');assert.equal(m.stats().renders,0);
    m.release();assert.equal(await done,true);assert.equal(m.dock.attrs['aria-busy'],'false');assert.deepEqual(m.stats(),{renders:1,saves:1});
    await m.n.toggleManyWithRetry([{identifier:'a',enabled:false}]);assert.deepEqual(m.stats(),{renders:1,saves:1});
});
test('overlapping native batches finish in order; final requested state wins',async()=>{
    const m=nativeModel();const first=m.n.toggleManyWithRetry([{identifier:'a',enabled:false}]);const second=m.n.toggleManyWithRetry([{identifier:'a',enabled:true}]);
    await m.tick();m.release();await first;await m.tick();assert.equal(m.dock.attrs['aria-busy'],'true');m.release();await second;
    assert.equal(m.entries[0].enabled,true);assert.equal(m.dock.attrs['aria-busy'],'false');assert.deepEqual(m.stats(),{renders:2,saves:2});
});
test('missing native entry fails visibly and always releases loading',async()=>{
    const m=nativeModel();assert.equal(await m.n.toggleManyWithRetry([{identifier:'missing',enabled:false}]),false);assert.equal(m.errors.length,1);assert.equal(m.dock.attrs['aria-busy'],'false');assert.equal(m.stats().saves,0);
});

test('multi-selection toggles independently and clears without modifying prompt state',()=>{
    const r=load('render',{},['toggleSelection','isSelected','selectionSize','selectionEntries','clearSelection']);
    r.toggleSelection({type:'folder',key:'A'});r.toggleSelection({type:'prompt',key:'p'});assert.equal(r.selectionSize(),2);
    r.toggleSelection({type:'folder',key:'A'});assert.equal(r.selectionSize(),1);assert.equal(r.isSelected({type:'prompt',key:'p'}),true);r.clearSelection();assert.equal(r.selectionSize(),0);
});
test('dragging folders prunes implied descendants; before/after preserves multi-item order',()=>{
    const s=defaults();s.assignments={p:'A/B'};const moves=[];const assignments=[];
    const d=load('dnd',{ROOT:'',settings:()=>s,isDescendantOrSelf:(p,a)=>p===a||p.startsWith(a+'/'),assignPrompt:(...x)=>assignments.push(x),moveFolder:(p,parent)=>parent+'/'+p,moveEntryInOrder:(...x)=>moves.push(plain(x)),save(){},renderTree(){},toastWarn(){}},['pruneImpliedByAncestors','handleDrop']);
    assert.deepEqual(plain(d.pruneImpliedByAncestors([{type:'folder',key:'A'},{type:'folder',key:'A/B'},{type:'prompt',key:'p'}])),[{type:'folder',key:'A'}]);
    d.handleDrop([{type:'prompt',key:'a'},{type:'prompt',key:'b'}],{type:'prompt',key:'anchor',parentPath:'C',zone:'before'});
    assert.deepEqual(assignments,[['a','C'],['b','C']]);assert.deepEqual(moves[0][2],{type:'prompt',key:'anchor'});assert.deepEqual(moves[1][3],{type:'prompt',key:'a'});
});
test('import append keeps existing values and deduplicates order',()=>{
    const s=defaults();s.folders=['A'];s.assignments.p='A';s.promptDesired.p=false;s.order['']=[{type:'folder',key:'A'}];
    const io=load('import-export',{},['mergeFolderStructure']);
    io.mergeFolderStructure(s,{folders:['A','B'],assignments:{p:'B',q:'B'},promptDesired:{p:true,q:true},order:{'':[{type:'folder',key:'A'},{type:'folder',key:'B'}]}});
    assert.deepEqual(s.folders,['A','B']);assert.equal(s.assignments.p,'A');assert.equal(s.assignments.q,'B');assert.equal(s.promptDesired.p,false);assert.equal(s.order[''].length,2);
});
test('scoped import rewrites hierarchy and preserves prompt identifiers',()=>{
    const io=load('import-export',{ROOT:'',joinPath:(p,n)=>p?`${p}/${n}`:n},['remapImportDataToParent']);
    const data=io.remapImportDataToParent({folders:['A'],assignments:{p:'A'},order:{'':[{type:'folder',key:'A'},{type:'prompt',key:'p'}]},folderDisabled:{A:true}},'Parent');
    assert.deepEqual(plain(data.folders),['Parent/A']);assert.equal(data.assignments.p,'Parent/A');assert.equal(data.order.Parent[1].key,'p');assert.equal(data.folderDisabled['Parent/A'],true);
});
test('import restore adds missing definitions/order once and preserves existing prompts',async()=>{
    const oai={prompts:[{identifier:'a',name:'Existing',content:'keep'}],prompt_order:[{order:[{identifier:'a',enabled:false}]}]};
    const io=load('import-export',{getOaiModule:async()=>({oai_settings:oai}),findPromptOrderEntry:x=>x.prompt_order[0],confirm:()=>true,save(){},forceNativeRerender:cb=>cb(),renderTree(){},window:{},toastWarn(){}},['restorePromptsFromImport']);
    const data={prompts:[{identifier:'b',name:'Imported',content:'new'}],prompt_order:[{order:[{identifier:'b',enabled:true}]}]};
    await io.restorePromptsFromImport(data);await io.restorePromptsFromImport(data);assert.equal(oai.prompts.length,2);assert.equal(oai.prompts[0].content,'keep');assert.equal(oai.prompt_order[0].order.length,2);
});
test('import conflict detection and suffix naming avoid silent replacement',()=>{
    const io=load('import-export',{},['findNameConflicts','nameWithSuffix']);
    const conflicts=io.findNameConflicts([{identifier:'a',name:'Name',content:'old'}],[{identifier:'b',name:'Name',content:'new'}]);assert.equal(conflicts.length,1);
    assert.notEqual(io.nameWithSuffix('Name',new Set(['Name'])),'Name');
});
test('unlist preserves definitions; permanent deletion removes references in all presets',async()=>{
    const oai={prompts:[{identifier:'a'},{identifier:'b'}],prompt_order:[{character_id:1,order:[{identifier:'a'},{identifier:'b'}]},{character_id:2,order:[{identifier:'a'}]}]};
    const n=load('native',{oaiModule:{oai_settings:oai},getContext:()=>({characterId:1}),liveCache:[]},['bulkUnlistPrompts','bulkDeletePromptsPermanently']);
    assert.equal(await n.bulkUnlistPrompts(['a']),1);assert.equal(oai.prompts.length,2);assert.equal(oai.prompt_order[1].order.length,1);
    assert.equal(await n.bulkDeletePromptsPermanently(['a']),1);assert.equal(oai.prompts.length,1);assert.equal(oai.prompt_order[1].order.length,0);
});
test('empty native lists can refresh without toggling an anchor prompt',async()=>{
    let renders=0,callback=0;
    const n=load('native',{oaiModule:{oai_settings:{prompts:[]},promptManager:{renderPromptManager:async()=>{},renderPromptManagerListItems:async()=>{renders++;},makeDraggable(){}}},toastError:assert.fail},['forceNativeRerender']);
    await n.forceNativeRerender(()=>callback++);assert.equal(renders,1);assert.equal(callback,1);
});
test('native batch does not wait for unrelated persistence debounce',async()=>{
    const m=nativeModel();m.manager.saveServiceSettings=()=>new Promise(()=>{});
    const done=m.n.toggleManyWithRetry([{identifier:'a',enabled:false}]);await m.tick();m.release();assert.equal(await done,true);assert.equal(m.dock.attrs['aria-busy'],'false');
});
test('native render failures report error instead of success and unlock controls',async()=>{
    const m=nativeModel();m.manager.renderPromptManagerListItems=async()=>{throw Error('render failed');};
    const done=m.n.toggleManyWithRetry([{identifier:'a',enabled:false}]);await m.tick();m.release();assert.equal(await done,false);assert.equal(m.errors[0],'render failed');assert.equal(m.dock.attrs['aria-busy'],'false');
});
test('auto-filter events register received/sent/swipe/edit/delete/chat and finish/abort',()=>{
    const keys=['MESSAGE_RECEIVED','MESSAGE_SENT','MESSAGE_SWIPED','MESSAGE_DELETED','MESSAGE_EDITED','CHAT_CHANGED','GENERATION_STOPPED','GENERATION_ENDED'];const callbacks={};let scheduled=0;const s={autoFilterOnGenerationDone:true};
    const a=load('auto-filter',{event_types:Object.fromEntries(keys.map(k=>[k,k])),eventSource:{on:(k,fn)=>callbacks[k]=fn},settings:()=>s,setTimeout:()=>{scheduled++;},clearTimeout(){}},['tryHookChatEvents']);
    a.tryHookChatEvents();assert.equal(Object.keys(callbacks).length,8);for(const fn of Object.values(callbacks))fn();assert.equal(scheduled,8);s.autoFilterOnGenerationDone=false;callbacks.GENERATION_STOPPED();assert.equal(scheduled,8);
});
test('auto rules run serially, later rule wins, disabled groups/master skip effects',async()=>{
    const s={autoFilters:[{enabled:true,condition:{depth:0},effect:{mode:'manual',manualPrompts:['p']},action:'disable'},{enabled:true,condition:{depth:0},effect:{mode:'manual',manualPrompts:['p']},action:'enable'}],folderDisabled:{}};const p={identifier:'p',enabled:true};const applied=[];
    const a=load('auto-filter',{settings:()=>s,liveCache:[p],isExcludedFromAutoFilter:()=>false,isFolderExcludedFromAutoFilter:()=>false,isFilterGroupDisabled:(_,f)=>!!f.groupMuted,isPromptLogicallyEnabled:p=>p.enabled,setPromptsLogicalState:async changes=>{for(const c of changes){await Promise.resolve();p.enabled=c.enabled;applied.push(c.enabled);}}},['evaluateAutoFilters']);
    assert.equal((await a.evaluateAutoFilters()).rulesRun,2);assert.deepEqual(applied,[false,true]);s.autoFilters[0].groupMuted=true;assert.equal((await a.evaluateAutoFilters()).rulesRun,1);s.autoFilterDisabled=true;assert.equal((await a.evaluateAutoFilters()).reason,'disabled');
});

test('search matches name or identifier, ignores case and resets',()=>{
    const r=load('render',{},['setSearchTerm','matchesSearch']);r.setSearchTerm('MAIN');assert.equal(r.matchesSearch({name:'Main Prompt',identifier:'p'}),true);assert.equal(r.matchesSearch({name:'Other',identifier:'main-id'}),true);assert.equal(r.matchesSearch({name:'Other',identifier:'q'}),false);r.setSearchTerm('');assert.equal(r.matchesSearch({name:'Other',identifier:'q'}),true);
});
test('folder naming uses native popup and trims or cancels',async()=>{
    let value='  Folder  ';const r=load('render',{Popup:{show:{input:async()=>value}}},['promptOrNull']);assert.equal(await r.promptOrNull('name'),'Folder');value=' ';assert.equal(await r.promptOrNull('name'),null);value=null;assert.equal(await r.promptOrNull('name'),null);
});
test('full export includes filter groups and rules; single prompt export is scoped',async()=>{
    const s=defaults();s.folders=['A','A/B'];s.assignments={p:'A/B'};s.promptDesired.p=true;s.filterGroups={autoFilters:{folders:['Rules'],collapsed:{},disabled:{Rules:true}}};s.autoFilters=[{id:'r',group:'Rules'}];
    const oai={prompts:[{identifier:'p',name:'Test',content:'hello'},{identifier:'other',name:'Other'}],prompt_order:[{character_id:1,order:[{identifier:'p',enabled:true}]}]};let blob;
    const io=load('import-export',{settings:()=>s,Blob,URL:{createObjectURL:b=>{blob=b;return 'blob:test';},revokeObjectURL(){}},document:{createElement:()=>({click(){},remove(){}}),body:{appendChild(){}}},setTimeout(){},getOaiModule:async()=>({oai_settings:oai}),findPromptOrderEntry:x=>x.prompt_order[0],liveCache:[{identifier:'p'}]},['exportFolderStructure','exportPrompt']);
    await io.exportFolderStructure();const full=JSON.parse(await blob.text());assert.equal(full.autoFilters[0].group,'Rules');assert.equal(full.filterGroups.autoFilters.disabled.Rules,true);assert.equal(full.prompts.length,1);
    await io.exportPrompt('p','Test');const one=JSON.parse(await blob.text());assert.equal(one.prompts.length,1);assert.deepEqual(one.folders,['A','A/B']);assert.equal(one.assignments.p,'A/B');
});
test('filter backup merge preserves local rules and group state',()=>{
    const s=defaults();s.autoFilters=[{id:'a',name:'keep'}];s.filterGroups={autoFilters:{folders:['A'],disabled:{A:false},collapsed:{}}};const io=load('import-export',{},['mergeFolderStructure']);
    io.mergeFolderStructure(s,{autoFilters:[{id:'a',name:'replace'},{id:'b',group:'B'}],filterGroups:{autoFilters:{folders:['A','B'],disabled:{A:true,B:true},collapsed:{}}}});
    assert.equal(s.autoFilters[0].name,'keep');assert.equal(s.autoFilters.length,2);assert.equal(s.filterGroups.autoFilters.disabled.A,false);assert.equal(s.filterGroups.autoFilters.disabled.B,true);
});
test('filter drag-to-group works and cannot move a group into itself',()=>{
    const s={filterGroups:{autoFilters:{folders:['A','A/B'],collapsed:{},disabled:{}}}};const items=[{id:'r',name:'Rule'}];let warnings=0;const g=load('filter-groups',{el,settings:()=>s,save(){},toastWarn:()=>warnings++},['buildFilterGroups']);let root;
    const refresh=()=>{root=new Element();const view=g.buildFilterGroups(root,'autoFilters',items,refresh);view.add(new Element(),items[0]);};refresh();
    const drop=(label,data)=>{const header=walk(root).find(e=>e.children.some(c=>c.textContent===label));header.events.drop({preventDefault(){},stopPropagation(){},dataTransfer:{getData:()=>JSON.stringify(data)}});};
    drop('📁 B',{key:'autoFilters',type:'filter',id:'r'});assert.equal(items[0].group,'A/B');drop('📁 B',{key:'autoFilters',type:'group',path:'A'});assert.equal(warnings,1);assert.deepEqual(s.filterGroups.autoFilters.folders,['A','A/B']);
});

test('new prompt inserts after anchor, keeps template fields, and gets unique name',async()=>{
    const order={character_id:1,order:[{identifier:'a',enabled:true}]};const oai={prompts:[{identifier:'a',name:'New Prompt',content:'old',role:'system'}],prompt_order:[order]};const assigned=[];
    const n=load('native',{oaiModule:{oai_settings:oai,promptManager:{renderPromptManager:async()=>{},renderPromptManagerListItems:async()=>{},makeDraggable(){}}},getContext:()=>({characterId:1}),liveCache:[],crypto:{randomUUID:()=> 'new'},save(){},assignPrompt:(...args)=>assigned.push(args),moveEntryInOrder(){},renderTree(){},setTimeout(){},toastError:assert.fail},['directCreatePrompt']);
    await n.directCreatePrompt('Folder',{type:'prompt',key:'a'});await new Promise(setImmediate);
    assert.deepEqual(order.order.map(e=>e.identifier),['a','new']);assert.equal(oai.prompts[1].name,'New Prompt 2');assert.equal(oai.prompts[1].content,'');assert.equal(oai.prompts[1].role,'system');assert.deepEqual(assigned,[['new','Folder']]);
});
test('new prompt rolls back when active order cannot be located',async()=>{
    const oai={prompts:[{identifier:'a',name:'Template'}],prompt_order:[]};const errors=[];
    const n=load('native',{oaiModule:{oai_settings:oai},getContext:()=>({}),liveCache:[],toastError:e=>errors.push(e)},['directCreatePrompt']);await n.directCreatePrompt('',null);assert.equal(oai.prompts.length,1);assert.equal(errors.length,1);
});
test('native ordering preserves state and native-only entries',async()=>{
    const a={identifier:'a',enabled:false,custom:1},b={identifier:'b',enabled:true},extra={identifier:'extra',enabled:true};const order={character_id:1,order:[a,b,extra]};
    const n=load('native',{oaiModule:{oai_settings:{prompts:[],prompt_order:[order]}},getContext:()=>({characterId:1}),liveCache:[],document:{querySelector:()=>null},SELECTORS:{promptList:'list'},save(){}},['getOaiModule','syncNativePromptOrder']);await n.getOaiModule();n.syncNativePromptOrder(['b','a']);assert.deepEqual(order.order.map(e=>e.identifier),['b','a','extra']);assert.equal(order.order[1],a);assert.equal(order.order[1].enabled,false);assert.equal(order.order[1].custom,1);
});
test('native edit reveals response configuration before opening editor',()=>{
    const calls=[];const edit={click:()=>calls.push('edit')};const row={querySelector:()=>edit};const list={querySelector:()=>row};
    const n=load('native',{SELECTORS:{promptList:'list',editAction:'edit',responsePanel:'panel',responsePanelToggle:'toggle'},CSS:{escape:x=>x},document:{querySelector:sel=>sel==='list'?list:sel==='panel'?{classList:{contains:()=>true}}:{click:()=>calls.push('drawer')},getElementById:()=>null},closeAutoFilterModal(){},closeBulkMatchModal(){},closeContextMenu(){},closeImportConflictsModal(){}},['openNativeEditor']);assert.equal(n.openNativeEditor('a'),true);assert.deepEqual(calls,['drawer','edit']);
});

test('pre-send event waits for native effects before allowing request assembly',async()=>{
    const callbacks={};let release;const p={identifier:'p',enabled:false};
    const s={autoFilterOnSendClick:true,autoFilters:[{enabled:true,condition:{depth:0},effect:{mode:'manual',manualPrompts:['p']},action:'enable'}],folderDisabled:{}};
    const a=load('auto-filter',{settings:()=>s,event_types:{MESSAGE_SENT:'sent'},eventSource:{on:(key,fn)=>callbacks[key]=fn},liveCache:[p],isExcludedFromAutoFilter:()=>false,isFolderExcludedFromAutoFilter:()=>false,isFilterGroupDisabled:()=>false,isPromptLogicallyEnabled:p=>p.enabled,setPromptsLogicalState:async changes=>{await new Promise(resolve=>release=resolve);p.enabled=changes[0].enabled;}},['tryHookChatEvents']);
    a.tryHookChatEvents();let requestAllowed=false;const pending=callbacks.sent().then(()=>{requestAllowed=true;});await new Promise(setImmediate);assert.equal(requestAllowed,false);release();await pending;assert.equal(requestAllowed,true);assert.equal(p.enabled,true);
});
test('pre-send event waits for an ongoing auto-filter pass then rechecks current chat',async()=>{
    const callbacks={};let release;let calls=0;const p={identifier:'p',enabled:false};
    const s={autoFilterOnSendClick:true,autoFilters:[{enabled:true,condition:{depth:0},effect:{mode:'manual',manualPrompts:['p']},action:'enable'}],folderDisabled:{}};
    const a=load('auto-filter',{settings:()=>s,event_types:{MESSAGE_SENT:'sent'},eventSource:{on:(key,fn)=>callbacks[key]=fn},liveCache:[p],isExcludedFromAutoFilter:()=>false,isFolderExcludedFromAutoFilter:()=>false,isFilterGroupDisabled:()=>false,isPromptLogicallyEnabled:p=>p.enabled,setPromptsLogicalState:async changes=>{if(changes.length){calls++;if(calls===1)await new Promise(resolve=>release=resolve);p.enabled=changes[0].enabled;}}},['tryHookChatEvents','evaluateAutoFilters']);
    a.tryHookChatEvents();const background=a.evaluateAutoFilters();await new Promise(setImmediate);s.autoFilters[0].action='disable';const sending=callbacks.sent();release();await background;await sending;assert.equal(p.enabled,false);assert.equal(calls,2);
});
