(function (global) {
  "use strict";
  const qs = (id) => document.getElementById(id);
  const toast = (message) => global.app?.showToast?.(message) || global.alert(message);
  const button = (id, text, className = "") => {
    const node = document.createElement("button"); node.id = id; node.type = "button"; node.textContent = text;
    node.className = className || "rounded-xl border border-gray-200 bg-white px-4 py-3 text-xs font-black text-primary";
    return node;
  };
  async function forgotPassword() {
    const initial = qs("auth-email")?.value || "";
    const email = global.prompt("비밀번호 재설정 메일을 받을 이메일을 입력하세요.", initial);
    if (!email) return;
    await global.FruitMarketAuth.resetPassword(email); toast("비밀번호 재설정 메일을 보냈습니다.");
  }
  async function resendVerification() {
    const initial = qs("auth-email")?.value || "";
    const email = global.prompt("인증메일을 다시 받을 이메일을 입력하세요.", initial);
    if (!email) return;
    await global.FruitMarketAuth.resendVerification(email); toast("인증메일을 다시 보냈습니다.");
  }
  async function changePassword() {
    const password = global.prompt("새 비밀번호를 입력하세요. 대/소문자·숫자·특수문자를 포함해 10자 이상을 권장합니다.");
    if (!password) return;
    const confirm = global.prompt("새 비밀번호를 한 번 더 입력하세요.");
    if (password !== confirm) throw new Error("비밀번호가 일치하지 않습니다.");
    await global.FruitMarketAuth.updatePassword(password); toast("비밀번호를 변경했습니다.");
  }
  async function changeEmail() {
    const email = global.prompt("변경할 이메일을 입력하세요. 새 이메일에서 확인이 필요합니다.");
    if (!email) return;
    await global.FruitMarketAuth.updateEmail(email); toast("이메일 변경 확인메일을 보냈습니다.");
  }
  function mfaModal(enrollment) {
    qs("fm45-mfa-modal")?.remove();
    const modal = document.createElement("div"); modal.id = "fm45-mfa-modal";
    modal.style.cssText = "position:fixed;inset:0;z-index:2147483640;background:rgba(0,0,0,.58);display:grid;place-items:center;padding:16px";
    modal.innerHTML = `<section style="width:min(440px,100%);background:#fff;border-radius:24px;padding:26px;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.25)"><h2 style="margin:0 0 10px;font-size:20px">관리자 MFA 등록</h2><p style="font-size:13px;line-height:1.6;color:#566">인증 앱으로 QR 코드를 스캔하고 6자리 코드를 입력하세요.</p><img id="fm45-mfa-qr" alt="MFA QR 코드" style="width:220px;height:220px;object-fit:contain;margin:12px auto;background:#fff"><code id="fm45-mfa-secret" style="display:block;overflow-wrap:anywhere;font-size:11px;background:#f4f5f4;padding:10px;border-radius:10px"></code><input id="fm45-mfa-code" inputmode="numeric" maxlength="6" placeholder="6자리 인증코드" style="box-sizing:border-box;width:100%;margin-top:14px;padding:13px;border:1px solid #ccd5cc;border-radius:12px;font-size:16px"><div style="display:flex;gap:8px;margin-top:12px"><button id="fm45-mfa-cancel" style="flex:1;padding:12px;border-radius:12px;border:1px solid #ccd5cc;background:#fff;font-weight:800">취소</button><button id="fm45-mfa-verify" style="flex:1;padding:12px;border-radius:12px;border:0;background:#114214;color:#fff;font-weight:900">등록 완료</button></div></section>`;
    document.body.append(modal);
    const qr = enrollment?.totp?.qr_code || enrollment?.totp?.qrCode || "";
    const secret = enrollment?.totp?.secret || "";
    qs("fm45-mfa-qr").src = qr; qs("fm45-mfa-secret").textContent = secret;
    qs("fm45-mfa-cancel").onclick = async () => { try { await global.FruitMarketAuth.unenrollMfa(enrollment.id); } catch (_) {} modal.remove(); };
    qs("fm45-mfa-verify").onclick = async () => { const code = qs("fm45-mfa-code").value; await global.FruitMarketAuth.verifyMfa(enrollment.id, code); modal.remove(); toast("MFA 등록과 2단계 인증을 완료했습니다."); };
  }
  async function enrollMfa() { const enrollment = await global.FruitMarketAuth.enrollMfa(); mfaModal(enrollment); }
  async function showMfaStatus() {
    const factors = await global.FruitMarketAuth.listMfaFactors();
    const aal = await global.FruitMarketAuth.assuranceLevel();
    const verified = factors?.totp?.filter((x) => x.status === "verified") || [];
    toast(`현재 인증수준: ${aal?.currentLevel || "aal1"} · 등록된 MFA: ${verified.length}개`);
  }
  function installAuthTools() {
    const panel = qs("auth-login-panel"); if (!panel || qs("fm45-auth-tools")) return;
    const tools = document.createElement("div"); tools.id = "fm45-auth-tools"; tools.className = "grid grid-cols-2 gap-2";
    const forgot = button("fm45-forgot-password", "비밀번호 찾기"); forgot.onclick = () => forgotPassword().catch((e) => toast(e.message));
    const resend = button("fm45-resend-email", "인증메일 재발송"); resend.onclick = () => resendVerification().catch((e) => toast(e.message));
    tools.append(forgot, resend); panel.append(tools);
  }
  function installAccountSecurity() {
    const view = qs("view-mypage"); if (!view || qs("fm45-account-security")) return;
    const card = document.createElement("section"); card.id = "fm45-account-security";
    card.className = "mt-6 rounded-2xl border border-gray-100 bg-white p-5 shadow-card";
    card.innerHTML = `<h3 class="font-black text-primary">계정 보안</h3><p class="mt-1 text-xs text-gray-500">비밀번호·이메일 변경과 모든 기기 로그아웃을 관리합니다.</p><div id="fm45-account-actions" class="mt-4 flex flex-wrap gap-2"></div>`;
    const actions = card.querySelector("#fm45-account-actions");
    const password = button("fm45-change-password", "비밀번호 변경"); password.onclick = () => changePassword().catch((e) => toast(e.message));
    const email = button("fm45-change-email", "이메일 변경"); email.onclick = () => changeEmail().catch((e) => toast(e.message));
    const logout = button("fm45-logout-all", "모든 기기 로그아웃", "rounded-xl bg-gray-900 px-4 py-3 text-xs font-black text-white"); logout.onclick = () => global.FruitMarketAuth.signOutAll().then(() => location.replace("./#auth")).catch((e) => toast(e.message));
    actions.append(password, email, logout); view.append(card);
  }
  function installAdminSecurity() {
    const view = qs("view-admin"); if (!view || qs("fm45-admin-security")) return;
    const card = document.createElement("section"); card.id = "fm45-admin-security";
    card.className = "mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5";
    card.innerHTML = `<h3 class="font-black text-amber-900">관리자 2단계 인증</h3><p class="mt-1 text-xs text-amber-800">관리자 API는 AAL2 MFA가 완료된 세션만 허용합니다.</p><div id="fm45-admin-mfa-actions" class="mt-4 flex flex-wrap gap-2"></div>`;
    const actions = card.querySelector("#fm45-admin-mfa-actions");
    const enroll = button("fm45-enroll-mfa", "MFA 등록", "rounded-xl bg-primary px-4 py-3 text-xs font-black text-white"); enroll.onclick = () => enrollMfa().catch((e) => toast(e.message));
    const status = button("fm45-mfa-status", "MFA 상태 확인"); status.onclick = () => showMfaStatus().catch((e) => toast(e.message));
    actions.append(enroll, status); view.append(card);
  }
  async function recoveryFlow() {
    if (location.hash !== "#auth-reset") return;
    try { await changePassword(); location.replace("./#auth"); } catch (e) { toast(e.message); }
  }
  function install() { installAuthTools(); installAccountSecurity(); installAdminSecurity(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { install(); recoveryFlow(); }, { once: true }); else { install(); recoveryFlow(); }
  new MutationObserver(install).observe(document.documentElement, { childList: true, subtree: true });
})(window);
