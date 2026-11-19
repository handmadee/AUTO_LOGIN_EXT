/* ========================================================
   content.js – ChatGPT Auto Login Content Script (BẢN CHUẨN)
   ======================================================== */

const delay = ms => new Promise(r => setTimeout(r, ms));

// Kiểm tra phần tử có thực sự hiển thị trên màn hình không (tránh form ẩn)
function isVisible(el) {
  return el && el.offsetWidth > 0 && el.offsetHeight > 0;
}

function isCredentialUrl(url) {
  return url.includes('auth.openai.com') ||
    url.includes('auth0.openai.com') ||
    /^https:\/\/chatgpt\.com\/auth\/(login|signin)(?:[/?#]|$)/.test(url);
}

// Chờ phần tử xuất hiện VÀ phải hiển thị
function waitForVisibleElement(selectors, timeout = 15000) {
  const sel = Array.isArray(selectors) ? selectors.join(',') : selectors;
  return new Promise((resolve, reject) => {
    const check = () => {
      const els = document.querySelectorAll(sel);
      for (let e of els) if (isVisible(e)) return e;
      return null;
    };
    
    const el = check();
    if (el) return resolve(el);
    
    const obs = new MutationObserver(() => {
      const found = check();
      if (found) { obs.disconnect(); clearTimeout(t); resolve(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true, attributes: true });
    const t = setTimeout(() => { obs.disconnect(); reject(new Error('Timeout: ' + sel)); }, timeout);
  });
}

function fillInput(el, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  ['input', 'change', 'blur'].forEach(e =>
    el.dispatchEvent(new Event(e, { bubbles: true }))
  );
}

async function clickSubmit(refEl) {
  await delay(200);
  const form = refEl.closest('form');
  let btn = form ? form.querySelector(
    'button[type="submit"], button[data-action-button-primary="true"], button[name="action"]'
  ) : null;
  
  if (!btn) btn = document.querySelector(
    'button[type="submit"], button[data-action-button-primary="true"]'
  );

  for (let i = 0; i < 10; i++) {
    if (btn && !btn.disabled) break;
    await delay(250);
  }

  if (btn && !btn.disabled) {
    btn.click();
  } else {
    refEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
    refEl.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  }
}

// ══════════════════════════════════════════════════════════
//  STEP HANDLERS
// ══════════════════════════════════════════════════════════

async function stepEmail(creds) {
  log('📧 Bước 1: Email');
  const el = await waitForVisibleElement([
    'input[type="email"]', 'input[name="email"]',
    'input[name="username"]', 'input[autocomplete="email"]',
    'input[id*="email"]'
  ]).catch(() => null);
  
  if (!el) { log('⚠️ Không tìm thấy ô email'); return; }

  await delay(500);
  el.focus();
  fillInput(el, creds.email);
  log('  → Đã điền email:', creds.email);
  await delay(500);
  await clickSubmit(el);
  
  // NÂNG CẤP: Chờ 1.5s rồi tự động phân tích DOM để chạy tiếp bước 2
  log('⏳ Đã gửi Email, đang chờ form tiếp theo...');
  await delay(1500);
  await detectAndFill(creds, 0); 
}

async function stepPassword(creds) {
  log('🔑 Bước 2: Password');
  const el = await waitForVisibleElement([
    'input[type="password"]', 'input[name="password"]'
  ]).catch(() => null);
  
  if (!el) { log('⚠️ Không tìm thấy ô password'); return; }

  await delay(500);
  el.focus();
  fillInput(el, creds.password);
  log('  → Đã điền password');
  await delay(500);
  await clickSubmit(el);
  
  // NÂNG CẤP: Chờ 1.5s rồi tự động phân tích DOM để chạy tiếp bước 3 (nếu có)
  log('⏳ Đã gửi Password, đang chờ form tiếp theo...');
  await delay(1500);
  await detectAndFill(creds, 0); 
}

async function stepOtp(creds) {
  log('🔐 Bước 3: OTP/2FA');
  if (!creds.twofa || !creds.twofa.trim()) {
    log('  → Không có 2FA, kết thúc.');
    chrome.storage.local.set({ autologin_active: false });
    return;
  }

  const otpCode = await resolveTwoFa(creds.twofa); 
  log('  → Mã OTP tính được:', otpCode);

  const el = await waitForVisibleElement([
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[name="code"]', 'input[name="mfa_code"]',
    'input[name="totp"]', 'input[type="number"]'
  ], 10000).catch(() => null);

  if (!el) { log('⚠️ Không tìm thấy ô OTP'); return; }

  const boxes = document.querySelectorAll(
    'input[inputmode="numeric"][maxlength="1"], ' +
    'input[type="text"][maxlength="1"]'
  );
  
  if (boxes.length >= 6) {
    const digits = otpCode.split('');
    for (let i = 0; i < boxes.length && i < digits.length; i++) {
      if(isVisible(boxes[i])) {
        boxes[i].focus();
        await delay(80);
        fillInput(boxes[i], digits[i]);
      }
    }
  } else {
    el.focus();
    await delay(300);
    fillInput(el, otpCode);
  }

  log('  → Đã điền OTP:', otpCode);
  await delay(500);
  await clickSubmit(el);
  await delay(2000);
  chrome.storage.local.set({ autologin_active: false });
}

// ══════════════════════════════════════════════════════════
//  DETECT STEP & DISPATCH
// ══════════════════════════════════════════════════════════

async function detectAndFill(creds, attempt = 0) {
  if (attempt > 15) { log('❌ Quá nhiều lần thử tìm form, dừng'); return; }

  const selEmail    = 'input[type="email"], input[name="email"], input[name="username"]';
  const selPassword = 'input[type="password"], input[name="password"]';
  const selOtp      = 'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name="code"]';

  // Chỉ lấy những thẻ thực sự hiển thị
  const checkVisible = (sel) => {
    const els = document.querySelectorAll(sel);
    for (let e of els) if (isVisible(e)) return true;
    return false;
  };

  const hasOtp      = checkVisible(selOtp);
  const hasPassword = checkVisible(selPassword);
  const hasEmail    = checkVisible(selEmail);

  log(`Detect [attempt=${attempt}]: email=${hasEmail} | pw=${hasPassword} | otp=${hasOtp}`);

  if (hasOtp && !hasPassword) {
    await stepOtp(creds);
  } else if (hasPassword && !hasOtp) {
    await stepPassword(creds);
  } else if (hasEmail && !hasPassword && !hasOtp) {
    await stepEmail(creds);
  } else if (hasPassword && hasOtp) {
    await stepPassword(creds);
  } else {
    log('⏳ Đang phân tích DOM, thử lại sau 1s...');
    await delay(1000);
    await detectAndFill(creds, attempt + 1);
  }
}

function log(...args) {
  console.log('[AutoLogin]', ...args);
}

// ══════════════════════════════════════════════════════════
//  MESSAGE LISTENER & BOOTSTRAP
// ══════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  sendResponse({ ok: true }); 
  const url = window.location.href;

  if (msg.action === 'bg_autofill' || msg.action === 'autofill') {
    log(`📩 Lệnh (${msg.action}):`, url);
    if (!isCredentialUrl(url)) return;
    (async () => {
      await delay(500);
      await detectAndFill({ email: msg.email, password: msg.password, twofa: msg.twofa });
    })();
  }

  if (msg.action === 'stop_autologin') {
    chrome.storage.local.set({ autologin_active: false });
  }

  if (msg.action === 'start_mfa_flow') {
    log('🔄 Nhận lệnh bắt đầu MFA flow...');
    (async () => {
      if (typeof startMfaFlow === 'function') {
        await startMfaFlow({
          email:    msg.email    || '',
          password: msg.password || '',
          twofa:    msg.twofa    || ''
        });
      } else {
        log('❌ startMfaFlow không tồn tại – mfa_flow.js chưa được load');
      }
    })();
  }
});

(async function autoStart() {
  const data = await chrome.storage.local.get(['autologin_active', 'mfa_phase', 'currentIdx', 'accountsRaw']);
  
  // Bỏ qua nếu MFA flow đang chạy
  if (data.mfa_phase === 'running' || data.mfa_phase === 'navigating') {
    log('⏭️ MFA flow đang chạy, bỏ qua autoStart');
    return;
  }
  
  if (!data.autologin_active) return;

  const accounts = (data.accountsRaw || '').split('\n')
    .map(l => { const p = l.trim().split('|'); return { email: p[0]?.trim(), password: p[1]?.trim(), twofa: p[2]?.trim() || '' }; })
    .filter(a => a.email);
  const idx  = typeof data.currentIdx === 'number' ? data.currentIdx : 0;
  const creds = accounts[idx];
  if (!creds) return;

  const url = window.location.href;
  log('🚀 Auto-start on:', url);

  // Bỏ qua nếu đang ở trang settings
  if (url.includes('#settings')) {
    log('⏭️ Đang ở trang settings, bỏ qua autoStart');
    return;
  }

  await delay(1000);
  if (isCredentialUrl(url)) {
    await detectAndFill(creds);
  }
})();
