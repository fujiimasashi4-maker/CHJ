const words = {
  ja: {
    title:'コメント・写真', note:'コメントと写真は、運営側の確認後に掲載します。表示名はニックネームでも構いません。',
    privacy:'個人を特定できる患者情報は投稿しないでください。写真は掲載の許可があるものをご使用ください。',
    name:'表示名', nameHint:'80文字以内', comment:'コメント', commentHint:'2,000文字以内。コメントまたは写真のどちらかを入力してください。',
    photo:'写真（任意・1枚）', photoHint:'JPEG・PNG・WebP。投稿前に縮小し、画像に含まれる位置情報などのメタデータを除去します。',
    remove:'写真を外す', submit:'確認用に投稿する', sending:'投稿しています…', processing:'写真を準備しています…',
    empty:'まだ公開されたコメントはありません。', loading:'コメントを読み込んでいます…', more:'さらに表示',
    unavailable:'現在、コメント機能を利用できません。時間をおいて再度お試しください。',
    preview:'この確認ページでは投稿できません。コメント・写真の投稿は公式サイトでご利用ください。', official:'公式サイトのお知らせを開く',
    accepted:'受け付けました。コメントと写真は、運営側の確認後に掲載されます。', failed:'投稿できませんでした。入力内容は残しています。時間をおいて再度お試しください。',
    content:'コメントまたは写真を追加してください。', invalid_photo:'JPEG・PNG・WebPの写真を選んでください。',
    photo_too_large:'写真が大きすぎます。15MB以下の写真を選んでください。', image_failed:'この写真を読み込めませんでした。JPEG・PNG・WebPの別の写真を選んでください。',
    rate_limited:'短時間の投稿回数の上限に達しました。時間をおいて再度お試しください。', invalid_name:'表示名を80文字以内で入力してください。',
    invalid_comment:'コメントは2,000文字以内にしてください。', photoAlt:'投稿された写真', selectedAlt:'選択した写真のプレビュー', ready:'写真の準備ができました。',
    retry:'再読み込み',
  },
  en: {
    title:'Comments & photos', note:'Comments and photos appear after review by CHJ. You may use a nickname.',
    privacy:'Do not post identifiable patient information. Only upload photos you have permission to publish.',
    name:'Display name', nameHint:'Up to 80 characters', comment:'Comment', commentHint:'Up to 2,000 characters. Add a comment or a photo.',
    photo:'Photo (optional, one image)', photoHint:'JPEG, PNG or WebP. Photos are resized and embedded metadata, such as location, is removed before upload.',
    remove:'Remove photo', submit:'Submit for review', sending:'Submitting…', processing:'Preparing photo…',
    empty:'No comments have been published yet.', loading:'Loading comments…', more:'Show more',
    unavailable:'Comments are currently unavailable. Please try again later.',
    preview:'Posting is unavailable on this preview. Visit the official website to submit comments and photos.', official:'Open the official news page',
    accepted:'Thank you. Your comment and photo will appear after review by CHJ.', failed:'We could not submit your post. Your input has been kept. Please try again later.',
    content:'Please add a comment or a photo.', invalid_photo:'Please select a JPEG, PNG or WebP photo.',
    photo_too_large:'Please select a photo smaller than 15 MB.', image_failed:'This photo could not be opened. Please select another JPEG, PNG or WebP image.',
    rate_limited:'You have reached the posting limit. Please try again later.', invalid_name:'Enter a display name of up to 80 characters.',
    invalid_comment:'Comments must be no longer than 2,000 characters.', photoAlt:'Photo submitted with a comment', selectedAlt:'Preview of your selected photo', ready:'Your photo is ready.',
    retry:'Reload comments',
  }
};

function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  if (className) el.className = className;
  return el;
}

async function fetchTimed(url,options={}) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),25000);
  try{return await fetch(url,{...options,signal:controller.signal});}
  finally{clearTimeout(timer);}
}

async function preparePhoto(file) {
  if (!['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('invalid_photo');
  if (file.size > 15 * 1024 * 1024) throw new Error('photo_too_large');
  let image;
  try { image = await createImageBitmap(file, {imageOrientation:'from-image'}); }
  catch { throw new Error('image_failed'); }
  try {
    if (image.width * image.height > 50000000) throw new Error('image_failed');
    const canvas = document.createElement('canvas');
    const ratio = Math.min(1,1600/Math.max(image.width,image.height));
    canvas.width = Math.max(1,Math.round(image.width*ratio));
    canvas.height = Math.max(1,Math.round(image.height*ratio));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0,0,canvas.width,canvas.height);
    context.drawImage(image,0,0,canvas.width,canvas.height);
    for (const quality of [.85,.7,.5,.35]) {
      const blob = await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
      if (blob && blob.size <= 750000) return blob;
    }
    throw new Error('photo_too_large');
  } finally { image.close(); }
}

function initDiscussion(root,index) {
  const lang = root.dataset.language === 'en' ? 'en' : 'ja';
  const t = words[lang];
  const news = root.dataset.newsId;
  const uid = 'news-comment-'+index;
  root.append(element('h4',t.title));
  root.append(element('p',t.note,'comment-note'));
  const loadStatus = element('p',t.loading,'comments-status');
  loadStatus.setAttribute('role','status');
  root.append(loadStatus);
  const retry=element('button',t.retry);retry.type='button';retry.hidden=true;root.append(retry);
  const list = element('div',null,'comment-list');
  list.setAttribute('aria-label',t.title);
  root.append(list);
  const more = element('button',t.more,'comment-more');
  more.type = 'button'; more.hidden = true;
  root.append(more);
  const form = element('form',null,'comment-form');
  function field(label,type,hint) {
    const wrap = element('div');
    const control = element(type==='textarea'?'textarea':'input');
    const id = uid+'-'+type;
    control.id = id;
    if(type!=='textarea') control.type = type;
    const labelEl = element('label',label); labelEl.htmlFor = id;
    wrap.append(labelEl,control);
    if(hint){const small=element('small',hint);small.id=id+'-hint';wrap.append(small);control.setAttribute('aria-describedby',small.id);}
    form.append(wrap);
    return control;
  }
  const name=field(t.name,'text',t.nameHint);name.name='name';name.required=true;name.maxLength=80;name.autocomplete='nickname';
  const comment=field(t.comment,'textarea',t.commentHint);comment.name='comment';comment.maxLength=2000;
  const photo=field(t.photo,'file',t.photoHint);photo.name='photo';photo.accept='image/jpeg,image/png,image/webp';
  const imagePreview=element('img',null,'photo-preview');imagePreview.alt=t.selectedAlt;imagePreview.hidden=true;form.append(imagePreview);
  const remove=element('button',t.remove,'photo-remove');remove.type='button';remove.hidden=true;form.append(remove);
  const trap=element('div',null,'comment-trap');trap.setAttribute('aria-hidden','true');
  const website=element('input');website.name='website';website.type='text';website.tabIndex=-1;website.autocomplete='off';trap.append(website);form.append(trap);
  form.append(element('p',t.privacy,'comment-note'));
  const send=element('button',t.submit);send.type='submit';send.disabled=true;form.append(send);
  const status=element('p',null,'comments-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');form.append(status);
  root.append(form);
  let photoBlob=null,previewUrl=null,processing=false,busy=false,available=false,nextCursor=null,photoVersion=0,requestId=crypto.randomUUID();
  form.addEventListener('input',()=>{requestId=crypto.randomUUID();});
  function updateButton(){send.disabled=!available||processing||busy;for(const control of [name,comment,photo,remove])control.disabled=busy;}
  function show(message,state=''){status.textContent=message;status.dataset.state=state;}
  function clearPhoto(){photoBlob=null;photo.value='';imagePreview.hidden=true;remove.hidden=true;if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=null;}
  remove.addEventListener('click',()=>{requestId=crypto.randomUUID();photoVersion++;processing=false;clearPhoto();show('');updateButton();});
  photo.addEventListener('change',async()=>{
    const file=photo.files[0];const version=++photoVersion;
    if(!file){processing=false;clearPhoto();updateButton();return;}
    processing=true;updateButton();show(t.processing);
    try {
      const blob=await preparePhoto(file);
      if(version!==photoVersion)return;
      if(previewUrl)URL.revokeObjectURL(previewUrl);
      photoBlob=blob;previewUrl=URL.createObjectURL(blob);imagePreview.src=previewUrl;imagePreview.hidden=false;remove.hidden=false;show(t.ready);
    } catch(error){if(version===photoVersion){clearPhoto();show(t[error.message]||t.image_failed,'error');}}
    finally{if(version===photoVersion){processing=false;updateButton();}}
  });
  function renderComment(entry){
    const card=element('article',null,'reader-comment');
    const header=element('header');header.append(element('strong',entry.name));
    const date=new Date(entry.created_at);
    if(!Number.isNaN(date.getTime())){const time=element('time',new Intl.DateTimeFormat(lang==='en'?'en-GB':'ja-JP',{dateStyle:'medium',timeZone:'Asia/Tokyo'}).format(date));time.dateTime=date.toISOString();header.append(time);}
    card.append(header,element('p',entry.comment));
    if(entry.photo_url){
      const url=new URL(entry.photo_url,location.origin);
      if(url.origin===location.origin&&/^\/api\/photos\/[a-zA-Z0-9-]+$/.test(url.pathname)){
        const a=element('a');a.href=url.href;a.target='_blank';a.rel='noopener';
        const image=element('img');image.src=url.href;image.alt=t.photoAlt;image.loading='lazy';a.append(image);card.append(a);
      }
    }
    list.append(card);
  }
  async function load(append=false){
    more.disabled=true;
    try{
      const params=new URLSearchParams({news,limit:'20'});if(append&&nextCursor)params.set('cursor',nextCursor);
      const response=await fetchTimed('/api/comments?'+params,{headers:{Accept:'application/json'},cache:'no-store'});
      if(!response.ok)throw new Error('unavailable');
      const result=await response.json();if(!Array.isArray(result.comments))throw new Error('unavailable');
      if(!append)list.replaceChildren();
      result.comments.forEach(renderComment);nextCursor=result.next_cursor||null;
      more.hidden=!nextCursor;loadStatus.textContent=list.children.length?'':t.empty;
      retry.hidden=true;available=true;updateButton();
    }catch{
      if(!append){available=false;retry.hidden=false;updateButton();loadStatus.textContent=t.unavailable;}
      else{loadStatus.textContent=t.unavailable;}
    }finally{more.disabled=false;}
  }
  more.addEventListener('click',()=>load(true));
  retry.addEventListener('click',()=>load());
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(!available||processing||busy||!form.reportValidity())return;
    if(!comment.value.trim()&&!photoBlob){show(t.content,'error');comment.focus();return;}
    busy=true;updateButton();send.textContent=t.sending;show('');
    const data=new FormData();data.set('news',news);data.set('name',name.value.trim());data.set('comment',comment.value.trim());data.set('website',website.value);data.set('request_id',requestId);
    if(photoBlob)data.set('photo',photoBlob,'photo.jpg');
    try{
      const response=await fetchTimed('/api/comments',{method:'POST',body:data,headers:{Accept:'application/json'}});
      const result=await response.json();
      if(!response.ok||result.status!=='pending'){show(t[result.error]||t.failed,'error');return;}
      requestId=crypto.randomUUID();comment.value='';clearPhoto();show(t.accepted,'success');
    }catch{show(t.failed,'error');}
    finally{busy=false;send.textContent=t.submit;updateButton();}
  });
  if(location.hostname.endsWith('github.io')){
    loadStatus.textContent=t.preview;
    const official=element('a',t.official);official.href='https://chjapan.com/'+(lang==='en'?'en/':'')+'#event-news';loadStatus.append(document.createTextNode(' '),official);
  }else load();
}

document.querySelectorAll('[data-news-id]').forEach(initDiscussion);
