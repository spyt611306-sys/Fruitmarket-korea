(()=>{
'use strict';
const $=(selector,root=document)=>root.querySelector(selector);
const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
const cfg=window.MATCHSIK_CONFIG||window.matchsikConfig||{};
const base=String(cfg.apiBaseUrl||'').replace(/\/$/,'');
const publishableKey=String(cfg.supabasePublishableKey||cfg.publishableKey||'').trim();
const tokenKey='matchsik_teacher_token';
const token=()=>sessionStorage.getItem(tokenKey)||'';
const apiUrl=(path)=>base+'/api/'+String(path||'').replace(/^\/+/, '').replace(/^api\//,'');
const esc=(value)=>String(value??'').replace(/[&<>'"]/g,(ch)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[ch]));
const pad=(n)=>String(n).padStart(2,'0');
const ymd=(date)=>`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
const dayNames=['일','월','화','수','목','금','토'];
let dashboard=null;
let activeTab='dashboard';
let calendarMonth=new Date(new Date().getFullYear(),new Date().getMonth(),1);

function clearSession(){['matchsik_teacher_token','matchsik_teacher_expires_at','matchsik_teacher_last_activity','matchsik_teacher_identity'].forEach((key)=>sessionStorage.removeItem(key))}
function showState(name,message=''){$$('[data-state]').forEach((el)=>el.hidden=el.dataset.state!==name);$('[data-view]').hidden=true;$('[data-sidebar]').hidden=true;if(message)$('[data-error-message]').textContent=message}
function showView(){$$('[data-state]').forEach((el)=>el.hidden=true);$('[data-view]').hidden=false;$('[data-sidebar]').hidden=false}
function toast(message){const box=$('[data-toast]');box.textContent=message;box.hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>box.hidden=true,3300)}
async function api(path,options={}){
 const headers={'content-type':'application/json',...(publishableKey?{apikey:publishableKey}:{}),...(token()?{authorization:`Bearer ${token()}`}:{})};
 const response=await fetch(apiUrl(path),{method:options.method||'GET',headers:{...headers,...(options.headers||{})},body:options.body,cache:'no-store'});
 const data=await response.json().catch(()=>({}));
 if(!response.ok){const id=data.requestId?` · 문의번호 ${data.requestId}`:'';const error=new Error(`${data.error||'요청을 처리하지 못했습니다.'}${id}`);error.status=response.status;error.code=data.errorCode||'';throw error}
 return data;
}
function profile(){return dashboard?.teacher||{}}
function selectedAssignments(root=document){
 const groups=new Map();
 $$('[data-assignment-course]:checked',root).forEach((input)=>{
   const code=input.dataset.certificateCode,course=input.value;
   if(!groups.has(code))groups.set(code,[]);groups.get(code).push(course);
 });
 return [...groups].map(([certificateCode,courses])=>({certificateCode,courses}));
}
function assignmentSelected(code,course){return (dashboard?.assignments||[]).some((item)=>item.certificateCode===code&&(item.courses||[]).includes(course))}
function assignmentCatalogHtml(){
 const catalog=dashboard?.catalog||[];
 return `<div class="m28-catalog-toolbar"><input class="m28-catalog-search" data-catalog-search placeholder="자격증 검색"><span class="t28-status-pill">선택한 자격증과 과정만 수강생에게 표시</span></div><div class="m28-assignment-grid" data-assignment-grid>${catalog.map((cert)=>{
   const allowed=Array.isArray(cert.allowed_courses)?cert.allowed_courses:[];
   const writtenOnly=cert.code==='electric-craftsman';
   return `<article class="m28-assignment-card" data-catalog-card data-search="${esc(`${cert.name} ${cert.category} ${cert.group_name}`.toLowerCase())}"><div class="m28-assignment-card-head"><div><h4>${esc(cert.name)}</h4><small>${esc(cert.category)} · ${esc(cert.group_name)}</small></div>${writtenOnly?'<span class="m28-written-only-badge">필기 전용</span>':''}</div><div class="m28-course-options">${['필기','실기','필기+실기'].map((course)=>{const enabled=allowed.includes(course);return `<label class="m28-course-option ${enabled?'':'disabled'}"><input type="checkbox" data-assignment-course data-certificate-code="${esc(cert.code)}" value="${course}" ${assignmentSelected(cert.code,course)?'checked':''} ${enabled?'':'disabled'}><span>${course}</span></label>`}).join('')}</div></article>`
 }).join('')}</div>`;
}
function renderDashboard(){
 const t=profile(),reservations=dashboard.reservations||[],lessons=dashboard.lessons||[];
 const upcoming=reservations.filter((row)=>new Date(row.startsAt)>new Date());
 const approved=upcoming.filter((row)=>String(row.status).toUpperCase()==='APPROVED').length;
 const held=upcoming.filter((row)=>String(row.status).toUpperCase()==='HELD').length;
 return `<div class="t28-page-head"><div><h1>${esc(t.name||'강사')}님의 대시보드</h1><p>본인의 수업 일정과 프로필 상태를 한곳에서 확인합니다.</p></div><span class="t28-status-pill">로그인 정상 · ${esc(t.id||'')}</span></div><div class="t28-grid"><article class="t28-stat"><span>다가오는 일정</span><b>${upcoming.length}건</b></article><article class="t28-stat"><span>확정 수업</span><b>${approved}건</b></article><article class="t28-stat"><span>입금 확인 중</span><b>${held}건</b></article><article class="t28-stat"><span>참여 과정</span><b>${(dashboard.assignments||[]).length}개</b></article></div><article class="t28-card"><h2>가까운 수업</h2><p class="t28-card-sub">확정 또는 보류된 일정입니다.</p><div class="t28-row-list">${upcoming.length?upcoming.slice(0,8).map((row)=>`<div class="t28-row"><div><b>${esc(row.date)} ${esc(row.time)} · ${esc(row.cert)} ${esc(row.course)}</b><small>${esc(row.studentName)} 수강생 · ${String(row.status).toUpperCase()==='APPROVED'?'수업 확정':'입금 확인 중'}</small></div><button type="button" data-go-calendar>캘린더</button></div>`).join(''):'<div class="t28-row"><div><b>예정된 수업이 없습니다.</b><small>가능시간을 등록하면 수강생이 신청할 수 있습니다.</small></div></div>'}</div></article>${dashboard.warnings?.length?`<div class="m28-login-error">${esc(dashboard.warnings.join(' '))}</div>`:''}`;
}
function monthRows(){return (dashboard.reservations||[]).filter((row)=>{const d=new Date(row.startsAt);return d.getFullYear()===calendarMonth.getFullYear()&&d.getMonth()===calendarMonth.getMonth()})}
function renderCalendar(){
 const first=new Date(calendarMonth.getFullYear(),calendarMonth.getMonth(),1);const gridStart=new Date(first);gridStart.setDate(1-first.getDay());const events=monthRows();
 const days=[];for(let i=0;i<42;i++){const date=new Date(gridStart);date.setDate(gridStart.getDate()+i);const dateKey=ymd(date);const rows=events.filter((r)=>String(r.date||r.startsAt).slice(0,10)===dateKey);days.push(`<div class="t28-calendar-day ${date.getMonth()===calendarMonth.getMonth()?'':'other'} ${dateKey===ymd(new Date())?'today':''}"><span class="t28-calendar-day-number">${date.getDate()}</span>${rows.slice(0,3).map((row)=>`<span class="t28-event ${String(row.status).toLowerCase()}">${esc(row.time)} ${esc(row.studentName)} ${esc(row.cert)}</span>`).join('')}</div>`)}
 return `<div class="t28-page-head"><div><h1>수업 캘린더</h1><p>모바일에서도 한 화면에 7열 전체가 보입니다.</p></div></div><article class="t28-card"><div class="t28-calendar-head"><button type="button" data-calendar-nav="-1">‹</button><h2>${calendarMonth.getFullYear()}년 ${calendarMonth.getMonth()+1}월</h2><button type="button" data-calendar-nav="1">›</button></div><div class="t28-calendar-weekdays">${dayNames.map((day)=>`<div>${day}</div>`).join('')}</div><div class="t28-calendar-days">${days.join('')}</div></article>`;
}
function renderProfile(){const t=profile();return `<div class="t28-page-head"><div><h1>내 프로필</h1><p>수강생이 강사를 선택할 때 확인하는 정보와 참여 자격증을 직접 관리합니다.</p></div></div><form class="t28-card" data-profile-form><div class="t28-form-grid"><div class="t28-field"><label>강사 ID</label><input value="${esc(t.id||'')}" disabled></div><div class="t28-field"><label>강사명</label><input name="name" value="${esc(t.name||'')}" required></div><div class="t28-field full"><label>전문 역할</label><input name="role" value="${esc(t.role||'')}" placeholder="예: 전기기사 필기·실기 전문"></div><div class="t28-field full"><label>경력 요약</label><textarea name="careerSummary">${esc(t.career_summary||'')}</textarea></div><div class="t28-field full"><label>수업 방식</label><textarea name="teachingStyle">${esc(t.teaching_style||'')}</textarea></div><div class="t28-field"><label>강사 태그 · 쉼표 구분</label><input name="tags" value="${esc((t.tags||[]).join(', '))}"></div><div class="t28-field"><label>프로필 이미지 URL</label><input name="profileImageUrl" value="${esc(t.profile_image_url||'')}"></div></div><div style="margin-top:24px"><h2>참여 자격증과 과정</h2><p class="t28-card-sub">실제로 수업 가능한 과정만 선택하세요. 전기기능사는 필기만 선택할 수 있습니다.</p>${assignmentCatalogHtml()}</div><div class="m28-save-bar"><button class="t28-save" type="submit">프로필 저장</button></div></form>`}
function renderAvailability(){const rows=dashboard.availability||[];return `<div class="t28-page-head"><div><h1>가능시간</h1><p>매주 반복해서 수업할 수 있는 시간을 등록합니다.</p></div></div><article class="t28-card"><form class="t28-form-grid" data-availability-form><div class="t28-field"><label>요일</label><select name="dayOfWeek">${dayNames.map((day,index)=>`<option value="${index}">${day}요일</option>`).join('')}</select></div><div class="t28-field"><label>시작시간</label><input name="startTime" type="time" required></div><div class="t28-field"><label>종료시간</label><input name="endTime" type="time" required></div><div class="t28-field" style="align-content:end"><button class="t28-save" type="submit">가능시간 추가</button></div></form><div class="t28-row-list" style="margin-top:18px">${rows.length?rows.map((row)=>`<div class="t28-row"><div><b>${dayNames[Number(row.day_of_week)]}요일 ${String(row.start_time).slice(0,5)}~${String(row.end_time).slice(0,5)}</b><small>${row.active===false?'비활성':'수강생 신청 가능'}</small></div><button class="t28-danger" type="button" data-delete-availability="${row.id}">삭제</button></div>`).join(''):'<div class="t28-row"><div><b>등록된 가능시간이 없습니다.</b></div></div>'}</div></article>`}
function renderClosures(){const rows=dashboard.closures||[];return `<div class="t28-page-head"><div><h1>휴무 관리</h1><p>특정 날짜 전체 또는 특정 시간만 휴무로 등록합니다.</p></div></div><article class="t28-card"><form class="t28-form-grid" data-closure-form><div class="t28-field"><label>휴무 날짜</label><input name="date" type="date" required></div><div class="t28-field"><label>특정 시간 · 비우면 종일</label><input name="time" type="time"></div><div class="t28-field full"><label>사유</label><input name="reason" placeholder="개인 일정"></div><div class="t28-field full"><button class="t28-save" type="submit">휴무 추가</button></div></form><div class="t28-row-list" style="margin-top:18px">${rows.length?rows.map((row)=>`<div class="t28-row"><div><b>${esc(row.closure_date)} ${row.closure_time?String(row.closure_time).slice(0,5):'종일'}</b><small>${esc(row.reason||'사유 없음')}</small></div><button class="t28-danger" type="button" data-delete-closure="${row.id}">삭제</button></div>`).join(''):'<div class="t28-row"><div><b>등록된 휴무가 없습니다.</b></div></div>'}</div></article>`}
function renderProof(){const p=dashboard.proof||{};return `<div class="t28-page-head"><div><h1>합격률 자료</h1><p>관리자 검증 후 공개됩니다.</p></div></div><form class="t28-card t28-form-grid" data-proof-form><div class="t28-field"><label>응시자 수</label><input name="applicants" type="number" min="0" value="${esc(p.applicants||'')}"></div><div class="t28-field"><label>합격자 수</label><input name="passed" type="number" min="0" value="${esc(p.passed||'')}"></div><div class="t28-field"><label>산정 기간</label><input name="period" value="${esc(p.period||'')}"></div><div class="t28-field"><label>현재 상태</label><input value="${p.verified?'관리자 검증 완료':'검토 대기'}" disabled></div><div class="t28-field full"><label>근거</label><textarea name="basis">${esc(p.basis||'')}</textarea></div><div class="t28-field full"><button class="t28-save" type="submit">검토 요청</button></div></form>`}
function renderReviews(){const rows=dashboard.reviews||[],t=profile();return `<div class="t28-page-head"><div><h1>후기 제출</h1><p>수강생 동의를 받은 후기만 제출하고 이름은 마스킹해 주세요.</p></div></div><form class="t28-card t28-form-grid" data-review-form><div class="t28-field"><label>수강생 표시명</label><input name="studentDisplay" placeholder="김**" required></div><div class="t28-field"><label>자격증</label><input name="cert" required></div><div class="t28-field"><label>과정</label><select name="course"><option>필기</option><option>실기</option><option>필기+실기</option></select></div><div class="t28-field"><label>태그 · 쉼표 구분</label><input name="tags"></div><div class="t28-field full"><label>후기 내용</label><textarea name="content" required></textarea></div><div class="t28-field full"><button class="t28-save" type="submit">관리자 검토 요청</button></div><input type="hidden" name="teacherName" value="${esc(t.name||'')}"></form><article class="t28-card"><h2>제출 내역</h2><div class="t28-row-list">${rows.length?rows.map((row)=>`<div class="t28-row"><div><b>${esc(row.student_display)} · ${esc(row.cert)} ${esc(row.course)}</b><small>${esc(row.content)} · ${row.verified&&row.published?'공개됨':'검토 대기'}</small></div></div>`).join(''):'<div class="t28-row"><div><b>제출된 후기가 없습니다.</b></div></div>'}</div></article>`}
function render(){if(!dashboard)return;showView();const t=profile();$('[data-mini-name]').textContent=`${t.name||'강사'} 강사`;$('[data-mini-role]').textContent=t.role||'프로필을 입력해 주세요.';$$('[data-tab]').forEach((button)=>button.classList.toggle('active',button.dataset.tab===activeTab));const view=$('[data-view]');view.innerHTML=activeTab==='dashboard'?renderDashboard():activeTab==='calendar'?renderCalendar():activeTab==='profile'?renderProfile():activeTab==='availability'?renderAvailability():activeTab==='closures'?renderClosures():activeTab==='proof'?renderProof():renderReviews();bindDynamic()}
async function load(){if(!token()){showState('auth');return}showState('boot');try{await api('/teacher/session-check');dashboard=await api('/teacher/dashboard');sessionStorage.setItem('matchsik_teacher_last_activity',String(Date.now()));render()}catch(error){if(error.status===401||error.status===403){clearSession();showState('auth')}else showState('error',error.message)}}
async function refresh(message=''){dashboard=await api('/teacher/dashboard');render();if(message)toast(message)}
function formObject(form){return Object.fromEntries(new FormData(form).entries())}
function bindDynamic(){
 const search=$('[data-catalog-search]');search?.addEventListener('input',()=>{const query=search.value.trim().toLowerCase();$$('[data-catalog-card]').forEach((card)=>card.hidden=query&&!card.dataset.search.includes(query))});
 $('[data-profile-form]')?.addEventListener('submit',async(event)=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{const data=formObject(event.currentTarget);const payload={profile:{id:profile().id,name:data.name,role:data.role,careerSummary:data.careerSummary,teachingStyle:data.teachingStyle,tags:String(data.tags||'').split(',').map((x)=>x.trim()).filter(Boolean),profileImageUrl:data.profileImageUrl},assignments:selectedAssignments(event.currentTarget)};const result=await api('/teacher/profile',{method:'PUT',body:JSON.stringify(payload)});dashboard=result.dashboard||await api('/teacher/dashboard');render();toast('프로필과 참여 자격증을 저장했습니다.')}catch(error){alert(error.message)}finally{button.disabled=false}});
 $('[data-availability-form]')?.addEventListener('submit',async(event)=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{await api('/teacher/availability',{method:'POST',body:JSON.stringify(formObject(event.currentTarget))});await refresh('가능시간을 추가했습니다.')}catch(error){alert(error.message)}finally{button.disabled=false}});
 $('[data-closure-form]')?.addEventListener('submit',async(event)=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{await api('/teacher/closures',{method:'POST',body:JSON.stringify(formObject(event.currentTarget))});await refresh('휴무를 추가했습니다.')}catch(error){alert(error.message)}finally{button.disabled=false}});
 $('[data-proof-form]')?.addEventListener('submit',async(event)=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{await api('/teacher/proof',{method:'POST',body:JSON.stringify(formObject(event.currentTarget))});await refresh('합격률 자료를 제출했습니다.')}catch(error){alert(error.message)}finally{button.disabled=false}});
 $('[data-review-form]')?.addEventListener('submit',async(event)=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{const data=formObject(event.currentTarget);data.tags=String(data.tags||'').split(',').map((x)=>x.trim()).filter(Boolean);await api('/teacher/reviews',{method:'POST',body:JSON.stringify(data)});await refresh('후기를 제출했습니다.')}catch(error){alert(error.message)}finally{button.disabled=false}});
}
document.addEventListener('click',async(event)=>{
 const tab=event.target.closest('[data-tab]');if(tab){activeTab=tab.dataset.tab;render();return}
 if(event.target.closest('[data-logout]')){clearSession();location.assign('/');return}
 if(event.target.closest('[data-home]')){location.assign('/');return}
 if(event.target.closest('[data-retry]')){load();return}
 if(event.target.closest('[data-go-calendar]')){activeTab='calendar';render();return}
 const nav=event.target.closest('[data-calendar-nav]');if(nav){calendarMonth=new Date(calendarMonth.getFullYear(),calendarMonth.getMonth()+Number(nav.dataset.calendarNav),1);render();return}
 const availability=event.target.closest('[data-delete-availability]');if(availability){if(!confirm('이 가능시간을 삭제하시겠습니까? 입금 확인 중이거나 확정된 미래 수업과 겹치면 삭제가 제한됩니다.'))return;try{await api(`/teacher/availability/${availability.dataset.deleteAvailability}`,{method:'DELETE'});await refresh('가능시간을 삭제했습니다.')}catch(error){alert(error.message)}return}
 const closure=event.target.closest('[data-delete-closure]');if(closure){if(!confirm('이 휴무를 삭제하시겠습니까?'))return;try{await api(`/teacher/closures/${closure.dataset.deleteClosure}`,{method:'DELETE'});await refresh('휴무를 삭제했습니다.')}catch(error){alert(error.message)}return}
});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)sessionStorage.setItem('matchsik_teacher_last_activity',String(Date.now()))});
setInterval(()=>{const last=Number(sessionStorage.getItem('matchsik_teacher_last_activity')||0);if(last&&Date.now()-last>30*60*1000){clearSession();showState('auth')}},60000);
load();
})();
