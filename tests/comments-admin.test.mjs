import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../preview/assets/comments-admin.js',import.meta.url),'utf8');
class Element{
  constructor(tag){this.tagName=tag;this.children=[];this.listeners={};this.textContent='';}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
  replaceChildren(){this.children=[];}
  addEventListener(event,callback){this.listeners[event]=callback;}
  querySelectorAll(tag){return this.children.flatMap(child=>[...(child.tagName===tag?[child]:[]),...child.querySelectorAll(tag)]);}
  remove(){this.parent.children=this.parent.children.filter(child=>child!==this);}
}
async function moderation(response){
  const elements=Object.fromEntries(['admin-status','moderation-list','review-status','refresh','admin-more'].map(id=>[id,new Element('div')]));
  elements['review-status'].value='pending';
  const comment={id:'6acbf168-a1ad-4b8b-8392-1f670c25db54',name:'Local test',comment:'Review',created_at:'2026-11-20T00:00:00Z',status:'pending'};
  const context={document:{getElementById:id=>elements[id],createElement:tag=>new Element(tag)},URL,URLSearchParams,Intl,Date,AbortController,setTimeout,clearTimeout,location:{origin:'https://chjapan.com'},fetch:async(url,options)=>options?.method==='POST'?response():Response.json({comments:[comment],next_cursor:null})};
  await vm.runInNewContext(source,context);
  const card=elements['moderation-list'].children[0];
  assert.ok(card,'Pending card must load before moderation');
  const publish=card.querySelectorAll('button').find(button=>button.textContent==='公開する');
  await publish.listeners.click();
  return elements;
}
test('login HTML returned with HTTP 200 never claims publication or removes the pending card',async()=>{
  const el=await moderation(()=>new Response('<html>Sign in</html>',{status:200,headers:{'content-type':'text/html'}}));
  assert.equal(el['moderation-list'].children.length,1);
  assert.match(el['admin-status'].textContent,/保存できませんでした/);
});
test('a JSON response for another comment never claims publication',async()=>{
  const el=await moderation(()=>Response.json({id:'another-comment',status:'approved'}));
  assert.equal(el['moderation-list'].children.length,1);
  assert.match(el['admin-status'].textContent,/保存できませんでした/);
});
test('a matching saved status removes the pending card and reports publication',async()=>{
  const el=await moderation(()=>Response.json({id:'6acbf168-a1ad-4b8b-8392-1f670c25db54',status:'approved'}));
  assert.equal(el['moderation-list'].children.length,0);
  assert.match(el['admin-status'].textContent,/^公開しました/);
});
