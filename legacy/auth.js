"use strict";
const SUPABASE_URL = "https://gwmuazostbbgroplnlql.supabase.co";
const SUPABASE_ANON = "sb_publishable_cNZ37Mjd57b_9nlyCvtkkA_wSIszOMR";
const ADMIN_EMAIL = "cedric.lago@gmail.com";
const _configured = !SUPABASE_URL.includes("VOTRE_PROJET") && !SUPABASE_ANON.includes("VOTRE_ANON");
let _supa = null;
try {
  if (!window.supabase) throw new Error("Supabase CDN non chargé");
  _supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "pipsily_auth" }
  });
} catch (e) {
  console.warn("[PIPSILY] Supabase non disponible :", e.message);
}
function getDeviceId() {
  let id = localStorage.getItem("pipsily_device_id");
  if (!id) {
    id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : "dev-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    localStorage.setItem("pipsily_device_id", id);
  }
  return id;
}
function getDeviceName() {
  const ua = navigator.userAgent;
  if (/Android.*TV|SmartTV|Tizen|WebOS/i.test(ua)) return "Smart TV";
  if (/Android/i.test(ua)) return "Android";
  if (/iPad|iPhone|iPod/i.test(ua)) return "iOS";
  if (/Windows/i.test(ua)) return "PC Windows";
  if (/Mac/i.test(ua)) return "Mac";
  return "Appareil inconnu";
}
const _DEV_SESSION_KEY = "pipsily_dev_session";
async function getSession() {
  if (!_supa || !_configured) {
    return null;
  }
  try {
    const { data: { session } } = await _supa.auth.getSession();
    return session;
  } catch (e) {
    return null;
  }
}
async function signIn(email, password) {
  if (!_configured || !_supa) {
    return { error: { message: "⚙️ Service d'authentification indisponible. Vérifiez votre connexion et réessayez." } };
  }
  return _supa.auth.signInWithPassword({ email, password });
}
async function signUp(email, password) {
  if (!_configured || !_supa) {
    return { error: { message: "⚙️ Configuration en cours. Lancez SETUP.bat pour activer les inscriptions." } };
  }
  const redirectTo = new URL("login.html", location.href).href;
  return _supa.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } });
}
async function signOut() {
  localStorage.removeItem(_DEV_SESSION_KEY);
  localStorage.removeItem("pipsily_session_token");
  if (!_supa || !_configured) {
    window.location.href = "./login.html";
    return;
  }
  const session = await getSession();
  if (session) {
    try {
      await _supa.from("sessions").delete().eq("user_id", session.user.id);
    } catch (e) {
    }
  }
  return _supa.auth.signOut();
}
async function getProfile(userId) {
  if (!_supa) return null;
  try {
    const { data, error } = await _supa.from("profiles").select("*").eq("id", userId).single();
    return error ? null : data;
  } catch (e) {
    return null;
  }
}
async function checkSubscription(userId) {
  var _a, _b;
  if (!_configured || !_supa) {
    const sess = await getSession();
    if (((_b = (_a = sess == null ? void 0 : sess.user) == null ? void 0 : _a.email) == null ? void 0 : _b.toLowerCase()) === ADMIN_EMAIL.toLowerCase())
      return {
        ok: true,
        unlimited: true,
        plan: "admin",
        devices_allowed: 99,
        email: sess.user.email,
        id: sess.user.id
      };
    return { ok: false, plan: "pending" };
  }
  const prof = await getProfile(userId);
  if (!prof) return { ok: false, plan: null };
  if (prof.plan === "admin" || prof.plan === "unlimited")
    return { ok: true, unlimited: true, ...prof };
  const expires = prof.subscription_expires_at ? new Date(prof.subscription_expires_at) : null;
  const ok = !!(expires && expires > /* @__PURE__ */ new Date());
  return { ok, unlimited: false, ...prof };
}
const SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1e3;
const ACTIVE_WINDOW_MS = 10 * 60 * 1e3;
const MAX_CONCURRENT = { admin: Infinity, unlimited: 4, default: 1 };
const MAX_DEVICES = { admin: Infinity, unlimited: 3, default: 1 };
async function registerSession(userId) {
  var _a;
  const token = ((_a = crypto.randomUUID) == null ? void 0 : _a.call(crypto)) || "tok" + Date.now();
  const deviceId = getDeviceId();
  localStorage.setItem("pipsily_session_token", token);
  if (!_supa) return { token, blocked: false };
  try {
    const cutoff = new Date(Date.now() - SESSION_TIMEOUT_MS).toISOString();
    await _supa.from("sessions").delete().eq("user_id", userId).lt("last_seen", cutoff);
    const { data: prof } = await _supa.from("profiles").select("plan").eq("id", userId).maybeSingle();
    const plan = (prof == null ? void 0 : prof.plan) || "active";
    const maxConcurrent = plan === "admin" ? Infinity : plan === "unlimited" ? MAX_CONCURRENT.unlimited : MAX_CONCURRENT.default;
    if (isFinite(maxConcurrent)) {
      const activeCutoff = new Date(Date.now() - ACTIVE_WINDOW_MS).toISOString();
      const { count: activeCount } = await _supa.from("sessions").select("id", { count: "exact", head: true }).eq("user_id", userId).neq("device_id", deviceId).gt("last_seen", activeCutoff);
      if ((activeCount != null ? activeCount : 0) >= maxConcurrent) {
        return { token: null, blocked: true, reason: "concurrent", maxConcurrent };
      }
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const { data: existing } = await _supa.from("sessions").select("id").eq("user_id", userId).eq("device_id", deviceId).maybeSingle();
    if (existing) {
      await _supa.from("sessions").update({ token, last_seen: now }).eq("id", existing.id);
    } else {
      await _supa.from("sessions").insert({
        user_id: userId,
        device_id: deviceId,
        device_name: getDeviceName(),
        token,
        last_seen: now,
        created_at: now
      });
    }
  } catch (e) {
    console.warn("[PIPSILY] registerSession:", e.message);
  }
  return { token, blocked: false };
}
async function validateSession(userId) {
  if (!_supa) return true;
  const localToken = localStorage.getItem("pipsily_session_token");
  if (!localToken) return false;
  try {
    const { data } = await _supa.from("sessions").select("id").eq("user_id", userId).eq("token", localToken).maybeSingle();
    return !!data;
  } catch (e) {
    return true;
  }
}
let _watchInterval = null;
async function _heartbeat(userId) {
  if (!_supa) return;
  const localToken = localStorage.getItem("pipsily_session_token");
  if (!localToken) return;
  try {
    const { data } = await _supa.from("sessions").select("id").eq("user_id", userId).eq("token", localToken).maybeSingle();
    if (data) {
      await _supa.from("sessions").update({ last_seen: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", data.id);
    }
    const cutoff = new Date(Date.now() - SESSION_TIMEOUT_MS).toISOString();
    await _supa.from("sessions").delete().eq("user_id", userId).lt("last_seen", cutoff);
  } catch (e) {
  }
}
async function startSessionWatcher(userId) {
  if (!_supa || !userId) return;
  _watchInterval = setInterval(() => _heartbeat(userId), 5 * 6e4);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") _heartbeat(userId);
  });
}
async function ensureDevice(userId) {
  if (!_supa) return { newDevice: false, blocked: false };
  try {
    const deviceId = getDeviceId();
    const deviceName = getDeviceName();
    const { data: existing } = await _supa.from("devices").select("id").eq("user_id", userId).eq("device_id", deviceId).maybeSingle();
    if (existing) {
      await _supa.from("devices").update({ last_seen: (/* @__PURE__ */ new Date()).toISOString() }).eq("user_id", userId).eq("device_id", deviceId);
      return { newDevice: false, blocked: false };
    }
    const { data: prof } = await _supa.from("profiles").select("plan").eq("id", userId).maybeSingle();
    const plan = (prof == null ? void 0 : prof.plan) || "active";
    const maxDevices = plan === "admin" ? Infinity : plan === "unlimited" ? MAX_DEVICES.unlimited : MAX_DEVICES.default;
    if (isFinite(maxDevices)) {
      const { count } = await _supa.from("devices").select("id", { count: "exact", head: true }).eq("user_id", userId);
      if ((count != null ? count : 0) >= maxDevices) {
        return { newDevice: true, blocked: true, plan, current: count, maxDevices };
      }
    }
    await _supa.from("devices").insert({ user_id: userId, device_id: deviceId, device_name: deviceName, monthly_fee: 0 });
    return { newDevice: false, blocked: false };
  } catch (e) {
    console.warn("[PIPSILY] ensureDevice:", e.message);
    return { newDevice: false, blocked: false };
  }
}
async function addExtraDevice(userId) {
  var _a;
  if (!_supa) return;
  const deviceId = getDeviceId();
  const deviceName = getDeviceName();
  try {
    const { data: prof } = await _supa.from("profiles").select("devices_allowed").eq("id", userId).single();
    const newAllowed = ((_a = prof == null ? void 0 : prof.devices_allowed) != null ? _a : 1) + 1;
    await _supa.from("profiles").update({ devices_allowed: newAllowed }).eq("id", userId);
    await _supa.from("devices").insert({
      user_id: userId,
      device_id: deviceId,
      device_name: deviceName,
      monthly_fee: 0
    });
  } catch (e) {
    console.warn("[PIPSILY] addExtraDevice:", e.message);
  }
}
async function getParentalPin(userId) {
  if (!_supa) return null;
  try {
    const { data } = await _supa.from("profiles").select("parental_pin").eq("id", userId).single();
    return (data == null ? void 0 : data.parental_pin) || null;
  } catch (e) {
    return null;
  }
}
async function setParentalPin(userId, pin) {
  if (!_supa) return { error: { message: "Non configuré" } };
  return _supa.from("profiles").update({ parental_pin: pin }).eq("id", userId);
}
function promptParentalPin(storedPin) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.id = "parentalOverlay";
    overlay.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(5,8,15,.95);z-index:9999;
        display:flex;align-items:center;justify-content:center;padding:20px">
        <div style="background:#0c1422;border:1px solid rgba(255,255,255,.1);border-radius:20px;
          padding:32px;max-width:320px;width:100%;text-align:center">
          <div style="font-size:40px;margin-bottom:12px">🔞</div>
          <h3 style="margin:0 0 8px;color:#eef4ff;font-size:18px">Contenu pour adultes</h3>
          <p style="color:#7a9cc0;font-size:13px;margin:0 0 20px;line-height:1.5">
            Entrez votre code parental pour accéder à ce contenu.
          </p>
          <input id="pinInput" type="password" maxlength="6" inputmode="numeric"
            placeholder="Code PIN"
            style="width:100%;padding:12px 16px;border-radius:12px;
            border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.08);
            color:#fff;font-size:18px;text-align:center;letter-spacing:6px;margin-bottom:12px" />
          <div id="pinError" style="color:#a084f0;font-size:12px;margin-bottom:12px;display:none">
            Code incorrect — 3 tentatives max
          </div>
          <button id="pinOkBtn" style="width:100%;padding:13px;border-radius:12px;border:none;
            background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff;
            font-weight:700;font-size:15px;cursor:pointer;margin-bottom:8px">
            Confirmer
          </button>
          <button id="pinCancelBtn" style="width:100%;padding:11px;border-radius:12px;
            border:1px solid rgba(255,255,255,.15);background:transparent;
            color:#7a9cc0;font-size:13px;cursor:pointer">
            Annuler
          </button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    let attempts = 0;
    const inp = overlay.querySelector("#pinInput");
    const errEl = overlay.querySelector("#pinError");
    inp.focus();
    const validate = () => {
      if (inp.value === storedPin) {
        overlay.remove();
        resolve(true);
      } else {
        attempts++;
        errEl.style.display = "block";
        errEl.textContent = `Code incorrect (${attempts}/3)`;
        inp.value = "";
        if (attempts >= 3) {
          overlay.remove();
          resolve(false);
        }
      }
    };
    overlay.querySelector("#pinOkBtn").onclick = validate;
    overlay.querySelector("#pinCancelBtn").onclick = () => {
      overlay.remove();
      resolve(false);
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") validate();
    });
  });
}
function _gotoLogin() {
  try {
    const n = (parseInt(sessionStorage.getItem("pf_auth_bounce") || "0", 10) || 0) + 1;
    sessionStorage.setItem("pf_auth_bounce", String(n));
    if (n > 4) {
      document.body.innerHTML = `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;font-family:sans-serif;color:#fff;background:#04060d;padding:24px"><div><h2>Connexion impossible</h2><p style="color:#9ab;max-width:440px;margin:12px auto;line-height:1.6">La session ne se charge pas correctement sur cette page. Vérifiez votre connexion internet, puis reconnectez-vous.</p><button onclick="try{sessionStorage.removeItem('pf_auth_bounce')}catch(e){};location.href='./login.html'" style="margin-top:16px;padding:12px 28px;border:none;border-radius:999px;background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff;font-weight:700;cursor:pointer">Se reconnecter</button></div></div>`;
      return;
    }
  } catch (e) {
  }
  window.location.href = "./login.html";
}
async function authGate() {
  if (!_configured || !_supa) {
    console.warn("[PIPSILY] Supabase non configuré — redirection login");
    _gotoLogin();
    return null;
  }
  let session = null;
  try {
    session = await getSession();
  } catch (e) {
    console.warn("[PIPSILY] getSession:", e.message);
  }
  if (!session) {
    _gotoLogin();
    return null;
  }
  try {
    sessionStorage.removeItem("pf_auth_bounce");
  } catch (e) {
  }
  let sub = { ok: false, plan: null };
  try {
    sub = await checkSubscription(session.user.id);
  } catch (e) {
    console.warn("[PIPSILY] checkSubscription:", e.message);
    sub = session.user.email === ADMIN_EMAIL ? { ok: true, plan: "admin", unlimited: true } : { ok: true, plan: "active", unlimited: false };
  }
  if (session.user.email === ADMIN_EMAIL || sub.plan === "admin") {
    if (_supa && (!sub.plan || sub.plan === "free")) {
      _supa.from("profiles").upsert({
        id: session.user.id,
        email: session.user.email,
        plan: "admin",
        devices_allowed: 999
      }).catch((e) => console.warn("[PIPSILY] upsert admin profile:", e.message));
    }
    registerSession(session.user.id).catch(() => {
    });
    return { session, sub: { ...sub, ok: true, unlimited: true, plan: "admin" } };
  }
  if (!sub.ok) {
    _showPaywall(sub);
    return null;
  }
  const sesResult = await registerSession(session.user.id).catch(() => ({ token: null, blocked: false }));
  if (sesResult.blocked) {
    _showConcurrentLimit(sesResult.maxConcurrent);
    return null;
  }
  const devResult = await ensureDevice(session.user.id).catch(() => ({ newDevice: false, blocked: false }));
  if (devResult.blocked) {
    _showDeviceLimit(sub.plan);
    return null;
  }
  return { session, sub };
}
function _showPaywall(sub) {
  const expired = !!sub.subscription_expires_at;
  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:radial-gradient(ellipse at 50% 0%,rgba(123,95,232,.15),transparent 60%),#05080f;
      color:#eef4ff;font-family:'Segoe UI',system-ui,sans-serif;padding:20px;box-sizing:border-box">
      <div style="max-width:380px;width:100%;text-align:center">
        <div style="font-size:56px;margin-bottom:16px">${expired ? "⏳" : "🔒"}</div>
        <div style="font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;
          color:#7B5FE8;margin-bottom:10px">PIPSILY</div>
        <h2 style="margin:0 0 12px;font-size:22px;font-weight:800">
          ${expired ? "Abonnement expiré" : "Compte en attente"}
        </h2>
        <p style="color:#7a9cc0;margin:0 0 28px;line-height:1.65;font-size:14px">
          ${expired ? "Votre accès a expiré. Contactez l'administrateur pour le réactiver." : "Votre compte est en attente d'activation. Contactez l'administrateur pour activer votre accès (gratuit)."}
        </p>
        <a href="account.html" style="display:block;padding:14px 24px;border-radius:13px;
          background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff;
          text-decoration:none;font-weight:700;font-size:15px;margin-bottom:10px">
          Mon compte
        </a>
        <button onclick="window.PIPSILY_AUTH.signOut().then(()=>location.href='login.html')"
          style="width:100%;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,.12);
          background:transparent;color:#7a9cc0;font-size:13px;cursor:pointer">
          Se déconnecter
        </button>
      </div>
    </div>`;
}
function _showDeviceLimit(plan) {
  const maxDevices = plan === "unlimited" ? MAX_DEVICES.unlimited : MAX_DEVICES.default;
  const msg = maxDevices === 1 ? "Votre compte autorise un seul appareil enregistré. Déconnectez-vous de l'appareil actuel ou contactez l'administrateur." : `Votre compte autorise ${maxDevices} appareils. Gérez vos appareils depuis la page Mon compte.`;
  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:radial-gradient(ellipse at 50% 0%,rgba(59,124,244,.15),transparent 60%),#05080f;
      color:#eef4ff;font-family:'Segoe UI',system-ui,sans-serif;padding:20px;box-sizing:border-box">
      <div style="max-width:380px;width:100%;text-align:center">
        <div style="font-size:56px;margin-bottom:16px">📱</div>
        <div style="font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;
          color:#7B5FE8;margin-bottom:10px">PIPSILY</div>
        <h2 style="margin:0 0 12px;font-size:22px;font-weight:800">Limite d'appareils atteinte</h2>
        <p style="color:#7a9cc0;margin:0 0 24px;line-height:1.65;font-size:14px">${msg}</p>
        <a href="account.html" style="display:block;padding:14px 24px;border-radius:13px;
          background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff;
          text-decoration:none;font-weight:700;font-size:15px;margin-bottom:10px">
          Gérer mes appareils
        </a>
        <button onclick="window.PIPSILY_AUTH.signOut().then(()=>location.href='login.html')"
          style="width:100%;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,.12);
          background:transparent;color:#7a9cc0;font-size:13px;cursor:pointer">
          Se déconnecter
        </button>
      </div>
    </div>`;
}
function _showConcurrentLimit(maxConcurrent) {
  const nb = isFinite(maxConcurrent) ? maxConcurrent : 1;
  const label = nb === 1 ? "une seule connexion simultanée" : `${nb} connexions simultanées`;
  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:radial-gradient(ellipse at 50% 0%,rgba(232,100,60,.12),transparent 60%),#05080f;
      color:#eef4ff;font-family:'Segoe UI',system-ui,sans-serif;padding:20px;box-sizing:border-box">
      <div style="max-width:380px;width:100%;text-align:center">
        <div style="font-size:56px;margin-bottom:16px">🔒</div>
        <div style="font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;
          color:#7B5FE8;margin-bottom:10px">PIPSILY</div>
        <h2 style="margin:0 0 12px;font-size:22px;font-weight:800">Trop d'appareils connectés</h2>
        <p style="color:#7a9cc0;margin:0 0 24px;line-height:1.65;font-size:14px">
          Votre compte autorise ${label}.<br>
          Déconnectez-vous d'un autre appareil, puis reconnectez-vous ici.
        </p>
        <a href="login.html" style="display:block;padding:14px 24px;border-radius:13px;
          background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff;
          text-decoration:none;font-weight:700;font-size:15px;margin-bottom:10px">
          Se reconnecter
        </a>
        <a href="account.html" style="display:block;padding:12px;border-radius:12px;
          border:1px solid rgba(255,255,255,.12);color:#7a9cc0;
          text-decoration:none;font-size:13px">
          Gérer mes appareils
        </a>
      </div>
    </div>`;
}
function _showSessionExpired() {
  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#05080f;color:#eef4ff;font-family:'Segoe UI',system-ui,sans-serif;padding:20px">
      <div style="max-width:360px;text-align:center">
        <div style="font-size:52px;margin-bottom:16px">📵</div>
        <h2 style="margin:0 0 12px;font-size:22px">Session expirée</h2>
        <p style="color:#7a9cc0;margin:0 0 24px;line-height:1.6;font-size:14px">
          Votre compte a été connecté depuis un autre appareil.<br>
          Une seule connexion simultanée est autorisée par compte.
        </p>
        <a href="login.html" style="display:block;padding:14px;border-radius:12px;
          background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff;
          text-decoration:none;font-weight:700;font-size:15px">
          Se reconnecter
        </a>
      </div>
    </div>`;
}
window.PIPSILY_AUTH = {
  supabase: _supa,
  ADMIN_EMAIL,
  getSession,
  signIn,
  signUp,
  signOut,
  getProfile,
  checkSubscription,
  registerSession,
  validateSession,
  ensureDevice,
  addExtraDevice,
  getParentalPin,
  setParentalPin,
  promptParentalPin,
  authGate,
  getDeviceId,
  getDeviceName,
  startSessionWatcher
};
