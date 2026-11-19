/* ========================================================
   popup.js – ChatGPT Auto Login Extension
   ======================================================== */

// ── DOM refs ──────────────────────────────────────────────
const totalCountEl    = document.getElementById('totalCount');
const currentIndexEl  = document.getElementById('currentIndex');
const remainCountEl   = document.getElementById('remainCount');
const currentAccountBox = document.getElementById('currentAccountBox');
const currentEmailEl  = document.getElementById('currentEmail');
const currentPasswordEl = document.getElementById('currentPassword');
const current2faEl    = document.getElementById('current2fa');
const accountListTA   = document.getElementById('accountList');
const btnPaste        = document.getElementById('btnPaste');
const btnClear        = document.getElementById('btnClear');
const btnSave         = document.getElementById('btnSave');
const btnLogin        = document.getElementById('btnLogin');
const btnStop         = document.getElementById('btnStop');
const btnPrev         = document.getElementById('btnPrev');
const btnNext         = document.getElementById('btnNext');
const navIndicator    = document.getElementById('navIndicator');
const statusBar       = document.getElementById('statusBar');
const accountListSection = document.getElementById('accountListSection');
const accountItemsEl  = document.getElementById('accountItems');
const autoFlowEl      = document.getElementById('autoFlow');
const dot1El = document.getElementById('dot1');
const dot2El = document.getElementById('dot2');
const dot3El = document.getElementById('dot3');
const line1El = document.getElementById('line1');
const line2El = document.getElementById('line2');
const flowStep1 = document.getElementById('flowStep1');
const flowStep2 = document.getElementById('flowStep2');
const flowStep3 = document.getElementById('flowStep3');
const flowStep4 = document.getElementById('flowStep4');

// MFA elements
const mfaToggle       = document.getElementById('mfaToggle');
const passkeyRedirectToggle = document.getElementById('passkeyRedirectToggle');
const mfaResultCard   = document.getElementById('mfaResultCard');
const mfaSecretEl     = document.getElementById('mfaSecret');
const mfaResultStatus = document.getElementById('mfaResultStatus');
const btnCopySecret   = document.getElementById('btnCopySecret');
const line3El         = document.getElementById('line3');
const dot4El          = document.getElementById('dot4');

// ── State ─────────────────────────────────────────────────
let accounts = [];   // [{email, password, twofa}]
let currentIdx = 0;

// ── Helpers ───────────────────────────────────────────────
function parseAccounts(text) {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
    .map(line => {
      // Support separator: | or :
      const parts = line.split(/\|/).map(p => p.trim());
      return {
        email:    parts[0] || '',
        password: parts[1] || '',
        twofa:    parts[2] || ''
      };
    })
    .filter(a => a.email.length > 0);
}

function maskPassword(pw) {
  if (!pw) return '(trống)';
  if (pw.length <= 4) return '*'.repeat(pw.length);
  return pw.substring(0, 2) + '*'.repeat(pw.length - 4) + pw.substring(pw.length - 2);
}

function showStatus(msg, type = 'info') {
  statusBar.textContent = msg;
  statusBar.className = `status-bar visible ${type}`;
  setTimeout(() => {
    statusBar.className = 'status-bar';
    statusBar.textContent = '';
  }, 3500);
}

function updateUI() {
  const total = accounts.length;
  totalCountEl.textContent  = total;
  currentIndexEl.textContent = total > 0 ? currentIdx + 1 : '–';
  remainCountEl.textContent = Math.max(0, total - currentIdx - 1);
  navIndicator.textContent  = total > 0 ? `${currentIdx + 1}/${total}` : '–/–';

  btnPrev.disabled = currentIdx <= 0;
  btnNext.disabled = currentIdx >= total - 1;

  if (total > 0) {
    const acc = accounts[currentIdx];
    currentAccountBox.style.display = 'flex';
    currentEmailEl.textContent    = acc.email;
    currentPasswordEl.textContent = '🔑 ' + maskPassword(acc.password);

    // Hiển thị 2FA: nếu là secret key thì che bớt, nếu là OTP thì hiện nguyên
    if (acc.twofa) {
      const isSecret = isTotpSecret(acc.twofa);
      current2faEl.textContent = isSecret
        ? '🔐 Secret: ' + acc.twofa.substring(0, 6) + '••••••••'
        : '🔐 OTP: ' + acc.twofa;
      current2faEl.style.display = 'block';
    } else {
      current2faEl.style.display = 'none';
    }

    accountListSection.style.display = 'flex';
    renderAccountItems();

    // Khởi động TOTP live display nếu có secret key
    startTotpDisplay(acc.twofa);
  } else {
    currentAccountBox.style.display = 'none';
    accountListSection.style.display = 'none';
    stopTotpDisplay();
  }
}


function renderAccountItems() {
  accountItemsEl.innerHTML = '';
  accounts.forEach((acc, i) => {
    const item = document.createElement('div');
    item.className = 'account-item' + (i === currentIdx ? ' active' : '');
    item.innerHTML = `
      <div class="item-num">${i + 1}</div>
      <div class="item-email">${acc.email}</div>
      ${acc.twofa ? '<div class="item-has2fa">2FA</div>' : ''}
    `;
    item.addEventListener('click', () => {
      currentIdx = i;
      chrome.storage.local.set({ currentIdx });
      updateUI();
    });
    accountItemsEl.appendChild(item);
  });
}

// ── Load from storage ─────────────────────────────────────
chrome.storage.local.get(['accountsRaw', 'currentIdx'], (data) => {
  if (data.accountsRaw) {
    accountListTA.value = data.accountsRaw;
    accounts = parseAccounts(data.accountsRaw);
  }
  currentIdx = typeof data.currentIdx === 'number' ? data.currentIdx : 0;
  if (currentIdx >= accounts.length) currentIdx = 0;
  updateUI();
});

// ── Load post-login action toggles ────────────────────────
chrome.storage.local.get(['mfa_reset_enabled', 'passkey_redirect_enabled'], (data) => {
  const hasPasskeyPreference = typeof data.passkey_redirect_enabled === 'boolean';

  // Migration: trước đây mfa_reset_enabled đang kiêm luôn việc redirect passkey.
  // Chuyển lựa chọn cũ sang toggle mới để hành vi hiện tại không bị đổi bất ngờ.
  if (!hasPasskeyPreference) {
    passkeyRedirectToggle.checked = !!data.mfa_reset_enabled;
    mfaToggle.checked = false;
    chrome.storage.local.set({
      passkey_redirect_enabled: passkeyRedirectToggle.checked,
      mfa_reset_enabled: false
    });
    return;
  }

  passkeyRedirectToggle.checked = !!data.passkey_redirect_enabled;
  mfaToggle.checked = !!data.mfa_reset_enabled && !passkeyRedirectToggle.checked;
});

mfaToggle.addEventListener('change', () => {
  if (mfaToggle.checked) {
    passkeyRedirectToggle.checked = false;
  }
  chrome.storage.local.set({
    mfa_reset_enabled: mfaToggle.checked,
    passkey_redirect_enabled: passkeyRedirectToggle.checked
  });
  if (mfaToggle.checked) {
    showStatus('🔄 MFA Reset sẽ chạy sau khi đăng nhập thành công', 'info');
  }
});

passkeyRedirectToggle.addEventListener('change', () => {
  if (passkeyRedirectToggle.checked) {
    mfaToggle.checked = false;
  }
  chrome.storage.local.set({
    passkey_redirect_enabled: passkeyRedirectToggle.checked,
    mfa_reset_enabled: mfaToggle.checked
  });
  showStatus(
    passkeyRedirectToggle.checked
      ? '🔑 Login xong sẽ mở trang đăng ký Passkey'
      : '✅ Login xong sẽ giữ nguyên tại ChatGPT',
    'info'
  );
});

// ── Events ────────────────────────────────────────────────

// Paste from clipboard
btnPaste.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text.trim()) {
      accountListTA.value = text.trim();
      showStatus('✅ Đã dán từ clipboard!', 'success');
    } else {
      showStatus('⚠️ Clipboard trống!', 'error');
    }
  } catch (e) {
    showStatus('❌ Không thể đọc clipboard. Hãy dán thủ công.', 'error');
  }
});

// Clear
btnClear.addEventListener('click', () => {
  accountListTA.value = '';
  accounts = [];
  currentIdx = 0;
  chrome.storage.local.set({ accountsRaw: '', currentIdx: 0 });
  updateUI();
  showStatus('🗑️ Đã xoá danh sách', 'info');
});

// Save
btnSave.addEventListener('click', () => {
  const raw = accountListTA.value.trim();
  accounts = parseAccounts(raw);
  if (currentIdx >= accounts.length) currentIdx = 0;
  chrome.storage.local.set({ accountsRaw: raw, currentIdx });
  updateUI();
  showStatus(`✅ Đã lưu ${accounts.length} tài khoản!`, 'success');
});

// Login
btnLogin.addEventListener('click', async () => {
  if (accounts.length === 0) {
    showStatus('⚠️ Chưa có tài khoản nào! Hãy nhập và lưu trước.', 'error');
    return;
  }
  const acc = accounts[currentIdx];
  if (!acc.email || !acc.password) {
    showStatus('⚠️ Tài khoản hoặc mật khẩu bị trống!', 'error');
    return;
  }

  btnLogin.disabled = true;
  clearMfaResult();
  showStatus('🔐 Đang mở trang đăng nhập...', 'info');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabUrl = tab?.url || '';
  const isOnChatGPT = tabUrl.includes('chatgpt.com') ||
    tabUrl.includes('auth.openai.com') ||
    tabUrl.includes('auth0.openai.com');

  // Lưu account trước khi background mở trang login.
  await chrome.storage.local.set({
    autologin_active: false,
    currentIdx,
    accountsRaw: accountListTA.value.trim()
  });

  await chrome.storage.local.remove([
    'post_login_redirect_pending',
    'post_login_redirect_tab_id',
    'post_login_started_at'
  ]);

  let startResult;
  try {
    startResult = await chrome.runtime.sendMessage({
      action: 'start_login',
      preferredTabId: tab && isOnChatGPT ? tab.id : null,
      enablePostLoginRedirect: passkeyRedirectToggle.checked
    });
  } catch (error) {
    startResult = { ok: false, error: error?.message };
  }

  if (!startResult?.ok) {
    btnLogin.disabled = false;
    showStatus(
      `❌ Không thể mở đăng nhập: ${startResult?.error || 'Lỗi không xác định'}`,
      'error'
    );
    return;
  }

  // Hiện flow stepper (4 bước nếu MFA bật)
  const showMfaStep = mfaToggle.checked;
  if (showMfaStep) {
    line3El.style.display = '';
    flowStep4.style.display = '';
  } else {
    line3El.style.display = 'none';
    flowStep4.style.display = 'none';
  }
  setFlowState(1, 'active');
  btnLogin.style.display = 'none';
  btnLogin.disabled = false;
  btnStop.style.display  = 'flex';
  autoFlowEl.style.display = 'flex';
  startFlowPolling();

  // Background đã mở trang login trên tab đích.
  if (tab && isOnChatGPT) {
    showStatus('🔐 Đang tự động đăng nhập...', 'info');
  } else {
    showStatus('🔐 Đang mở trang đăng nhập...', 'info');
  }
});

// Stop
btnStop.addEventListener('click', async () => {
  await chrome.storage.local.set({ autologin_active: false, mfa_phase: 'stopped' });
  await chrome.storage.local.remove([
    'post_login_redirect_pending',
    'post_login_redirect_tab_id',
    'post_login_started_at'
  ]);
  stopFlowPolling();
  resetFlow();
  showStatus('⏹️ Đã dừng automation', 'info');
});


// Prev / Next
btnPrev.addEventListener('click', () => {
  if (currentIdx > 0) {
    currentIdx--;
    chrome.storage.local.set({ currentIdx });
    updateUI();
  }
});

btnNext.addEventListener('click', () => {
  if (currentIdx < accounts.length - 1) {
    currentIdx++;
    chrome.storage.local.set({ currentIdx });
    updateUI();
  }
});

// Auto-save on textarea change (debounced)
let saveTimer;
accountListTA.addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const raw = accountListTA.value.trim();
    const parsed = parseAccounts(raw);
    totalCountEl.textContent = parsed.length;
  }, 300);
});

// ══════════════════════════════════════════════════════════
//   FLOW STEPPER CONTROL
// ══════════════════════════════════════════════════════════

function setFlowState(activeStep, state = 'active') {
  const maxSteps = mfaToggle.checked ? 4 : 3;
  const dots  = [dot1El, dot2El, dot3El, dot4El];
  const lines = [line1El, line2El, line3El];
  const steps = [flowStep1, flowStep2, flowStep3, flowStep4];

  // Reset tất cả
  dots.forEach(d  => { if (d) d.className = 'flow-dot'; });
  lines.forEach(l => { if (l) l.className = 'flow-line'; });
  steps.forEach(s => { if (s) s.className = 'flow-step'; });

  // Đánh dấu các bước đã xong
  for (let i = 1; i < activeStep; i++) {
    if (dots[i-1])  dots[i-1].className  = 'flow-dot done';
    if (steps[i-1]) steps[i-1].className = 'flow-step done';
    if (i <= 3 && lines[i-1]) lines[i-1].className = 'flow-line done';
  }
  // Đánh dấu bước hiện tại
  if (activeStep <= maxSteps) {
    if (dots[activeStep-1])  dots[activeStep-1].className  = `flow-dot ${state}`;
    if (steps[activeStep-1]) steps[activeStep-1].className = `flow-step ${state}`;
  }
}

function resetFlow() {
  autoFlowEl.style.display = 'none';
  btnLogin.style.display = 'flex';
  btnStop.style.display  = 'none';
  [dot1El, dot2El, dot3El, dot4El].forEach(d => { if (d) d.className = 'flow-dot'; });
  [line1El, line2El, line3El].forEach(l => { if (l) l.className = 'flow-line'; });
  [flowStep1, flowStep2, flowStep3, flowStep4].forEach(s => { if (s) s.className = 'flow-step'; });
  line3El.style.display = 'none';
  flowStep4.style.display = 'none';
}

// Theo dõi URL của tab ChatGPT để cập nhật stepper
let flowPollInterval = null;

function startFlowPolling() {
  stopFlowPolling();
  flowPollInterval = setInterval(async () => {
    const data = await chrome.storage.local.get(['autologin_active', 'mfa_phase', 'mfa_progress']);

    // MFA flow đang chạy
    if (data.mfa_phase === 'running' && data.mfa_progress) {
      setFlowState(4, 'active');
      return;
    }

    // MFA xong
    if (data.mfa_phase === 'done') {
      const maxStep = mfaToggle.checked ? 5 : 4;
      setFlowState(maxStep, 'done');
      setTimeout(resetFlow, 2500);
      stopFlowPolling();
      showMfaResult();
      showStatus('✅ Hoàn tất! MFA đã được reset.', 'success');
      return;
    }

    // MFA lỗi
    if (data.mfa_phase === 'error') {
      setTimeout(resetFlow, 2000);
      stopFlowPolling();
      showMfaResult();
      showStatus('❌ MFA flow gặp lỗi', 'error');
      return;
    }

    if (!data.autologin_active) {
      // Đăng nhập xong (không có MFA)
      const maxStep = mfaToggle.checked ? 5 : 4;
      setFlowState(maxStep, 'done');
      setTimeout(resetFlow, 2000);
      stopFlowPolling();
      showStatus('✅ Đăng nhập thành công!', 'success');
      return;
    }

    // Lấy URL tab đang active để phán đoán bước
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const url = tab.url || '';

    if (url.includes('chatgpt.com') && !url.includes('auth') && !url.includes('login')) {
      // Đang ở trang chủ hoặc đã đăng nhập xong
    } else if (url.includes('otp') || url.includes('mfa') || url.includes('verify') || url.includes('authenticator')) {
      setFlowState(3, 'active');
    } else if (url.includes('password')) {
      setFlowState(2, 'active');
    } else if (url.includes('login') || url.includes('auth')) {
      setFlowState(1, 'active');
    }
  }, 1500);
}

function stopFlowPolling() {
  if (flowPollInterval) { clearInterval(flowPollInterval); flowPollInterval = null; }
}

// Restore flow state if already active when popup opens
chrome.storage.local.get(['autologin_active', 'mfa_phase'], (data) => {
  if (data.autologin_active || data.mfa_phase === 'running') {
    autoFlowEl.style.display = 'flex';
    btnLogin.style.display = 'none';
    btnStop.style.display  = 'flex';
    if (mfaToggle.checked) {
      line3El.style.display = '';
      flowStep4.style.display = '';
    }
    setFlowState(data.mfa_phase === 'running' ? 4 : 1, 'active');
    startFlowPolling();
  }
  // Kiểm tra MFA result từ lần trước
  showMfaResult();
});

// ══════════════════════════════════════════════════════════

const totpCard        = document.getElementById('totpCard');
const totpCodeEl      = document.getElementById('totpCode');
const totpSecondsEl   = document.getElementById('totpSeconds');
const totpProgressBar = document.getElementById('totpProgressBar');
const totpRefreshBadge = document.getElementById('totpRefreshBadge');
const btnCopyOtp      = document.getElementById('btnCopyOtp');

let totpInterval  = null;
let totpSecret    = null;
let lastTimeStep  = -1;

async function refreshTotpCode() {
  if (!totpSecret) return;
  try {
    // Tính OTP code bằng hàm từ totp.js
    const code = await generateTOTP(totpSecret);
    const timeStep = Math.floor(Date.now() / 1000 / 30);

    if (timeStep !== lastTimeStep) {
      // Mã mới vừa xuất hiện – animate
      totpCodeEl.classList.add('refreshing');
      await new Promise(r => setTimeout(r, 200));
      // Format: "123 456" (dễ đọc)
      totpCodeEl.textContent = code.slice(0, 3) + ' ' + code.slice(3);
      totpCodeEl.classList.remove('refreshing');
      lastTimeStep = timeStep;
    }

    // Cập nhật countdown
    const secs = totpSecondsRemaining();
    totpSecondsEl.textContent = secs;
    const pct = (secs / 30) * 100;
    totpProgressBar.style.width = pct + '%';

    const urgent = secs <= 7;
    totpRefreshBadge.classList.toggle('urgent', urgent);
    totpProgressBar.classList.toggle('urgent', urgent);
  } catch (e) {
    totpCodeEl.textContent = 'LỖI SECRET';
    console.warn('[TOTP]', e);
  }
}

function startTotpDisplay(twofaValue) {
  stopTotpDisplay();
  if (!twofaValue || !isTotpSecret(twofaValue)) {
    totpCard.style.display = 'none';
    return;
  }
  totpSecret = twofaValue.trim();
  totpCard.style.display = 'block';
  lastTimeStep = -1;
  refreshTotpCode();
  totpInterval = setInterval(refreshTotpCode, 1000);
}

function stopTotpDisplay() {
  if (totpInterval) { clearInterval(totpInterval); totpInterval = null; }
  totpSecret = null;
  totpCard.style.display = 'none';
}

// Copy OTP code
btnCopyOtp.addEventListener('click', async () => {
  const code = totpCodeEl.textContent.replace(/\s/g, '');
  if (!code || code === '––––––' || code === 'LỖISECRET') return;
  try {
    await navigator.clipboard.writeText(code);
    btnCopyOtp.classList.add('copied');
    btnCopyOtp.innerHTML = `
      <svg width="13" height="13" fill="currentColor" viewBox="0 0 16 16">
        <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/>
      </svg>
      Copied!
    `;
    setTimeout(() => {
      btnCopyOtp.classList.remove('copied');
      btnCopyOtp.innerHTML = `
        <svg width="13" height="13" fill="currentColor" viewBox="0 0 16 16">
          <path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/>
          <path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/>
        </svg>
        Copy
      `;
    }, 2000);
  } catch (e) {
    showStatus('❌ Không thể copy', 'error');
  }
});

// ══════════════════════════════════════════════════════════
//   MFA RESULT DISPLAY
// ══════════════════════════════════════════════════════════

async function showMfaResult() {
  const data = await chrome.storage.local.get(['mfa_result', 'mfa_new_secret']);
  const result = data.mfa_result;
  if (!result) return;

  mfaResultCard.style.display = 'block';

  if (result.success && result.secret) {
    mfaSecretEl.textContent = result.secret;
    mfaResultStatus.textContent = '✅ Secret đã được cập nhật vào tài khoản và copy vào clipboard';
    mfaResultStatus.className = 'mfa-result-status success';

    // Reload account list để hiển thị secret mới
    const raw = (await chrome.storage.local.get(['accountsRaw'])).accountsRaw;
    if (raw) {
      accountListTA.value = raw;
      accounts = parseAccounts(raw);
      updateUI();
    }
  } else {
    mfaSecretEl.textContent = '—';
    mfaResultStatus.textContent = '❌ ' + (result.error || 'MFA flow thất bại');
    mfaResultStatus.className = 'mfa-result-status error';
  }
}

// Copy Secret button
btnCopySecret.addEventListener('click', async () => {
  const secret = mfaSecretEl.textContent.trim();
  if (!secret || secret === '—') return;
  try {
    await navigator.clipboard.writeText(secret);
    btnCopySecret.classList.add('copied');
    btnCopySecret.innerHTML = `
      <svg width="13" height="13" fill="currentColor" viewBox="0 0 16 16">
        <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/>
      </svg>
      Copied!
    `;
    setTimeout(() => {
      btnCopySecret.classList.remove('copied');
      btnCopySecret.innerHTML = `
        <svg width="13" height="13" fill="currentColor" viewBox="0 0 16 16">
          <path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/>
          <path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/>
        </svg>
        Copy
      `;
    }, 2000);
  } catch (e) {
    showStatus('❌ Không thể copy', 'error');
  }
});

// Clear MFA result khi bấm Login mới
function clearMfaResult() {
  mfaResultCard.style.display = 'none';
  chrome.storage.local.remove(['mfa_result', 'mfa_new_secret', 'mfa_phase', 'mfa_progress']);
}
