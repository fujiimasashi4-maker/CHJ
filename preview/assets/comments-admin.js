const status=document.getElementById('admin-status');
const list=document.getElementById('moderation-list');
const filter=document.getElementById('review-status');
const refresh=document.getElementById('refresh');
const more=document.getElementById('admin-more');
let cursor=null,busy=false;
function el(tag,text){const node=document.createElement(tag);if(text)node.textContent=text;return node;}
async function fetchTimed(url,options={}){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),25000);try{return await fetch(url,{...options,signal:controller.signal});}finally{clearTimeout(timer);}}
function controls(disabled){busy=disabled;filter.disabled=disabled;refresh.disabled=disabled;more.disabled=disabled;list.querySelectorAll('button').forEach(button=>button.disabled=disabled);}
async function load(append=false){
  if(busy)return;controls(true);status.textContent='読み込んでいます…';
  try{
    const params=new URLSearchParams({status:filter.value,limit:'20'});if(append&&cursor)params.set('cursor',cursor);
    const response=await fetchTimed('/api/admin/comments?'+params,{headers:{Accept:'application/json'},cache:'no-store'});
    if(!response.ok)throw new Error('認証または設定を確認してください。');
    const data=await response.json();if(!Array.isArray(data.comments))throw new Error('管理者ログインが必要です。');
    if(!append)list.replaceChildren();
    for(const comment of data.comments)render(comment);
    cursor=data.next_cursor||null;more.hidden=!cursor;
    status.textContent=list.children.length?'':'該当する投稿はありません。';
  }catch(error){status.textContent='管理画面を読み込めません。Cloudflare Accessの管理者ログインと接続設定を確認し、再読み込みしてください。';}
  finally{controls(false);}
}
function render(comment){
  const card=el('article');card.className='moderation-card';
  const header=el('header');header.append(el('strong',comment.name));
  const date=new Date(comment.created_at);if(!Number.isNaN(date.getTime())){const time=el('time',new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Tokyo'}).format(date));time.dateTime=date.toISOString();header.append(time);}
  card.append(header,el('p',comment.comment));
  if(comment.photo_url){const url=new URL(comment.photo_url,location.origin);if(url.origin===location.origin&&/^\/api\/admin\/photos\/[a-zA-Z0-9-]+$/.test(url.pathname)){const link=el('a');link.href=url.href;link.target='_blank';link.rel='noopener';const image=el('img');image.src=url.href;image.alt='投稿された写真（公開前の確認用）';image.loading='lazy';link.append(image);card.append(link);}}
  const buttons=el('footer');
  for(const [value,label] of [['approved','公開する'],['rejected','非公開にする']]){
    if(comment.status===value)continue;
    const button=el('button',label);button.type='button';if(value==='rejected')button.className='reject';
    button.addEventListener('click',async()=>{
      if(busy)return;controls(true);status.textContent='保存しています…';
      try{
        const response=await fetchTimed('/api/admin/comments/'+encodeURIComponent(comment.id),{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({status:value})});
        if(!response.ok)throw new Error('failed');
        const saved=await response.json();
        if(saved.id!==comment.id||saved.status!==value)throw new Error('failed');
        card.remove();status.textContent=value==='approved'?'公開しました。日本語版・英語版のニュースに表示されます。':'非公開にしました。';
      }catch{status.textContent='保存できませんでした。再読み込みして状態を確認してください。';}
      finally{controls(false);}
    });buttons.append(button);
  }
  card.append(buttons);list.append(card);
}
filter.addEventListener('change',()=>load());refresh.addEventListener('click',()=>load());more.addEventListener('click',()=>load(true));
load();
