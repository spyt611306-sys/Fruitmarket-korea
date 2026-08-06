(()=>{
'use strict';
if(window.__MATCHSIK_PUBLIC_CATALOG_V281__)return;window.__MATCHSIK_PUBLIC_CATALOG_V281__=true;
const cfg=()=>window.MATCHSIK_CONFIG||window.matchsikConfig||{};
const base=()=>String(cfg().apiBaseUrl||'').replace(/\/$/,'');
const key=()=>String(cfg().supabasePublishableKey||cfg().publishableKey||'').trim();
const apiUrl=(path)=>base()+'/api/'+String(path||'').replace(/^\/+/, '').replace(/^api\//,'');
const esc=(value)=>String(value??'').replace(/[&<>'"]/g,(ch)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[ch]));
let catalog=[];let teachers=[];let selectedCert='';let selectedCourse='';
const fallbackSchedule={
  code:'electric-craftsman',name:'전기기능사',allowed_courses:['필기'],source_label:'Q-Net 2026 공식 일정 · 2027 예상 일정',
  exam_schedule:{
    2026:[
      {round:1,apply:'2026-01-06~2026-01-09',exam:'2026-01-20~2026-01-24',result:'2026-01-30',start:'2026-01-20',official:true},
      {round:2,apply:'2026-03-16~2026-03-20',exam:'2026-04-04~2026-04-09',result:'2026-04-22',start:'2026-04-04',official:true},
      {round:3,apply:'2026-06-08~2026-06-11',exam:'2026-06-27~2026-07-02',result:'2026-07-15',start:'2026-06-27',official:true},
      {round:4,apply:'2026-08-24~2026-08-27',exam:'2026-09-16~2026-09-21',result:'2026-10-07',start:'2026-09-16',official:true}
    ],
    2027:[
      {round:1,apply:'2027-01-05~2027-01-08',exam:'2027-01-19~2027-01-23',result:'2027-01-29',start:'2027-01-19',official:false,estimated:true},
      {round:2,apply:'2027-03-15~2027-03-19',exam:'2027-04-03~2027-04-08',result:'2027-04-21',start:'2027-04-03',official:false,estimated:true},
      {round:3,apply:'2027-06-07~2027-06-10',exam:'2027-06-26~2027-07-01',result:'2027-07-14',start:'2027-06-26',official:false,estimated:true},
      {round:4,apply:'2027-08-23~2027-08-26',exam:'2027-09-15~2027-09-20',result:'2027-10-06',start:'2027-09-15',official:false,estimated:true}
    ]
  }
};
async function get(path){const response=await fetch(apiUrl(path),{headers:{...(key()?{apikey:key()}:{}),'content-type':'application/json'},cache:'no-store'});if(!response.ok)throw new Error('load failed');return response.json()}
function findElectric(){return catalog.find((row)=>row.code==='electric-craftsman')||fallbackSchedule}
function addToCertificateLists(){
  const list=document.querySelector('#certList,[data-cert-list]');if(!list||list.querySelector('[data-cert="전기기능사"]'))return;
  const button=document.createElement('button');button.className='cert-item';button.type='button';button.dataset.cert='전기기능사';button.dataset.category='기능사';button.innerHTML='<span class="tag">기능사</span><strong>전기기능사</strong><span class="arrow">→</span>';
  list.appendChild(button);const count=document.querySelector('#certCount');if(count){const n=Number.parseInt(count.textContent)||0;count.textContent=`${n+1}개`}
  const grid=document.querySelector('#courseGrid,[data-course-grid]');if(grid&&!grid.querySelector('[data-cert="전기기능사"]')){const card=button.cloneNode(true);card.classList.add('course-mini');grid.appendChild(card)}
}
function courseGuard(){
 if(selectedCert!=='전기기능사')return;
 document.querySelectorAll('[data-course]').forEach((button)=>{
   const invalid=button.dataset.course!=='필기';button.disabled=invalid;button.setAttribute('aria-disabled',String(invalid));
   if(invalid){button.style.opacity='.38';button.style.filter='grayscale(1)';button.title='전기기능사는 필기 과정만 운영합니다.'}
 });
}
function schedulePanel(){
 if(selectedCert!=='전기기능사')return;
 const host=document.querySelector('#stepContent,[data-step-content]');if(!host||host.querySelector('[data-v28-electric-schedule]'))return;
 const cert=findElectric();const now=new Date();now.setHours(0,0,0,0);
 const panel=document.createElement('section');panel.className='panel';panel.dataset.v28ElectricSchedule='1';panel.style.marginTop='16px';
 const rows=Object.entries(cert.exam_schedule||{}).flatMap(([year,items])=>(items||[]).map((item)=>({...item,year:Number(year)})));
 panel.innerHTML=`<div class="m28-assignment-card-head"><div><span class="panel-kicker">ELECTRIC CRAFTSMAN · WRITTEN</span><h3 style="margin:5px 0 0">전기기능사 필기 시험 일정</h3></div><span class="m28-written-only-badge">실기 미운영</span></div><p style="color:#687d77;line-height:1.65">2026년은 Q-Net 공식 일정이며, 2027년은 공식 공고 전 예상 일정입니다. 지난 시험은 선택할 수 없습니다.</p><div class="m28-assignment-grid">${rows.map((row)=>{const expired=new Date(`${row.start}T00:00:00+09:00`)<=now;const label=`${row.year} 전기기능사 ${row.round}회`;return `<button type="button" class="m28-assignment-card" data-target="${esc(label)}" data-target-date="${esc(row.start)}" ${expired?'disabled':''} style="text-align:left;cursor:${expired?'not-allowed':'pointer'};opacity:${expired?'.45':'1'}"><div class="m28-assignment-card-head"><h4>${row.year}년 ${row.round}회</h4><span class="${row.official?'m28-official-badge':'m28-estimated-badge'}">${row.official?'공식':'예상'}</span></div><small>원서접수 ${esc(row.apply)}</small><small>필기시험 ${esc(row.exam)}</small><small>합격발표 ${esc(row.result)}</small>${expired?'<small style="color:#b9342a">지난 일정 · 선택 불가</small>':''}</button>`}).join('')}</div><p style="font-size:12px;color:#71827e">일정은 종목·지역에 따라 달라질 수 있으므로 접수 전 Q-Net 회별 공고를 다시 확인하세요.</p>`;
 const error=host.querySelector('#stepError,.error-box');if(error)host.insertBefore(panel,error);else host.appendChild(panel);
}
function teacherFilter(){
 if(!selectedCert||!selectedCourse||!teachers.length)return;
 document.querySelectorAll('[data-teacher]').forEach((card)=>{
   const teacher=teachers.find((row)=>String(row.id)===String(card.dataset.teacher));
   if(!teacher)return;
   const allowed=(teacher.assignments||[]).some((item)=>item.cert===selectedCert&&(item.courses||[]).includes(selectedCourse));
   card.hidden=!allowed;card.disabled=!allowed;
 });
}
function patch(){addToCertificateLists();courseGuard();schedulePanel();teacherFilter()}
document.addEventListener('click',(event)=>{
 const cert=event.target.closest('[data-cert]');if(cert){selectedCert=cert.dataset.cert||'';selectedCourse='';setTimeout(patch,0);setTimeout(patch,100)}
 const course=event.target.closest('[data-course]');if(course){if(selectedCert==='전기기능사'&&course.dataset.course!=='필기'){event.preventDefault();event.stopImmediatePropagation();alert('전기기능사는 필기 과정만 운영합니다.');return}selectedCourse=course.dataset.course||'';setTimeout(patch,0);setTimeout(patch,100)}
},true);
const observer=new MutationObserver(()=>patch());observer.observe(document.documentElement,{childList:true,subtree:true});
Promise.allSettled([get('/certificates'),get('/teachers')]).then((results)=>{if(results[0].status==='fulfilled')catalog=results[0].value.items||[];if(results[1].status==='fulfilled')teachers=results[1].value.items||[];patch()});
})();
