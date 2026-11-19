/* ========================================================
   totp.js – TOTP Generator (FIXED & ROBUST)
   ======================================================== */

function isTotpSecret(str) {
  if (!str) return false;
  // Loại bỏ khoảng trắng, dấu gạch ngang, dấu bằng (padding)
  const cleaned = str.replace(/[\s\-\=]/g, '').toUpperCase();
  
  // Nếu là chuỗi 6-8 số thuần túy -> đây là mã OTP nhập tay
  if (/^\d{6,8}$/.test(cleaned)) return false;
  
  // Nếu dài từ 8 ký tự trở lên (sau khi đã dọn dẹp), mặc định hiểu là Secret Key
  return cleaned.length >= 8;
}

function base32Decode(base32) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  // Lọc CỰC MẠNH: Chỉ giữ lại các ký tự hợp lệ của Base32 để chống crash
  const cleaned  = base32.replace(/[^A-Z2-7]/g, '').toUpperCase();

  let bits = '';
  for (const ch of cleaned) {
    const idx = ALPHABET.indexOf(ch);
    if (idx !== -1) bits += idx.toString(2).padStart(5, '0');
  }

  const byteCount = Math.floor(bits.length / 8);
  const bytes     = new Uint8Array(byteCount);
  for (let i = 0; i < byteCount; i++) {
    bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  return bytes;
}

async function generateTOTP(secret, digits = 6, period = 30) {
  const keyBytes   = base32Decode(secret);
  const timeStep   = Math.floor(Date.now() / 1000 / period);

  const counter    = new ArrayBuffer(8);
  const view       = new DataView(counter);
  view.setUint32(0, Math.floor(timeStep / 0x100000000), false);
  view.setUint32(4, timeStep >>> 0, false);

  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: { name: 'SHA-1' } }, false, ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, counter);
  const hash      = new Uint8Array(signature);

  const offset = hash[hash.length - 1] & 0x0f;
  const code   = (
    ((hash[offset]     & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) <<  8) |
     (hash[offset + 3] & 0xff)
  ) % Math.pow(10, digits);

  return code.toString().padStart(digits, '0');
}

function totpSecondsRemaining(period = 30) {
  return period - (Math.floor(Date.now() / 1000) % period);
}

async function resolveTwoFa(twofa) {
  if (!twofa || twofa.trim() === '') return '';
  
  // Dọn dẹp sơ bộ
  const cleaned = twofa.replace(/[\s\-\=]/g, '').toUpperCase();
  
  // 1. Trường hợp người dùng nhập sẵn 6 số OTP (không dùng Secret Key)
  if (/^\d{6,8}$/.test(cleaned)) {
    return cleaned;
  }
  
  // 2. Trường hợp là Secret Key -> Tiến hành sinh mã
  if (cleaned.length >= 8) {
    try {
        return await generateTOTP(cleaned);
    } catch(e) {
        console.error("[TOTP] Lỗi tạo OTP:", e);
        // Trả về chuỗi rỗng để tránh vứt nguyên Secret Key vào ô input như cũ
        return ""; 
    }
  }
  
  return twofa.trim();
}