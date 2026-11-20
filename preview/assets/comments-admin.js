const byId=id=>document.getElementById(id);
const status=byId('admin-status'),list=byId('moderation-list'),filter=byId('review-status'),refresh=byId('refresh'),more=byId('admin-more');
const dialog=byId('review-dialog'),dialogBody=byId('review-body'),dialogMessage=byId('review-message'),confirmButton=byId('review-confirm'),cancelButton=byId('review-cancel');
const notificationStatus=byId('notification-status'),notificationRetry=byId('notification-retry'),notificationResult=byId('notification-result');
const labels={pending:'確認待ち',approved:'公開済み',rejected:'非公開'};
const news={ 'fsf-ashiya-2026-12-12':{title:'ファイブスターフェス in 芦屋中央病院',href:'/#events'} };
let cursor=null,busy=false,review=null,notifications=null;
function validNotifications(value){return value&&typeof value.enabled==='boolean'&&typeof value.configured==='boolean'&&['queued','retry_wait','sending','accepted'].every(key=>Number.isSafeInteger(value[key])&&value[key]>=0);}
function setNotifications(value){
 notifications=validNotifications(value)?value:null;
 if(!notifications)notificationStatus.textContent='メール通知の状態を取得できません。最新の投稿を確認して状態を読み直してください。';
 else{
  const state=!value.enabled?'メール通知はまだ有効になっていません。':!value.configured?'メール通知の接続設定が未完了です。':'メール通知は有効です。';
  notificationStatus.textContent=state+' 未送信 '+value.queued+'件 ／ 再試行待ち '+value.retry_wait+'件 ／ 送信処理中 '+value.sending+'件 ／ 送信受付済み '+value.accepted+'件。';
 }
 notificationRetry.disabled=busy||!!review||!notifications?.enabled||!notifications?.configured||notifications.queued===0;
}
function el(tag,text){const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);return node;}
function dateText(value){const date=new Date(value);return value&&!Number.isNaN(date.getTime())?new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Tokyo'}).format(date):'未処理';}
async function fetchTimed(url,options={}){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),25000);try{return await fetch(url,{...options,signal:controller.signal,cache:'no-store',credentials:'same-origin'});}finally{clearTimeout(timer);}}
async function readJSON(response){if(response.status===401||response.status===403||!/^application\/json\b/i.test(response.headers.get('content-type')||''))throw new Error('login');if(!response.ok)throw new Error('request');return response.json();}
function controls(disabled){
 busy=disabled;filter.disabled=disabled;refresh.disabled=disabled;more.disabled=disabled;
 for(const key of Object.keys(labels))byId('count-'+key).disabled=disabled;
 list.querySelectorAll('button').forEach(button=>button.disabled=disabled);
 cancelButton.disabled=disabled;confirmButton.disabled=disabled||!review||review.stale||(review.value==='approved'&&!review.photoReady);
 notificationRetry.disabled=disabled||!!review||!notifications?.enabled||!notifications?.configured||notifications.queued===0;
}
function setCounts(counts){for(const key of Object.keys(labels))byId(key+'-count').textContent=counts?String(counts[key]):'—';}
async function load(append=false,notice=''){
 if(busy||dialog.open)return;controls(true);status.textContent='読み込んでいます…';byId('login-help').hidden=true;
 if(!append){list.replaceChildren();cursor=null;more.hidden=true;}
 try{
  const params=new URLSearchParams({status:filter.value,limit:'20'});if(append&&cursor)params.set('cursor',cursor);
  const data=await readJSON(await fetchTimed('/api/admin/comments?'+params,{headers:{Accept:'application/json'}}));
  if(!Array.isArray(data.comments)||!data.counts||Object.keys(labels).some(k=>!Number.isSafeInteger(data.counts[k])||data.counts[k]<0))throw new Error('response');
  const seen=new Set(Array.from(list.children,card=>card.dataset.id));
  for(const comment of data.comments)if(!seen.has(comment.id)){render(comment);seen.add(comment.id);}
  cursor=data.next_cursor||null;more.hidden=!cursor;setCounts(data.counts);setNotifications(data.notifications);
  byId('last-updated').textContent='最終更新：'+dateText(new Date().toISOString())+'（日本時間）';
  status.textContent=notice||(list.children.length?labels[filter.value]+' '+data.counts[filter.value]+'件のうち '+list.children.length+'件を表示しています。':'該当する投稿はありません。');
 }catch(error){
  if(!append){setCounts(null);setNotifications(null);}
  status.textContent=(notice?notice+' ただし一覧を更新できませんでした。':'管理画面を読み込めません。')+' 接続を確認して再読み込みしてください。ログインの有効期限が切れている場合はログインし直してください。';
  byId('login-help').hidden=false;
 }finally{controls(false);}
}
function photoURL(comment){try{const url=new URL(comment.photo_url,location.origin);return url.origin===location.origin&&/^\/api\/admin\/photos\/[a-zA-Z0-9-]+$/.test(url.pathname)?url.href:null;}catch{return null;}}
function content(comment,forReview=false){
 const section=el('section');const header=el('header');header.append(el('strong',comment.name),el('span',labels[comment.status]||'不明'));
 const context=news[comment.news];const subject=el('p');subject.className='post-context';const link=el('a',context?.title||'ニュースへの投稿');link.href=context?.href||'/#events';link.target='_blank';link.rel='noopener';subject.append(link);
 const dates=el('p','受付：'+dateText(comment.created_at)+' ／ 最終処理：'+dateText(comment.moderated_at));dates.className='post-meta';
 const text=el('p',comment.comment||'（コメントなし・写真のみ）');text.className='post-text';
 section.append(header,subject,dates,text);
 if(comment.photo_url){
  const url=photoURL(comment);
  if(url){const link=el('a');link.href=url;link.target='_blank';link.rel='noopener';link.setAttribute('aria-label','写真を別のタブで拡大');const image=el('img');image.alt='投稿された写真（運営者の確認用）';image.loading=forReview?'eager':'lazy';
   if(forReview){const current=review;const loaded=()=>{if(review===current){review.photoReady=true;dialogMessage.textContent='本文と写真を確認してから確定してください。';controls(busy);}};image.addEventListener('load',loaded);image.addEventListener('error',()=>{if(review===current){review.photoReady=false;dialogMessage.textContent='写真を読み込めません。閉じて再読み込み、またはログインし直してから写真を確認してください。';controls(busy);}});image.src=url;if(image.complete&&image.naturalWidth>0)loaded();}else image.src=url;
   link.append(image);section.append(link,el('p','写真を押すと別のタブで拡大できます。'));
  }else if(forReview){dialogMessage.textContent='写真のURLを確認できません。公開せず、再読み込みしてください。';}
 }
 const id=el('p','投稿ID：'+comment.id);id.className='post-id';section.append(id);return section;
}
function openReview(comment,value){
 if(busy||dialog.open)return;
 review={comment,value,stale:false,photoReady:!comment.photo_url};
 byId('review-title').textContent=value==='approved'?'公開する内容の確認':'非公開にする投稿の確認';
 dialogMessage.textContent=value==='approved'?'表示名・本文・写真が日本語版と英語版の両方に公開されます。内容を確認して確定してください。':'この投稿はサイトに表示されなくなります。後から再公開できます。';
 confirmButton.textContent=value==='approved'?'この内容で公開する':'非公開にする';
 dialogBody.replaceChildren(content(comment,true));dialog.showModal();controls(false);cancelButton.focus();
}
function render(comment){
 const card=el('article');card.className='moderation-card';card.dataset.id=comment.id;card.append(content(comment));
 const buttons=el('footer');
 for(const [value,label] of [['approved','確認して公開'],['rejected','非公開にする']]){
  if(comment.status===value)continue;
  const button=el('button',label);button.type='button';if(value==='rejected')button.className='reject';button.addEventListener('click',()=>openReview(comment,value));buttons.append(button);
 }
 card.append(buttons);list.append(card);
}
confirmButton.addEventListener('click',async()=>{
 if(busy||!review||review.stale||(review.value==='approved'&&!review.photoReady))return;
 const current=review;controls(true);dialogMessage.textContent='保存しています…';
 try{
  const response=await fetchTimed('/api/admin/comments/'+encodeURIComponent(current.comment.id),{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({status:current.value,expected_status:current.comment.status,expected_moderated_at:current.comment.moderated_at??null})});
  if(response.status===409){current.stale=true;dialogMessage.textContent='別の画面でこの投稿の状態が更新されました。閉じて一覧を再読み込みし、最新の内容を確認してください。';return;}
  const saved=await readJSON(response);
  if(saved.id!==current.comment.id||saved.status!==current.value||typeof saved.moderated_at!=='string')throw new Error('response');
  const notice=current.value==='approved'?'公開しました。日本語版・英語版のニュースに表示されます。':'非公開にしました。';
  dialog.close();controls(false);await load(false,notice);
 }catch(error){
  current.stale=true;dialogMessage.textContent=error.message==='login'?'ログインの有効期限が切れた可能性があります。閉じてログインし直し、一覧で保存結果を確認してください。':'保存結果を確認できません。閉じて一覧を再読み込みし、状態を確認してください。';byId('login-help').hidden=false;
 }finally{controls(false);}
});
cancelButton.addEventListener('click',()=>{if(!busy)dialog.close();});
dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
dialog.addEventListener('close',()=>{review=null;controls(busy);});
notificationRetry.addEventListener('click',async()=>{
 if(busy||dialog.open||!notifications?.enabled||!notifications?.configured||notifications.queued===0)return;
 controls(true);notificationResult.textContent='未送信の通知を処理しています…';
 try{
  const data=await readJSON(await fetchTimed('/api/admin/notifications/retry',{method:'POST',headers:{Accept:'application/json'}}));
  if(!validNotifications(data.notifications)||![0,1].includes(data.attempted))throw new Error('response');
  setNotifications(data.notifications);
  notificationResult.textContent=data.attempted?'通知を1件処理しました。上の送信状況をご確認ください。「送信受付済み」は受信箱への到着を保証するものではありません。':'再試行できる通知はありません。再試行待ちの通知は、時間をおいてから最新の状態をご確認ください。';
 }catch{notificationResult.textContent='通知の処理結果を確認できません。最新の投稿を確認して送信状況を読み直してください。必要に応じてログインし直してください。';setNotifications(null);byId('login-help').hidden=false;}
 finally{controls(false);}
});
filter.addEventListener('change',()=>load());refresh.addEventListener('click',()=>load());more.addEventListener('click',()=>load(true));
for(const key of Object.keys(labels))byId('count-'+key).addEventListener('click',()=>{filter.value=key;return load();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&!busy&&!dialog.open)load();});
load();
