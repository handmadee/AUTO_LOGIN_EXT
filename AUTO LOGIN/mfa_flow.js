/* ========================================================
   mfa_flow.js – MFA Automation State Machine (v2 FIXED)
   
   Tự động quản lý MFA (bật/tắt/reset) sau khi đăng nhập
   ChatGPT thành công.
   
   Background.js đã navigate thẳng tới:
     https://chatgpt.com/#settings/Security
   nên mfa_flow.js chỉ cần thao tác trên trang Security.
   
   Phụ thuộc: totp.js (generateTOTP, isTotpSecret)
              content.js (fillInput, isVisible)
   ======================================================== */

const MFA_DELAY = ms => new Promise(r => setTimeout(r, ms));

function mfaLog(...args) {
  console.log('[MFA]', ...args);
}

// ══════════════════════════════════════════════════════════
//  ELEMENT FINDING UTILITIES
// ══════════════════════════════════════════════════════════

/**
 * Tìm element hiển thị theo CSS selector
 */
function mfaFindVisible(selector) {
  const els = document.querySelectorAll(selector);
  for (const el of els) {
    if (el.offsetWidth > 0 && el.offsetHeight > 0) return el;
  }
  return null;
}

/**
 * Tìm element chứa ĐÚNG text (direct text, không lấy nested quá sâu)
 * Hỗ trợ EN + VI
 */
function mfaFindByText(texts, tagSelector) {
  if (!Array.isArray(texts)) texts = [texts];
  const defaultTags = 'button, a, [role="button"], [role="menuitem"], [role="tab"], [role="switch"], span, label, p, h2, h3, h4';
  const sel = tagSelector || defaultTags;
  const lowerTexts = texts.map(t => t.toLowerCase());

  const candidates = document.querySelectorAll(sel);
  for (const el of candidates) {
    if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
    // Lấy direct text (không quá dài để tránh match container)
    const t = el.textContent.trim().toLowerCase();
    if (t.length > 200) continue; // Skip container elements
    for (const lt of lowerTexts) {
      if (t === lt || t.includes(lt)) return el;
    }
  }
  return null;
}

/**
 * Tìm nút bấm chứa text (chỉ tìm trong clickable elements)
 */
function mfaFindClickable(texts) {
  return mfaFindByText(
    texts,
    'button, a, [role="button"], [role="menuitem"], [role="tab"], [role="switch"], [role="option"]'
  );
}

/**
 * Chờ element xuất hiện bằng MutationObserver (nhanh hơn polling)
 */
function mfaWaitFor(finderFn, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const el = finderFn();
    if (el) return resolve(el);

    const obs = new MutationObserver(() => {
      const found = finderFn();
      if (found) { obs.disconnect(); clearTimeout(t); resolve(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true, attributes: true });
    const t = setTimeout(() => { obs.disconnect(); reject(new Error('Timeout')); }, timeout);
  });
}

/**
 * Click an toàn
 */
async function mfaSafeClick(el) {
  if (!el) throw new Error('Element null');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await MFA_DELAY(300);
  el.click();
  await MFA_DELAY(600);
}

/**
 * fillInput wrapper
 */
function mfaFillInput(el, value) {
  if (typeof fillInput === 'function') {
    fillInput(el, value);
  } else {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    ['input', 'change', 'blur'].forEach(e =>
      el.dispatchEvent(new Event(e, { bubbles: true }))
    );
  }
}

// ══════════════════════════════════════════════════════════
//  PROGRESS REPORTING
// ══════════════════════════════════════════════════════════

function reportMfaProgress(step, status, data) {
  chrome.storage.local.set({
    mfa_progress: Object.assign({ step: step, status: status, timestamp: Date.now() }, data || {})
  });
}

function reportMfaResult(success, secret, error) {
  chrome.storage.local.set({
    mfa_result: {
      success: success,
      secret: secret || '',
      error:   error || '',
      timestamp: Date.now()
    },
    mfa_phase: success ? 'done' : 'error'
  });
}

// ══════════════════════════════════════════════════════════
//  MFA FLOW – TỪNG BƯỚC
// ══════════════════════════════════════════════════════════

// ── 1. Chờ trang Settings/Security load xong ─────────────
async function mfaWaitForSecurityPage() {
  mfaLog('📋 Chờ trang Security settings load...');
  reportMfaProgress('settings', 'active');

  // Trang đã được navigate tới #settings/Security bởi background.js
  // Chờ settings dialog và security content xuất hiện
  
  // Chờ tối đa 15s cho trang load
  for (let attempt = 0; attempt < 30; attempt++) {
    await MFA_DELAY(500);
    
    // Kiểm tra URL đúng chưa
    if (!window.location.hash.includes('settings')) {
      mfaLog('⚠️ Chưa ở trang settings, navigate lại...');
      window.location.hash = '#settings/Security';
      await MFA_DELAY(2000);
    }
    
    // Tìm dấu hiệu trang Security đã load:
    // - Text "Multi-factor" / "Xác thực đa yếu tố"
    // - Text "Security" / "Bảo mật" trong heading/tab
    // - Nút enable/disable MFA
    const securityText = mfaFindByText(
      ['multi-factor', 'xác thực đa yếu tố', 'multi-factor authentication',
       'authenticator app', 'ứng dụng xác thực'],
      'span, div, p, h2, h3, h4, label, button'
    );
    
    if (securityText) {
      mfaLog('✅ Trang Security đã load');
      return;
    }

    // Thử click tab Security nếu settings modal mở nhưng ở tab khác
    if (attempt === 5 || attempt === 10) {
      const secTab = mfaFindClickable([
        'security', 'bảo mật', 'security & login',
        'bảo mật và đăng nhập'
      ]);
      if (secTab) {
        mfaLog('🔒 Click tab Security...');
        await mfaSafeClick(secTab);
        await MFA_DELAY(1500);
      }
    }
  }

  throw new Error('Trang Security settings không load được');
}

// ── 2. Nhập lại password (nếu ChatGPT yêu cầu) ────────
async function mfaHandlePasswordReentry(password) {
  const pwInput = mfaFindVisible('input[type="password"]');
  if (!pwInput || !password) return;

  mfaLog('🔑 Nhập lại mật khẩu để xác minh...');
  pwInput.focus();
  mfaFillInput(pwInput, password);
  await MFA_DELAY(500);

  const submitBtn = mfaFindClickable([
    'continue', 'tiếp tục', 'verify', 'xác minh', 'submit', 'gửi'
  ]);
  if (submitBtn) await mfaSafeClick(submitBtn);
  else {
    pwInput.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true
    }));
  }
  await MFA_DELAY(2500);
}

// ── 3. Kiểm tra trạng thái MFA ──────────────────────────
async function mfaCheckStatus() {
  mfaLog('🔍 Kiểm tra trạng thái MFA...');
  reportMfaProgress('check_mfa', 'active');
  await MFA_DELAY(1000);

  // Tìm khu vực MFA trên trang
  const mfaSection = mfaFindByText(
    ['multi-factor', 'xác thực đa yếu tố', 'mfa', 'two-factor', '2fa'],
    'div, section, h2, h3, h4, span, label'
  );

  if (mfaSection) {
    // Tìm trong vùng lân cận của MFA section
    const parent = mfaSection.closest('div[class], section') || mfaSection.parentElement?.parentElement || document.body;
    const parentText = parent.textContent.toLowerCase();

    // Kiểm tra có nút Disable/Turn off không → MFA đang BẬT
    const btns = parent.querySelectorAll('button, a, [role="button"], [role="switch"]');
    for (const btn of btns) {
      if (btn.offsetWidth === 0 || btn.offsetHeight === 0) continue;
      const bt = btn.textContent.trim().toLowerCase();
      if (bt.includes('disable') || bt.includes('tắt') || bt.includes('turn off') || bt.includes('remove')) {
        mfaLog('🔒 MFA đang BẬT (tìm thấy nút disable)');
        return true;
      }
    }

    // Kiểm tra toggle switch
    const toggleOn = parent.querySelector('[role="switch"][aria-checked="true"]');
    if (toggleOn) {
      mfaLog('🔒 MFA đang BẬT (toggle on)');
      return true;
    }

    // Kiểm tra text "enabled" / "đã bật"
    if (parentText.includes('enabled') || parentText.includes('đã bật') || parentText.includes('on')) {
      mfaLog('🔒 MFA đang BẬT (text indicator)');
      return true;
    }
  }

  // Fallback: tìm toàn trang
  const disableBtn = mfaFindClickable(['disable', 'tắt', 'turn off', 'vô hiệu hóa']);
  if (disableBtn) {
    mfaLog('🔒 MFA đang BẬT (global disable button)');
    return true;
  }

  mfaLog('🔓 MFA đang TẮT');
  return false;
}

// ── 4. Tắt MFA ──────────────────────────────────────────
async function mfaDisable(currentSecret) {
  mfaLog('🔓 Tắt MFA...');
  reportMfaProgress('disable_mfa', 'active');

  // Tìm nút tắt
  const disableBtn = mfaFindClickable([
    'disable', 'tắt', 'turn off', 'vô hiệu hóa',
    'remove', 'xóa', 'gỡ bỏ'
  ]);
  const toggle = document.querySelector('[role="switch"][aria-checked="true"]');

  if (disableBtn)    await mfaSafeClick(disableBtn);
  else if (toggle)   await mfaSafeClick(toggle);
  else throw new Error('Không tìm thấy nút tắt MFA');

  await MFA_DELAY(2000);

  // Có thể cần nhập OTP cũ để xác nhận tắt
  const otpInput = mfaFindVisible(
    'input[type="text"], input[type="number"], input[inputmode="numeric"], ' +
    'input[autocomplete="one-time-code"], input[name="code"], input[name="totp"]'
  );

  if (otpInput && currentSecret) {
    mfaLog('🔑 Nhập OTP cũ để xác nhận tắt...');
    let otpCode = '';
    if (typeof isTotpSecret === 'function' && isTotpSecret(currentSecret)) {
      otpCode = await generateTOTP(currentSecret);
    } else {
      otpCode = currentSecret;
    }

    if (otpCode) {
      // Ô nhập từng số
      const boxes = document.querySelectorAll(
        'input[inputmode="numeric"][maxlength="1"], input[type="text"][maxlength="1"]'
      );

      if (boxes.length >= 6) {
        const digits = otpCode.split('');
        for (let i = 0; i < boxes.length && i < digits.length; i++) {
          if (boxes[i].offsetWidth > 0) {
            boxes[i].focus();
            await MFA_DELAY(80);
            mfaFillInput(boxes[i], digits[i]);
          }
        }
      } else {
        otpInput.focus();
        await MFA_DELAY(200);
        mfaFillInput(otpInput, otpCode);
      }

      await MFA_DELAY(600);

      const confirmBtn = mfaFindClickable([
        'confirm', 'xác nhận', 'continue', 'tiếp tục',
        'verify', 'xác minh', 'submit', 'gửi',
        'disable', 'tắt', 'done', 'hoàn tất'
      ]);
      if (confirmBtn) await mfaSafeClick(confirmBtn);
      else {
        otpInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true
        }));
      }
    }
  } else {
    // Chỉ cần confirm dialog
    await MFA_DELAY(500);
    const confirmBtn = mfaFindClickable([
      'confirm', 'xác nhận', 'yes', 'có', 'ok',
      'disable', 'tắt', 'continue', 'tiếp tục'
    ]);
    if (confirmBtn) await mfaSafeClick(confirmBtn);
  }

  await MFA_DELAY(2500);
  mfaLog('✅ Đã tắt MFA');
}

// ── 5. Bật MFA ───────────────────────────────────────────
async function mfaEnable() {
  mfaLog('🔒 Bật MFA...');
  reportMfaProgress('enable_mfa', 'active');

  // Tìm nút enable trong vùng MFA
  const enableBtn = await mfaWaitFor(
    () => mfaFindClickable([
      'enable', 'bật', 'turn on', 'set up',
      'thiết lập', 'kích hoạt', 'add', 'thêm'
    ]),
    10000
  ).catch(() => null);

  const toggle = document.querySelector('[role="switch"][aria-checked="false"]');

  if (enableBtn)     await mfaSafeClick(enableBtn);
  else if (toggle)   await mfaSafeClick(toggle);
  else throw new Error('Không tìm thấy nút bật MFA');

  await MFA_DELAY(2500);

  // Có thể cần chọn phương thức: "Authenticator app"
  const authAppBtn = mfaFindClickable([
    'authenticator app', 'ứng dụng xác thực', 'authenticator',
    'google authenticator', 'totp'
  ]);
  if (authAppBtn) {
    await mfaSafeClick(authAppBtn);
    await MFA_DELAY(2000);
  }

  mfaLog('✅ Đã click bật MFA');
}

// ── 6. Click "Can't scan" ────────────────────────────────
async function mfaClickCantScan() {
  mfaLog('📱 Click "Can\'t scan"...');
  reportMfaProgress('cant_scan', 'active');
  await MFA_DELAY(1500);

  const cantScanTexts = [
    "can't scan", "không thể quét", "cannot scan", "can not scan",
    "enter manually", "nhập thủ công", "setup key", "enter setup key",
    "nhập khóa", "manual entry", "enter a setup key",
    "nhập mã thiết lập", "can't scan it", "unable to scan",
    "enter key manually", "nhập key", "enter key",
    "can't scan the qr", "không quét được"
  ];

  // Tìm trong clickable elements
  let cantScanBtn = await mfaWaitFor(
    () => mfaFindClickable(cantScanTexts),
    12000
  ).catch(() => null);

  // Fallback: tìm trong tất cả elements (có thể là span, div clickable)
  if (!cantScanBtn) {
    cantScanBtn = mfaFindByText(cantScanTexts,
      'button, a, span, div, [role="button"], [class*="link"], [class*="click"]'
    );
  }

  // Fallback: tìm trong dialog/modal area
  if (!cantScanBtn) {
    const dialogs = document.querySelectorAll(
      '[role="dialog"], [role="presentation"], [class*="modal"], [class*="dialog"], [class*="popover"]'
    );
    for (const dialog of dialogs) {
      if (dialog.offsetWidth === 0) continue;
      const els = dialog.querySelectorAll('a, button, span, [role="button"]');
      for (const el of els) {
        if (el.offsetWidth === 0) continue;
        const t = el.textContent.toLowerCase().trim();
        if (t.length > 100) continue;
        for (const text of cantScanTexts) {
          if (t.includes(text)) {
            cantScanBtn = el;
            break;
          }
        }
        if (cantScanBtn) break;
      }
      if (cantScanBtn) break;
    }
  }

  if (!cantScanBtn) throw new Error('Không tìm thấy nút "Can\'t scan" / "Không thể quét"');

  await mfaSafeClick(cantScanBtn);
  await MFA_DELAY(2000);
  mfaLog('✅ Đã click "Can\'t scan"');
}

// ── 7. Trích xuất TOTP Secret ────────────────────────────
async function mfaExtractSecret() {
  mfaLog('🔑 Trích xuất TOTP Secret...');
  reportMfaProgress('extract_secret', 'active');
  await MFA_DELAY(1500);

  let secret = null;

  // S1: code / pre / mono-spaced elements  
  const codeEls = document.querySelectorAll(
    'code, pre, .secret-key, [data-testid*="secret"], [data-testid*="key"], ' +
    '.monospace, .font-mono, [class*="mono"], [class*="code"], kbd'
  );
  for (const el of codeEls) {
    if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
    const text = el.textContent.trim().replace(/[\s\-=]/g, '');
    if (text.length >= 16 && /^[A-Z2-7]+$/i.test(text)) {
      secret = text.toUpperCase();
      mfaLog('  → Found in code/mono element');
      break;
    }
  }

  // S2: Input fields (readonly / disabled / với value dài)
  if (!secret) {
    const inputs = document.querySelectorAll('input');
    for (const inp of inputs) {
      const val = (inp.value || '').trim().replace(/[\s\-=]/g, '');
      if (val.length >= 16 && /^[A-Z2-7]+$/i.test(val)) {
        secret = val.toUpperCase();
        mfaLog('  → Found in input field');
        break;
      }
    }
  }

  // S3: Visible text matching Base32 pattern (leaf nodes only)
  if (!secret) {
    const allEls = document.querySelectorAll('span, div, p, td, li, label, strong, b');
    for (const el of allEls) {
      if (el.children.length > 2) continue; // Chỉ lấy leaf-ish nodes
      if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
      const rawText = el.textContent.trim();
      if (rawText.length > 100) continue; // Skip quá dài
      const text = rawText.replace(/[\s\-=]/g, '');
      if (text.length >= 16 && text.length <= 64 && /^[A-Z2-7]+$/i.test(text)) {
        secret = text.toUpperCase();
        mfaLog('  → Found in visible text:', rawText.substring(0, 20) + '...');
        break;
      }
    }
  }

  // S4: Regex toàn trang trong dialog area
  if (!secret) {
    const dialogs = document.querySelectorAll(
      '[role="dialog"], [role="presentation"], [class*="modal"], [class*="dialog"]'
    );
    for (const dialog of dialogs) {
      if (dialog.offsetWidth === 0) continue;
      const text = dialog.textContent;
      const matches = text.match(/[A-Z2-7]{16,64}/gi);
      if (matches) {
        // Lấy match dài nhất (likely là secret key)
        matches.sort((a, b) => b.length - a.length);
        secret = matches[0].toUpperCase();
        mfaLog('  → Found by regex in dialog');
        break;
      }
    }
  }

  // S5: Regex toàn body (last resort)
  if (!secret) {
    const bodyText = document.body.innerText;
    const matches = bodyText.match(/[A-Z2-7]{16,64}/gi);
    if (matches) {
      // Lọc: chỉ lấy chuỗi thuần Base32 (không phải từ tiếng Anh)
      for (const m of matches) {
        if (m.length >= 16 && /[2-7]/.test(m)) { // Base32 có số 2-7
          secret = m.toUpperCase();
          mfaLog('  → Found by regex in body');
          break;
        }
      }
    }
  }

  if (!secret) throw new Error('Không thể trích xuất TOTP Secret Key');

  mfaLog('✅ Secret:', secret.substring(0, 6) + '••••••' + ' (len=' + secret.length + ')');
  return secret;
}

// ── 8. Điền OTP xác minh ─────────────────────────────────
async function mfaFillVerifyOtp(newSecret) {
  mfaLog('📝 Điền OTP xác minh...');
  reportMfaProgress('verify_otp', 'active');

  const otpCode = await generateTOTP(newSecret);
  mfaLog('  → OTP:', otpCode);

  await MFA_DELAY(600);

  // Tìm ô nhập OTP
  const otpInput = await mfaWaitFor(
    () => mfaFindVisible(
      'input[autocomplete="one-time-code"], input[inputmode="numeric"], ' +
      'input[name="code"], input[name="totp"], input[name="mfa_code"], ' +
      'input[type="number"], input[type="text"]'
    ),
    10000
  ).catch(() => null);

  if (!otpInput) throw new Error('Không tìm thấy ô nhập OTP');

  // Ô nhập từng số
  const boxes = document.querySelectorAll(
    'input[inputmode="numeric"][maxlength="1"], input[type="text"][maxlength="1"]'
  );

  if (boxes.length >= 6) {
    const digits = otpCode.split('');
    for (let i = 0; i < boxes.length && i < digits.length; i++) {
      if (boxes[i].offsetWidth > 0) {
        boxes[i].focus();
        await MFA_DELAY(80);
        mfaFillInput(boxes[i], digits[i]);
      }
    }
  } else {
    otpInput.focus();
    await MFA_DELAY(300);
    mfaFillInput(otpInput, otpCode);
  }

  mfaLog('  → Đã điền OTP');
  await MFA_DELAY(600);

  // Click verify / confirm
  const verifyBtn = mfaFindClickable([
    'verify', 'xác minh', 'confirm', 'xác nhận',
    'continue', 'tiếp tục', 'submit', 'gửi',
    'done', 'hoàn tất', 'enable', 'bật'
  ]);

  if (verifyBtn) {
    await mfaSafeClick(verifyBtn);
  } else {
    const form = otpInput.closest('form');
    const btn = form ? form.querySelector('button[type="submit"], button') : null;
    if (btn) await mfaSafeClick(btn);
    else {
      otpInput.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true
      }));
    }
  }

  await MFA_DELAY(2500);
  mfaLog('✅ Đã xác minh OTP');
}

// ── 9. Lưu kết quả ──────────────────────────────────────
async function mfaSaveResult(newSecret, accountData) {
  mfaLog('💾 Lưu kết quả...');
  reportMfaProgress('save_result', 'active');

  // Cập nhật accountsRaw: thay thế cột 2FA của account hiện tại
  const data = await chrome.storage.local.get(['accountsRaw', 'currentIdx']);
  const raw  = data.accountsRaw || '';
  const idx  = typeof data.currentIdx === 'number' ? data.currentIdx : 0;

  const lines = raw.split('\n');
  let lineIdx = 0;
  let accountLineIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (lineIdx === idx) { accountLineIdx = i; break; }
    lineIdx++;
  }

  if (accountLineIdx >= 0) {
    const parts = lines[accountLineIdx].split('|').map(p => p.trim());
    parts[2] = newSecret;
    lines[accountLineIdx] = parts.join('|');
    await chrome.storage.local.set({
      accountsRaw: lines.join('\n'),
      mfa_new_secret: newSecret
    });
    mfaLog('✅ Đã cập nhật secret vào tài khoản dòng', accountLineIdx + 1);
  } else {
    await chrome.storage.local.set({ mfa_new_secret: newSecret });
    mfaLog('⚠️ Không tìm thấy dòng tài khoản, secret lưu riêng');
  }

  // Copy vào clipboard
  try {
    await navigator.clipboard.writeText(newSecret);
    mfaLog('📋 Đã copy secret vào clipboard');
  } catch (e) {
    mfaLog('⚠️ Không thể copy clipboard');
  }

  reportMfaResult(true, newSecret);
}

// ══════════════════════════════════════════════════════════
//  MAIN MFA FLOW
// ══════════════════════════════════════════════════════════

async function startMfaFlow(accountData) {
  mfaLog('🚀 ═══════════════════════════════════');
  mfaLog('🚀 BẮT ĐẦU MFA AUTOMATION FLOW');
  mfaLog('🚀 Account:', accountData.email);
  mfaLog('🚀 URL:', window.location.href);
  mfaLog('🚀 ═══════════════════════════════════');

  try {
    // 1. Chờ trang Security settings load
    await mfaWaitForSecurityPage();
    await MFA_DELAY(1000);

    // 2. Nhập lại password nếu cần
    await mfaHandlePasswordReentry(accountData.password);

    // 3. Kiểm tra trạng thái MFA
    const mfaEnabled = await mfaCheckStatus();

    // 4. Nếu đã bật → tắt trước
    if (mfaEnabled) {
      mfaLog('🔄 MFA đang bật → Tắt rồi bật lại...');
      await mfaDisable(accountData.twofa);
      await MFA_DELAY(2500);

      // Chờ trang refresh sau khi disable
      await mfaWaitForSecurityPage();
      await MFA_DELAY(1500);
    }

    // 5. Bật MFA
    await mfaEnable();
    await MFA_DELAY(2000);

    // 6. Click "Can't scan"
    await mfaClickCantScan();
    await MFA_DELAY(1500);

    // 7. Trích xuất TOTP secret
    const newSecret = await mfaExtractSecret();

    // 8. Điền OTP xác minh
    await mfaFillVerifyOtp(newSecret);

    // 9. Lưu kết quả
    await mfaSaveResult(newSecret, accountData);

    mfaLog('✅ ═══════════════════════════════════');
    mfaLog('✅ MFA AUTOMATION HOÀN TẤT!');
    mfaLog('✅ Secret:', newSecret.substring(0, 6) + '••••••');
    mfaLog('✅ ═══════════════════════════════════');

    // Tắt flags
    chrome.storage.local.set({
      autologin_active: false,
      mfa_phase: 'done'
    });

  } catch (err) {
    mfaLog('❌ ═══════════════════════════════════');
    mfaLog('❌ MFA FLOW LỖI:', err.message);
    mfaLog('❌ ═══════════════════════════════════');

    reportMfaResult(false, '', err.message);
    chrome.storage.local.set({
      autologin_active: false,
      mfa_phase: 'error'
    });
  }
}
