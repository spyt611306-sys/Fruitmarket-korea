(()=>{
  'use strict';
  if(window.__MATCHSIK_TEACHER_ENTRY_V281__)return;
  window.__MATCHSIK_TEACHER_ENTRY_V281__=true;

  const cfg=()=>window.MATCHSIK_CONFIG||window.matchsikConfig||{};
  const apiBase=()=>String(cfg().apiBaseUrl||'').replace(/\/$/,'');
  const key=()=>String(cfg().supabasePublishableKey||cfg().publishableKey||'').trim();
  const apiUrl=(path)=>{
    const base=apiBase();
    const clean='/api/'+String(path||'').replace(/^\/+/, '').replace(/^api\//,'');
    return base+clean;
  };
  const esc=(value)=>String(value??'').replace(/[&<>'"]/g,(ch)=>({
    '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'
  })[ch]);

  async function api(path,options={}){
    const response=await fetch(apiUrl(path),{
      method:options.method||'GET',
      headers:{
        'content-type':'application/json',
        ...(key()?{apikey:key()}:{}),
        ...(options.headers||{}),
      },
      body:options.body,
      cache:'no-store',
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok){
      const requestId=data.requestId?` · 문의번호 ${data.requestId}`:'';
      const error=new Error(`${data.error||'요청을 처리하지 못했습니다.'}${requestId}`);
      error.status=response.status;error.code=data.errorCode||'';throw error;
    }
    return data;
  }

  function clearSession(){
    ['matchsik_teacher_token','matchsik_teacher_expires_at','matchsik_teacher_last_activity','matchsik_teacher_identity']
      .forEach((name)=>sessionStorage.removeItem(name));
  }

  function close(){document.querySelector('.m28-teacher-login-backdrop')?.remove();document.body.style.overflow=''}

  function open(){
    close();
    const backdrop=document.createElement('div');
    backdrop.className='m28-teacher-login-backdrop';
    backdrop.innerHTML=`
      <section class="m28-teacher-login-dialog" role="dialog" aria-modal="true" aria-labelledby="m28TeacherLoginTitle">
        <button class="m28-teacher-login-close" type="button" aria-label="닫기" data-m28-close>×</button>
        <div class="m28-teacher-login-mark" aria-hidden="true">T</div>
        <p class="m28-teacher-login-eyebrow">TEACHER SECURE ACCESS</p>
        <h2 id="m28TeacherLoginTitle">강사 로그인</h2>
        <p class="m28-teacher-login-description">관리자가 연결한 강사 전용 이메일과 비밀번호를 입력하세요. 로그인 후에는 본인의 프로필·참여 자격증·가능시간·휴무·수업 캘린더만 확인할 수 있습니다.</p>
        <form data-m28-teacher-form novalidate>
          <div class="m28-login-field">
            <label for="m28TeacherEmail">강사 이메일</label>
            <input class="m28-login-input" id="m28TeacherEmail" type="email" autocomplete="username" placeholder="teacher@example.com" required>
          </div>
          <div class="m28-login-field">
            <label for="m28TeacherPassword">비밀번호</label>
            <div class="m28-login-input-wrap">
              <input class="m28-login-input has-toggle" id="m28TeacherPassword" type="password" autocomplete="current-password" minlength="8" required>
              <button class="m28-password-toggle" type="button" data-m28-password-toggle>보기</button>
            </div>
          </div>
          <div class="m28-login-error" data-m28-login-error hidden></div>
          <button class="m28-teacher-login-submit" type="submit" data-m28-login-submit>강사 페이지로 이동</button>
        </form>
        <div class="m28-login-notice">강사 포털 로그인 권한과 수강생 신청 화면의 공개 여부는 별도로 관리됩니다.</div>
      </section>`;
    document.body.appendChild(backdrop);document.body.style.overflow='hidden';
    const email=backdrop.querySelector('#m28TeacherEmail');
    setTimeout(()=>email?.focus(),60);

    backdrop.addEventListener('click',(event)=>{
      if(event.target===backdrop||event.target.closest('[data-m28-close]'))close();
      const toggle=event.target.closest('[data-m28-password-toggle]');
      if(toggle){const input=backdrop.querySelector('#m28TeacherPassword');input.type=input.type==='password'?'text':'password';toggle.textContent=input.type==='password'?'보기':'숨김'}
    });
    backdrop.addEventListener('keydown',(event)=>{if(event.key==='Escape')close()});
    backdrop.querySelector('form').addEventListener('submit',async(event)=>{
      event.preventDefault();
      const emailValue=String(backdrop.querySelector('#m28TeacherEmail').value||'').trim().toLowerCase();
      const password=String(backdrop.querySelector('#m28TeacherPassword').value||'');
      const errorBox=backdrop.querySelector('[data-m28-login-error]');
      const button=backdrop.querySelector('[data-m28-login-submit]');
      errorBox.hidden=true;
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue)||password.length<8){errorBox.textContent='이메일과 비밀번호를 정확히 입력해 주세요.';errorBox.hidden=false;return}
      button.disabled=true;button.textContent='강사 계정을 확인하고 있습니다…';
      try{
        clearSession();
        const result=await api('/teacher/login',{method:'POST',body:JSON.stringify({email:emailValue,password})});
        if(!result.token)throw new Error('로그인 토큰을 받지 못했습니다.');
        sessionStorage.setItem('matchsik_teacher_token',result.token);
        sessionStorage.setItem('matchsik_teacher_expires_at',String(result.expiresAt||''));
        sessionStorage.setItem('matchsik_teacher_last_activity',String(Date.now()));
        sessionStorage.setItem('matchsik_teacher_identity',JSON.stringify(result.teacher||{email:emailValue}));
        location.assign('/teacher.html?v=28.1');
      }catch(error){
        clearSession();errorBox.textContent=error.message||'강사 로그인을 완료하지 못했습니다.';errorBox.hidden=false;
        button.disabled=false;button.textContent='강사 페이지로 이동';
      }
    });
  }

  let taps=[];
  function tap(){
    const now=Date.now();taps=taps.filter((time)=>now-time<4000);taps.push(now);
    if(taps.length>=7){taps=[];open()}
  }
  document.addEventListener('click',(event)=>{
    const target=event.target.closest('[data-teacher-entry],#footerBrand,#footerLogo,.footer-brand,.footer-logo,[data-footer-brand]');
    if(!target)return;
    event.preventDefault();event.stopPropagation();tap();
  },true);
  document.addEventListener('keydown',(event)=>{
    if(event.altKey&&event.shiftKey&&event.code==='KeyT'){event.preventDefault();open()}
  });
  window.MATCHSIK_TEACHER_LOGIN={open,close,clearSession};
})();
