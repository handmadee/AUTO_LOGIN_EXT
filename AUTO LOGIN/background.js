/* ========================================================
   background.js – Service Worker / Coordinator
   
   Vai trò: Theo dõi mọi tab navigation trên các domain
   auth của ChatGPT, tự động kích hoạt fill đúng lúc.
   Đây là "bộ não" điều phối toàn bộ automation flow.
   ======================================================== */

const AUTH_DOMAINS = [
  'chatgpt.com',
  'auth.openai.com',
  'auth0.openai.com'
];

const PASSKEY_ENROLL_URL =
  'https://chatgpt.com/auth/enroll_mfa?factor=passkey&redirect_path=%2F%23settings%2FSecurity%2Fpasskeys';
const LOGIN_URL = 'https://chatgpt.com/auth/login';
const passkeyRedirectingTabs = new Set();

function isAuthUrl(url) {
  return AUTH_DOMAINS.some(d => url.includes(d));
}

function isCredentialUrl(url) {
  return url.includes('auth.openai.com') ||
    url.includes('auth0.openai.com') ||
    /^https:\/\/chatgpt\.com\/auth\/(login|signin)(?:[/?#]|$)/.test(url);
}

function parseAccounts(text) {
  return (text || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'))
    .map(l => {
      const parts = l.split('|').map(p => p.trim());
      return { email: parts[0] || '', password: parts[1] || '', twofa: parts[2] || '' };
    })
    .filter(a => a.email.length > 0);
}

async function prepareLogin(message) {
  let loginTabId = null;
  if (Number.isInteger(message.preferredTabId)) {
    try {
      const tab = await chrome.tabs.get(message.preferredTabId);
      if (tab && isAuthUrl(tab.url || '')) {
        loginTabId = tab.id;
      }
    } catch (error) {
      console.warn('[BG] Không thể dùng lại tab ChatGPT:', error);
    }
  }

  if (!Number.isInteger(loginTabId)) {
    const loginTab = await chrome.tabs.create({ url: 'about:blank' });
    loginTabId = loginTab.id;
  }

  await chrome.storage.local.set({ autologin_active: true });

  if (message.enablePostLoginRedirect) {
    await chrome.storage.local.set({
      post_login_redirect_pending: true,
      post_login_redirect_tab_id: loginTabId,
      post_login_started_at: Date.now()
    });
  } else {
    await chrome.storage.local.remove([
      'post_login_redirect_pending',
      'post_login_redirect_tab_id',
      'post_login_started_at'
    ]);
  }

  // Cờ redirect được lưu trước khi mở login, nên nếu session hiện tại đưa tab
  // thẳng về trang chủ thì listener vẫn bắt được và chuyển sang Passkey.
  await chrome.tabs.update(loginTabId, { url: LOGIN_URL });

  return { loginTabId };
}

// Chuẩn bị tab và mở trang đăng nhập. Không xóa cookie/site data.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== 'start_login') return;

  prepareLogin(message)
    .then((result) => {
      console.log('[BG] Đã mở flow đăng nhập trên tab', result.loginTabId);
      sendResponse({ ok: true, ...result });
    })
    .catch((error) => {
      console.error('[BG] Không thể mở flow đăng nhập:', error);
      chrome.storage.local.set({ autologin_active: false });
      chrome.storage.local.remove([
        'post_login_redirect_pending',
        'post_login_redirect_tab_id',
        'post_login_started_at'
      ]);
      sendResponse({
        ok: false,
        error: error?.message || 'Không thể mở trang đăng nhập.'
      });
    });

  return true;
});

// ── Theo dõi khi trang load xong ─────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Chỉ xử lý khi trang đã load xong
  if (changeInfo.status !== 'complete') return;

  const url = tab.url || '';
  // Chỉ autofill trên trang nhập credential. Không chạy trên trang chủ,
  // Settings hoặc /auth/enroll_mfa để tránh kéo tab ngược về login.
  if (!isCredentialUrl(url)) return;

  // Kiểm tra autologin flag
  chrome.storage.local.get(['autologin_active', 'currentIdx', 'accountsRaw'], (data) => {
    if (!data.autologin_active) return;

    const accounts = parseAccounts(data.accountsRaw || '');
    const idx = typeof data.currentIdx === 'number' ? data.currentIdx : 0;
    const acc = accounts[idx];
    if (!acc || !acc.email) return;

    console.log('[BG] Tab updated →', url, '| Sending fill command for:', acc.email);

    // Đợi content script sẵn sàng rồi gửi lệnh
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, {
        action: 'bg_autofill',
        email:    acc.email,
        password: acc.password,
        twofa:    acc.twofa || ''
      }, (response) => {
        if (chrome.runtime.lastError) {
          // Content script chưa inject → thử inject thủ công
          chrome.scripting.executeScript({
            target: { tabId },
            files: ['totp.js', 'content.js']
          }).then(() => {
            setTimeout(() => {
              chrome.tabs.sendMessage(tabId, {
                action: 'bg_autofill',
                email:    acc.email,
                password: acc.password,
                twofa:    acc.twofa || ''
              });
            }, 800);
          }).catch(err => console.warn('[BG] Inject failed:', err));
        }
      });
    }, 1200); // đợi DOM ổn định
  });
});

// ── Phát hiện đăng nhập thành công → tắt flag hoặc chạy MFA ─
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Bắt ngay khi URL chuyển về trang chủ; không cần chờ SPA tải xong.
  if (changeInfo.status !== 'complete' && !changeInfo.url) return;
  const url = changeInfo.url || tab.url || '';

  // Nếu đã về trang ChatGPT chính (sau login thành công)
  // Match: chatgpt.com/ , chatgpt.com/?... , chatgpt.com/#...
  const isMainPage = /^https:\/\/chatgpt\.com\/?(\?|#|$)/.test(url);
  if (!isMainPage) return;
  if (passkeyRedirectingTabs.has(tabId)) return;

  chrome.storage.local.get([
    'autologin_active',
    'mfa_reset_enabled',
    'mfa_phase',
    'currentIdx',
    'accountsRaw',
    'post_login_redirect_pending',
    'post_login_redirect_tab_id',
    'post_login_started_at'
  ], (data) => {
    // Sau khi đúng tab login quay về ChatGPT, mở trang đăng ký passkey đúng một lần.
    // Không phụ thuộc autologin_active vì content script có thể tắt cờ đó ngay sau
    // khi submit OTP, trước khi trang chính load xong.
    if (
      data.post_login_redirect_pending &&
      data.post_login_redirect_tab_id === tabId
    ) {
      console.log('[BG] ✅ Login thành công! Mở trang đăng ký passkey...');
      passkeyRedirectingTabs.add(tabId);
      chrome.tabs.update(tabId, { url: PASSKEY_ENROLL_URL }, () => {
        if (chrome.runtime.lastError) {
          passkeyRedirectingTabs.delete(tabId);
          console.warn('[BG] Chưa thể mở trang Passkey:', chrome.runtime.lastError.message);
          return;
        }

        chrome.storage.local.remove([
          'post_login_redirect_pending',
          'post_login_redirect_tab_id',
          'post_login_started_at'
        ]);
        chrome.storage.local.set({ autologin_active: false });
        passkeyRedirectingTabs.delete(tabId);
      });
      return;
    }

    // Bỏ qua nếu MFA flow đang chạy/navigating
    if (data.mfa_phase === 'running' || data.mfa_phase === 'navigating') return;
    if (!data.autologin_active) return;

    if (data.mfa_reset_enabled) {
      // ── Bắt đầu MFA flow ──
      console.log('[BG] ✅ Login thành công! Chuyển đến Settings/Security...');
      // Set navigating NGAY để chặn các listener khác can thiệp
      chrome.storage.local.set({ mfa_phase: 'navigating', autologin_active: false });

      const accounts = parseAccounts(data.accountsRaw || '');
      const idx = typeof data.currentIdx === 'number' ? data.currentIdx : 0;
      const acc = accounts[idx] || {};

      // Navigate thẳng đến trang Security settings
      setTimeout(() => {
        chrome.tabs.update(tabId, { url: 'https://chatgpt.com/#settings/Security' }, () => {
          // Sau khi trang load, gửi lệnh start MFA
          setTimeout(() => {
            chrome.storage.local.set({ mfa_phase: 'running' });
            chrome.tabs.sendMessage(tabId, {
              action:   'start_mfa_flow',
              email:    acc.email || '',
              password: acc.password || '',
              twofa:    acc.twofa || ''
            }, (response) => {
              if (chrome.runtime.lastError) {
                // Content script chưa inject → inject thủ công
                chrome.scripting.executeScript({
                  target: { tabId },
                  files: ['totp.js', 'content.js', 'mfa_flow.js']
                }).then(() => {
                  setTimeout(() => {
                    chrome.tabs.sendMessage(tabId, {
                      action:   'start_mfa_flow',
                      email:    acc.email || '',
                      password: acc.password || '',
                      twofa:    acc.twofa || ''
                    });
                  }, 1000);
                }).catch(err => console.warn('[BG] MFA inject failed:', err));
              }
            });
          }, 3000); // chờ settings page load
        });
      }, 1500);
    } else {
      console.log('[BG] ✅ Login thành công! Tắt autologin flag.');
      chrome.storage.local.set({ autologin_active: false });
    }
  });
});

console.log('[BG] ChatGPT AutoLogin service worker ready ✅');
