import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../preview/assets/comments-admin.js',import.meta.url),'utf8');
class Element{
 constructor(tag){this.tagName=tag;this.children=[];this.listeners={};this.textContent='';this.dataset={};this.attributes={};this.hidden=false;this.disabled=false;}
 append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
 replaceChildren(...nodes){this.children=[];this.append(...nodes);}
 addEventListener(event,callback){this.listeners[event]=callback;}
 setAttribute(key,value){this.attributes[key]=String(value);}
 querySelectorAll(tag){return this.children.flatMap(child=>[...(child.tagName===tag?[child]:[]),...child.querySelectorAll(tag)]);}
 remove(){this.parent.children=this.parent.children.filter(child=>child!==this);}
 showModal(){this.open=true;}close(){this.open=false;this.listeners.close?.();}focus(){}
}
const ID='6acbf168-a1ad-4b8b-8392-1f670c25db54';
const comment={id:ID,name:'Local test',comment:'Review <script>not markup</script>',news:'fsf-ashiya-2026-12-12',created_at:'2026-11-20T00:00:00Z',moderated_at:null,status:'pending'};
async function setup({save=()=>Response.json({id:ID,status:'approved',moderated_at:'2026-11-20T01:00:00Z'}),photo=false}={}){
 const ids=['admin-status','moderation-list','review-status','refresh','admin-more','pending-count','approved-count','rejected-count','count-pending','count-approved','count-rejected','last-updated','login-help','review-dialog','review-title','review-body','review-message','review-confirm','review-cancel'];
 const elements=Object.fromEntries(ids.map(id=>[id,new Element('div')]));elements['review-status'].value='pending';elements['review-dialog'].open=false;
 let failLoad=false;const posts=[];
 const context={document:{visibilityState:'visible',getElementById:id=>elements[id],createElement:tag=>new Element(tag),addEventListener(){}},URL,URLSearchParams,Intl,Date,AbortController,setTimeout,clearTimeout,location:{origin:'https://chjapan.com'},fetch:async(url,options)=>{
  if(options?.method==='POST'){posts.push(JSON.parse(options.body));return save();}
  if(failLoad)return new Response('Unavailable',{status:503});
  return Response.json({comments:[{...comment,...(photo?{photo_url:'/api/admin/photos/'+ID}:{})}],next_cursor:null,counts:{pending:25,approved:4,rejected:2,total:31}});
 }};
 await vm.runInNewContext(source,context);const card=elements['moderation-list'].children[0];assert.ok(card,'Pending card must load');
 const publish=card.querySelectorAll('button').find(button=>/公開/.test(button.textContent));
 return {elements,posts,publish,failLoads(){failLoad=true;}};
}
test('opening a review sends nothing; cancel preserves the post',async()=>{
 const {elements,posts,publish}=await setup();await publish.listeners.click();assert.equal(posts.length,0,'Opening a review must never publish');assert.equal(elements['review-dialog'].open,true);await elements['review-cancel'].listeners.click();assert.equal(posts.length,0);assert.equal(elements['moderation-list'].children.length,1);
});
test('confirmation submits the reviewed revision and checks matching JSON',async()=>{
 const {elements,posts,publish}=await setup();await publish.listeners.click();await elements['review-confirm'].listeners.click();assert.deepEqual(posts,[{status:'approved',expected_status:'pending',expected_moderated_at:null}]);assert.match(elements['admin-status'].textContent,/公開しました/);assert.equal(elements['review-dialog'].open,false);
});
for(const [name,save] of [['login HTML',()=>new Response('<html>Sign in</html>',{status:200,headers:{'content-type':'text/html'}})],['another comment',()=>Response.json({id:'another-comment',status:'approved'})]])test(name+' never reports publication or removes the pending card',async()=>{
 const {elements,publish}=await setup({save});await publish.listeners.click();await elements['review-confirm'].listeners.click();assert.equal(elements['moderation-list'].children.length,1);assert.equal(elements['review-dialog'].open,true);assert.doesNotMatch(elements['admin-status'].textContent,/公開しました/);assert.match(elements['review-message'].textContent,/保存結果|ログイン/);
});
test('stale review disables retry and instructs reloading',async()=>{
 const {elements,publish}=await setup({save:()=>Response.json({error:'state_conflict'},{status:409})});await publish.listeners.click();await elements['review-confirm'].listeners.click();assert.equal(elements['review-confirm'].disabled,true);assert.match(elements['review-message'].textContent,/別の画面|更新/);assert.equal(elements['moderation-list'].children.length,1);
});
test('counts cover all records; failed filter clears stale cards',async()=>{
 const ui=await setup();assert.equal(String(ui.elements['pending-count'].textContent),'25');ui.failLoads();ui.elements['review-status'].value='approved';await ui.elements['review-status'].listeners.change();assert.equal(ui.elements['moderation-list'].children.length,0);assert.match(ui.elements['admin-status'].textContent,/読み込めません/);
});
test('photo must load before publish confirmation is enabled',async()=>{
 const {elements,publish}=await setup({photo:true});await publish.listeners.click();assert.equal(elements['review-confirm'].disabled,true);const img=elements['review-body'].querySelectorAll('img')[0];await img.listeners.error();assert.equal(elements['review-confirm'].disabled,true);assert.match(elements['review-message'].textContent,/写真/);await img.listeners.load();assert.equal(elements['review-confirm'].disabled,false);
});
