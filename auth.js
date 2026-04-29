// ╔══════════════════════════════════════════════════════════════╗
// ║  PIPSILY — auth.js v1.0 — Supabase Auth + Abonnements       ║
// ║  NE PAS COMMITTER les clés Supabase dans un repo public      ║
// ╚══════════════════════════════════════════════════════════════╝
"use strict";

// ─────────────────────────────────────────────────────────────────
//  CONFIG SUPABASE — à remplir après création du projet
//  https://supabase.com → New project → Settings → API
// ─────────────────────────────────────────────────────────────────
const SUPABASE_URL  = "https://gwmuazostbbgroplnlql.supabase.co";
const SUPABASE_ANON = "sb_publishable_cNZ37Mjd57b_9nlyCvtkkA_wSIszOMR";

// E-mail du compte admin (accès illimité, panel admin visible)
const ADMIN_EMAIL   = "cedric.lago@gmail.com";

// ─────────────────────────────────────────────────────────────────
//  DÉTECTION CONFIG
// ─────────────────────────────────────────────────────────────────
const _configured = !SUPABASE_URL.includes("VOTRE_PROJET") && !SUPABASE_ANON.includes("VOTRE_ANON");

// ─────────────────────────────────────────────────────────────────
//  CLIENT SUPABASE (protégé contre CDN manquant ou config vide)
// ─────────────────────────────────────────────────────────────────
let _supa = null;
try {
  if(!window.supabase) throw new Error("Supabase CDN non chargé");
  _supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "pipsily_auth" }
  });
} catch(e) {
  console.warn("[PIPSILY] Supabase non disponible :", e.message);
}

// ─────────────────────────────────────────────────────────────────
//  DEVICE FINGERPRINT
// ─────────────────────────────────────────────────────────────────
function getDeviceId(){
  let id = localStorage.getItem("pipsily_device_id");
  if(!id){
    id = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : "dev-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    localStorage.setItem("pipsily_device_id", id);
  }
  return id;
}

function getDeviceName(){
  const ua = navigator.userAgent;
  if(/Android.*TV|SmartTV|Tizen|WebOS/i.test(ua)) return "Smart TV";
  if(/Android/i.test(ua)) return "Android";
  if(/iPad|iPhone|iPod/i.test(ua)) return "iOS";
  if(/Windows/i.test(ua)) return "PC Windows";
  if(/Mac/i.test(ua)) return "Mac";
  return "Appareil inconnu";
}

// ─────────────────────────────────────────────────────────────────
//  AUTHENTIFICATION
// ─────────────────────────────────────────────────────────────────
// ── Session locale pour mode dev (Supabase non configuré) ──
const _DEV_SESSION_KEY = "pipsily_dev_session";

function _mkDevSession(email){
  return {
    user: { id: "dev-" + btoa(email).replace(/=/g,""), email },
    access_token: "dev-token"
  };
}

async function getSession(){
  // Mode dev : lire la session locale si pas de Supabase
  if(!_supa || !_configured){
    const raw = localStorage.getItem(_DEV_SESSION_KEY);
    if(raw){ try { return JSON.parse(raw); } catch{} }
    return null;
  }
  try {
    const { data: { session } } = await _supa.auth.getSession();
    return session;
  } catch { return null; }
}

async function signIn(email, password){
  // Mode dev : accès admin sans Supabase
  if(!_configured || !_supa){
    if(email.toLowerCase() === ADMIN_EMAIL.toLowerCase() && password === "!Morpheus45!"){
      const session = _mkDevSession(email);
      localStorage.setItem(_DEV_SESSION_KEY, JSON.stringify(session));
      return { data: { session }, error: null };
    }
    return { error: { message: "⚙️ Supabase non configuré. Lancez SETUP.bat pour activer les comptes." } };
  }
  return _supa.auth.signInWithPassword({ email, password });
}

async function signUp(email, password){
  if(!_configured || !_supa){
    return { error: { message: "⚙️ Configuration en cours. Lancez SETUP.bat pour activer les inscriptions." } };
  }
  const redirectTo = "https://morpheus45.github.io/VOD/login.html";
  return _supa.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } });
}

async function signOut(){
  localStorage.removeItem(_DEV_SESSION_KEY);
  localStorage.removeItem("pipsily_session_token");
  if(!_supa || !_configured){ window.location.href = "./login.html"; return; }
  const session = await getSession();
  if(session){
    try { await _supa.from("sessions").delete().eq("user_id", session.user.id); } catch {}
  }
  return _supa.auth.signOut();
}

// ─────────────────────────────────────────────────────────────────
//  PROFIL & ABONNEMENT
// ─────────────────────────────────────────────────────────────────
async function getProfile(userId){
  if(!_supa) return null;
  try {
    const { data, error } = await _supa.from("profiles").select("*").eq("id", userId).single();
    return error ? null : data;
  } catch { return null; }
}

async function checkSubscription(userId){
  // Mode dev : admin illimité
  if(!_configured || !_supa){
    const sess = await getSession();
    if(sess?.user?.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase())
      return { ok: true, unlimited: true, plan: "admin", devices_allowed: 99,
               email: sess.user.email, id: sess.user.id };
    return { ok: false, plan: "pending" };
  }
  const prof = await getProfile(userId);
  if(!prof) return { ok: false, plan: null };
  if(prof.plan === "admin" || prof.plan === "unlimited")
    return { ok: true, unlimited: true, ...prof };
  const expires = prof.subscription_expires_at ? new Date(prof.subscription_expires_at) : null;
  const ok = !!(expires && expires > new Date());
  return { ok, unlimited: false, ...prof };
}

// ─────────────────────────────────────────────────────────────────
//  SESSION UNIQUE (1 connexion simultanée max)
// ─────────────────────────────────────────────────────────────────
//  GÉOLOCALISATION IP SILENCIEUSE (aucune permission requise)
// ─────────────────────────────────────────────────────────────────
async function getGeoInfo(){
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 5000);
    const r    = await fetch("https://ipapi.co/json/", { signal: ctrl.signal });
    clearTimeout(tid);
    if(!r.ok) return {};
    const d = await r.json();
    return {
      ip      : d.ip            || "",
      country : d.country_name  || d.country_code || "",
      city    : d.city          || "",
      region  : d.region        || "",
      isp     : d.org           || ""
    };
  } catch { return {}; }
}

// ─────────────────────────────────────────────────────────────────
//  SESSIONS MULTIPLES — plusieurs appareils simultanés autorisés
//  Purge automatique des sessions inactives (> 5 min sans heartbeat)
// ─────────────────────────────────────────────────────────────────

const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes d'inactivité = session expirée

async function registerSession(userId){
  const token = crypto.randomUUID?.() || ("tok" + Date.now());
  localStorage.setItem("pipsily_session_token", token);
  if(!_supa) return token;
  try {
    // Purger les sessions inactives (last_seen > 5 min) de cet utilisateur
    const cutoff = new Date(Date.now() - SESSION_TIMEOUT_MS).toISOString();
    await _supa.from("sessions").delete()
      .eq("user_id", userId).lt("last_seen", cutoff);

    // Géolocalisation silencieuse (parallèle)
    const geo = await getGeoInfo();

    await _supa.from("sessions").insert({
      user_id     : userId,
      device_id   : getDeviceId(),
      device_name : getDeviceName(),
      token,
      ip          : geo.ip      || null,
      country     : geo.country || null,
      city        : geo.city    || null,
      region      : geo.region  || null,
      isp         : geo.isp     || null,
      last_seen   : new Date().toISOString(),
      created_at  : new Date().toISOString()
    });
  } catch(e){ console.warn("[PIPSILY] registerSession:", e.message); }
  return token;
}

async function validateSession(userId){
  if(!_supa) return true;
  const localToken = localStorage.getItem("pipsily_session_token");
  if(!localToken) return false;
  try {
    const { data } = await _supa.from("sessions").select("id")
      .eq("user_id", userId).eq("token", localToken).maybeSingle();
    return !!data;
  } catch { return true; }
}

// ─────────────────────────────────────────────────────────────────
//  SURVEILLANCE SESSION — heartbeat 30s (mise à jour last_seen)
//  Purge silencieuse des sessions inactives — pas de déconnexion forcée
// ─────────────────────────────────────────────────────────────────
let _watchInterval = null;

async function _heartbeat(userId){
  if(!_supa) return;
  const localToken = localStorage.getItem("pipsily_session_token");
  if(!localToken) return; // token absent : ne rien faire, pas de déconnexion forcée
  try {
    // Mettre à jour last_seen de cette session
    const { data } = await _supa.from("sessions").select("id")
      .eq("user_id", userId).eq("token", localToken).maybeSingle();
    if(data){
      await _supa.from("sessions").update({ last_seen: new Date().toISOString() }).eq("id", data.id);
    }

    // Purge silencieuse des sessions inactives (autres appareils déconnectés)
    const cutoff = new Date(Date.now() - SESSION_TIMEOUT_MS).toISOString();
    await _supa.from("sessions").delete()
      .eq("user_id", userId).lt("last_seen", cutoff);
  } catch { /* erreur réseau : ne pas déconnecter */ }
}

async function startSessionWatcher(userId){
  if(!_supa || !userId) return;

  // Heartbeat toutes les 30 secondes — mise à jour last_seen + purge des inactifs
  _watchInterval = setInterval(() => _heartbeat(userId), 30_000);
}

// ─────────────────────────────────────────────────────────────────
//  GESTION DES APPAREILS
// ─────────────────────────────────────────────────────────────────
async function ensureDevice(userId){
  if(!_supa) return { newDevice: false, blocked: false };
  const deviceId   = getDeviceId();
  const deviceName = getDeviceName();

  const { data: existing } = await _supa
    .from("devices")
    .select("id")
    .eq("user_id", userId)
    .eq("device_id", deviceId)
    .single();

  if(existing){
    // Mise à jour last_seen
    await _supa.from("devices")
      .update({ last_seen: new Date().toISOString() })
      .eq("user_id", userId).eq("device_id", deviceId);
    return { newDevice: false, blocked: false };
  }

  // Nouvel appareil — vérifier la limite
  const { data: prof } = await _supa
    .from("profiles").select("devices_allowed, plan").eq("id", userId).single();

  if(prof?.plan === "admin" || prof?.plan === "unlimited"){
    // Pas de limite pour admin/illimité
    await _supa.from("devices").insert({ user_id: userId, device_id: deviceId, device_name: deviceName, monthly_fee: 0 });
    return { newDevice: false, blocked: false };
  }

  const { count } = await _supa
    .from("devices").select("*", { count: "exact" }).eq("user_id", userId);
  const allowed = prof?.devices_allowed ?? 1;

  if(count >= allowed){
    return { newDevice: true, blocked: true, extra_cost: 1.50, current: count, allowed };
  }

  await _supa.from("devices").insert({ user_id: userId, device_id: deviceId, device_name: deviceName, monthly_fee: 0 });
  return { newDevice: false, blocked: false };
}

async function addExtraDevice(userId){
  const deviceId   = getDeviceId();
  const deviceName = getDeviceName();
  const extra_cost = 1.50;

  const { data: prof } = await _supa
    .from("profiles").select("devices_allowed").eq("id", userId).single();
  const newAllowed = (prof?.devices_allowed ?? 1) + 1;

  await _supa.from("profiles").update({ devices_allowed: newAllowed }).eq("id", userId);
  await _supa.from("devices").insert({
    user_id: userId, device_id: deviceId, device_name: deviceName, monthly_fee: extra_cost
  });
  // Note dans les paiements (pour suivi admin)
  await _supa.from("payments").insert({
    user_id: userId, amount: extra_cost, type: "extra_device",
    notes: `Appareil supplémentaire : ${deviceName}`
  });
}

// ─────────────────────────────────────────────────────────────────
//  CODE PARENTAL
// ─────────────────────────────────────────────────────────────────
async function getParentalPin(userId){
  if(!_supa) return null;
  try {
    const { data } = await _supa.from("profiles").select("parental_pin").eq("id", userId).single();
    return data?.parental_pin || null;
  } catch { return null; }
}

async function setParentalPin(userId, pin){
  if(!_supa) return { error: { message: "Non configuré" } };
  return _supa.from("profiles").update({ parental_pin: pin }).eq("id", userId);
}

// Prompt PIN parental — retourne true si validé
function promptParentalPin(storedPin){
  return new Promise(resolve => {
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
      if(inp.value === storedPin){
        overlay.remove(); resolve(true);
      } else {
        attempts++;
        errEl.style.display = "block";
        errEl.textContent = `Code incorrect (${attempts}/3)`;
        inp.value = "";
        if(attempts >= 3){ overlay.remove(); resolve(false); }
      }
    };

    overlay.querySelector("#pinOkBtn").onclick = validate;
    overlay.querySelector("#pinCancelBtn").onclick = () => { overlay.remove(); resolve(false); };
    inp.addEventListener("keydown", e => { if(e.key === "Enter") validate(); });
  });
}

// ─────────────────────────────────────────────────────────────────
//  AUTH GATE — appelé au démarrage de l'app (index.html)
// ─────────────────────────────────────────────────────────────────
async function authGate(){
  // Supabase pas encore configuré → mode développement, tout passe
  if(!_configured || !_supa){
    console.warn("[PIPSILY] Supabase non configuré — auth désactivée (mode dev)");
    return { session: { user: { id: "dev", email: ADMIN_EMAIL } }, sub: { ok: true, plan: "admin", unlimited: true } };
  }

  const session = await getSession();
  if(!session){
    window.location.href = "./login.html";
    return null;
  }

  const sub = await checkSubscription(session.user.id);

  // Admin (cedric.lago@gmail.com) → accès illimité sans vérification
  if(session.user.email === ADMIN_EMAIL || sub.plan === "admin" || sub.plan === "unlimited"){
    // S'assurer que le profil admin existe
    if(_supa && (!sub.plan || sub.plan === "free")){
      await _supa.from("profiles")
        .upsert({ id: session.user.id, email: session.user.email, plan: "admin", devices_allowed: 999 });
    }
    await registerSession(session.user.id).catch(() => {});
    return { session, sub: { ...sub, ok: true, unlimited: true, plan: "admin" } };
  }

  // Abonnement inactif → paywall
  if(!sub.ok){
    _showPaywall(sub);
    return null;
  }

  // Vérification session unique
  const sessOk = await validateSession(session.user.id);
  if(!sessOk){
    // Regénérer la session (peut avoir expiré ou nouvel appareil)
    await registerSession(session.user.id);
  }

  // Vérification device
  const devResult = await ensureDevice(session.user.id);
  if(devResult.blocked){
    _showDeviceLimit(session.user.id, devResult.extra_cost);
    return null;
  }

  return { session, sub };
}

// ─────────────────────────────────────────────────────────────────
//  ÉCRANS BLOQUANTS (inline — pas de fichier séparé)
// ─────────────────────────────────────────────────────────────────
function _showPaywall(sub){
  const expired = !!(sub.subscription_expires_at);
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
          ${expired
            ? "Votre abonnement a expiré. Renouvelez-le pour continuer à profiter de PIPSILY."
            : "Votre compte est en attente d'activation. Contactez l'administrateur pour activer votre accès."}
        </p>
        <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);
          border-radius:16px;padding:20px;margin-bottom:20px">
          <div style="font-size:32px;font-weight:900;color:#38A8E8;margin-bottom:4px">4,99 €</div>
          <div style="font-size:13px;color:#7a9cc0">/mois · accès illimité</div>
          <div style="margin-top:12px;font-size:12px;color:#7a9cc0">
            Appareils supplémentaires : <strong style="color:#eef4ff">+1,50 €/mois chacun</strong>
          </div>
        </div>
        <a href="account.html" style="display:block;padding:14px 24px;border-radius:13px;
          background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff;
          text-decoration:none;font-weight:700;font-size:15px;margin-bottom:10px">
          Mon compte &amp; renouvellement
        </a>
        <button onclick="window.PIPSILY_AUTH.signOut().then(()=>location.href='login.html')"
          style="width:100%;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,.12);
          background:transparent;color:#7a9cc0;font-size:13px;cursor:pointer">
          Se déconnecter
        </button>
      </div>
    </div>`;
}

function _showDeviceLimit(userId, extra_cost){
  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:radial-gradient(ellipse at 50% 0%,rgba(59,124,244,.15),transparent 60%),#05080f;
      color:#eef4ff;font-family:'Segoe UI',system-ui,sans-serif;padding:20px;box-sizing:border-box">
      <div style="max-width:380px;width:100%;text-align:center">
        <div style="font-size:56px;margin-bottom:16px">📱</div>
        <div style="font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;
          color:#7B5FE8;margin-bottom:10px">PIPSILY</div>
        <h2 style="margin:0 0 12px;font-size:22px;font-weight:800">Nouvel appareil détecté</h2>
        <p style="color:#7a9cc0;margin:0 0 16px;line-height:1.65;font-size:14px">
          Vous avez atteint la limite d'appareils inclus dans votre abonnement.
        </p>
        <div style="background:rgba(56,168,232,.08);border:1px solid rgba(56,168,232,.25);
          border-radius:14px;padding:16px;margin-bottom:20px">
          <div style="font-size:22px;font-weight:900;color:#38A8E8">
            +${extra_cost.toFixed(2).replace(".", ",")} €/mois
          </div>
          <div style="font-size:13px;color:#7a9cc0;margin-top:4px">par appareil supplémentaire</div>
          <div style="margin-top:12px;font-size:12px;color:#7a9cc0;line-height:1.5">
            Ce montant s'ajoute à votre abonnement de base et sera prélevé chaque mois.
            En confirmant, vous acceptez ce supplément.
          </div>
        </div>
        <button id="addDevBtn" style="display:block;width:100%;padding:14px;border-radius:13px;
          background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff;border:none;
          font-weight:700;font-size:15px;cursor:pointer;margin-bottom:10px">
          ✓ Ajouter cet appareil (+${extra_cost.toFixed(2).replace(".", ",")} €/mois)
        </button>
        <button onclick="location.href='account.html'" style="width:100%;padding:12px;
          border-radius:12px;border:1px solid rgba(255,255,255,.12);background:transparent;
          color:#7a9cc0;font-size:13px;cursor:pointer">
          Gérer mes appareils
        </button>
      </div>
    </div>`;
  document.getElementById("addDevBtn")?.addEventListener("click", async () => {
    const btn = document.getElementById("addDevBtn");
    btn.disabled = true; btn.textContent = "Ajout en cours…";
    await addExtraDevice(userId);
    location.reload();
  });
}

function _showSessionExpired(){
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

// ─────────────────────────────────────────────────────────────────
//  EXPORT GLOBAL
// ─────────────────────────────────────────────────────────────────
window.PIPSILY_AUTH = {
  supabase           : _supa,
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
  getGeoInfo,
  startSessionWatcher
};

// ─────────────────────────────────────────────────────────────────
//  SQL SUPABASE — Coller dans l'éditeur SQL de votre projet
// ─────────────────────────────────────────────────────────────────
/*
-- ① Profils utilisateurs
create table profiles (
  id                     uuid references auth.users primary key,
  email                  text,
  plan                   text default 'pending',  -- pending | active | unlimited | admin
  subscription_expires_at timestamptz,
  devices_allowed        integer default 1,
  parental_pin           text,
  created_at             timestamptz default now()
);

-- ② Appareils
create table devices (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references profiles(id) on delete cascade,
  device_id   text,
  device_name text,
  monthly_fee numeric default 0,
  last_seen   timestamptz default now(),
  created_at  timestamptz default now(),
  unique(user_id, device_id)
);

-- ③ Sessions (1 connexion simultanée)
create table sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references profiles(id) on delete cascade,
  device_id  text,
  token      text,
  created_at timestamptz default now()
);

-- ④ Paiements (suivi manuel Wero)
create table payments (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references profiles(id) on delete cascade,
  amount        numeric,
  type          text default 'subscription', -- subscription | extra_device
  period_start  date,
  period_end    date,
  confirmed_at  timestamptz,
  confirmed_by  uuid,
  notes         text,
  created_at    timestamptz default now()
);

-- ⑤ Trigger auto-création profil à l'inscription
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into profiles (id, email, plan)
  values (new.id, new.email,
    case when new.email = 'cedric.lago@gmail.com' then 'admin' else 'pending' end);
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- ⑥ RLS (Row Level Security)
alter table profiles enable row level security;
alter table devices  enable row level security;
alter table sessions enable row level security;
alter table payments enable row level security;

-- Lecture/écriture de son propre profil
create policy "own profile" on profiles for all using (auth.uid() = id);
-- Admin lit tout
create policy "admin all profiles" on profiles for all
  using ((select plan from profiles where id = auth.uid()) = 'admin');

create policy "own devices"  on devices  for all using (auth.uid() = user_id);
create policy "own sessions" on sessions for all using (auth.uid() = user_id);
create policy "own payments" on payments for all using (auth.uid() = user_id);
create policy "admin all devices"  on devices  for all
  using ((select plan from profiles where id = auth.uid()) = 'admin');
create policy "admin all payments" on payments for all
  using ((select plan from profiles where id = auth.uid()) = 'admin');
create policy "admin all sessions" on sessions for all
  using ((select plan from profiles where id = auth.uid()) = 'admin');
*/
