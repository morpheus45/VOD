
// --- PWA install (Chrome/Android) ---
let __deferredInstallPrompt = null;

function __setInstallBtnState() {
  const btn = document.getElementById('installBtn');
  if (!btn) return;
  // Toujours visible (comme demandé), mais activé seulement si le navigateur autorise prompt()
  btn.style.display = 'inline-flex';
  btn.disabled = !__deferredInstallPrompt;
  btn.title = __deferredInstallPrompt
    ? 'Installer l’application'
    : 'Installation: menu du navigateur → "Ajouter à l’écran d’accueil" (si disponible)';
}

window.addEventListener('beforeinstallprompt', (e) => {
  // Sur Android/Chrome, l’app doit être "installable" pour que cet event se déclenche.
  e.preventDefault();
  __deferredInstallPrompt = e;
  __setInstallBtnState();
});

window.addEventListener('appinstalled', () => {
  __deferredInstallPrompt = null;
  __setInstallBtnState();
});

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest && ev.target.closest('#installBtn');
  if (!btn) return;

  // Si le navigateur ne supporte pas le prompt, on guide l’utilisateur.
  if (!__deferredInstallPrompt) {
    alert('Ton navigateur ne propose pas le bouton d’installation ici.\n\nEssaie:\n• Menu ⋮ du navigateur → "Ajouter à l’écran d’accueil"\n• ou ouvre avec Chrome (Android) si possible.');
    return;
  }

  try {
    __deferredInstallPrompt.prompt();
    await __deferredInstallPrompt.userChoice;
  } catch (err) {
    console.warn('Install prompt failed:', err);
  } finally {
    __deferredInstallPrompt = null;
    __setInstallBtnState();
  }
});

// Service worker: indispensable pour que l’app devienne installable
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(() => console.log('[SW] registered'))
      .catch((e) => console.warn('[SW] register failed', e));
  });
}

document.addEventListener('DOMContentLoaded', __setInstallBtnState);



const STORAGE="vod_m3u_entries_v4";
const CATS="vod_m3u_cats_v4";
const $=id=>document.getElementById(id);

let entries=[];
let cats=[];
let activeCat="Tous";

function sanitize(s){return (s||"").toString().trim();}
function isUrl(u){try{new URL(u);return true;}catch{return false;}}
function uniqCatsFromEntries(arr){
  const set=new Map();
  for(const e of arr){
    const c=sanitize(e.category)||"Films";
    if(!set.has(c.toLowerCase())) set.set(c.toLowerCase(), c);
  }
  return Array.from(set.values()).sort((a,b)=>a.localeCompare(b));
}
function loadLocal(){
  try{
    const raw=localStorage.getItem(STORAGE);
    if(raw){
      const a=JSON.parse(raw);
      if(Array.isArray(a)) entries=a;
    }
  }catch{}
  try{
    const raw=localStorage.getItem(CATS);
    if(raw){
      const a=JSON.parse(raw);
      if(Array.isArray(a)) cats=a;
    }
  }catch{}
  if(!cats.length) cats=uniqCatsFromEntries(entries);
}
async function loadVodJson(){
  try{
    const res=await fetch("./vod.json", {cache:"no-store"});
    if(!res.ok) throw new Error("http "+res.status);
    const obj=await res.json();
    if(Array.isArray(obj)) entries=obj;
    else if(obj && Array.isArray(obj.entries)) entries=obj.entries;
    if(!Array.isArray(entries)) entries=[];
  }catch(e){
    // ignore
  }
  cats = uniqCatsFromEntries(entries);
}

function getVisibleEntries(){
  const q=sanitize($("filter").value).toLowerCase();
  let arr=entries.slice();
  if(activeCat!=="Tous"){
    arr=arr.filter(e=>(sanitize(e.category)||"Films").toLowerCase()===activeCat.toLowerCase());
  }
  if(q){
    arr=arr.filter(e=>{
      return (sanitize(e.title).toLowerCase().includes(q) ||
              sanitize(e.category).toLowerCase().includes(q));
    });
  }
  const sort=$("sort").value;
  if(sort==="title") arr.sort((a,b)=>sanitize(a.title).localeCompare(sanitize(b.title)));
  else if(sort==="added_desc") arr.sort((a,b)=>sanitize(b.added_at).localeCompare(sanitize(a.added_at)));
  else arr.sort((a,b)=>sanitize(a.category).localeCompare(sanitize(b.category)) || sanitize(a.title).localeCompare(sanitize(b.title)));
  return arr;
}

function renderTabs(){
  const tabs=$("tabs");
  tabs.innerHTML="";
  const all=["Tous", ...uniqCatsFromEntries(entries)];
  for(const c of all){
    const b=document.createElement("button");
    b.className="tab"+(c===activeCat?" active":"");
    b.textContent=c;
    b.onclick=()=>{activeCat=c; renderAll();};
    tabs.appendChild(b);
  }
}

function openVideo(url){
  if(!url) return;
  // Open in a new tab WITHOUT navigating away from the vitrine.
  const a=document.createElement('a');
  a.href=url;
  a.target='_blank';
  a.rel='noopener noreferrer';
  a.style.display='none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setStatus("Si rien ne s’ouvre, autorise les pop-ups pour ce site.");
}

function renderGallery(){
  const gallery=$("gallery");
  gallery.innerHTML="";
  const arr=getVisibleEntries();
  $("count").textContent=String(arr.length);
  for(const it of arr){
    const d=document.createElement("div");
    d.className="poster";
    const img=document.createElement("img");
    img.loading="lazy";
    img.referrerPolicy="no-referrer";
    img.src=sanitize(it.image)||"";
    img.alt=sanitize(it.title)||"poster";
    img.onerror=()=>{ img.removeAttribute("src"); };
    const cap=document.createElement("div");
    cap.className="cap";
    cap.textContent=sanitize(it.title)||"Sans titre";
    d.appendChild(img); d.appendChild(cap);
    d.onclick=()=>openVideo(sanitize(it.url));
    gallery.appendChild(d);
  }
}

function setStatus(t){ $("status").textContent=t||""; }

async function reloadData(){
  setStatus("Chargement…");
  entries=[];
  cats=[];
  loadLocal();
  if(!entries.length){
    await loadVodJson();
    if(entries.length) setStatus("Chargé depuis vod.json.");
    else setStatus("Aucune donnée trouvée. Ajoute via Admin puis exporte en vod.json.");
  } else {
    setStatus("Chargé depuis ton stockage local (admin).");
  }
  entries = entries.filter(e=>e && typeof e==="object" && isUrl(e.url))
    .map(e=>({
      title:sanitize(e.title)||"video",
      category:sanitize(e.category)||"Films",
      url:sanitize(e.url),
      image:sanitize(e.image)||"",
      added_at:sanitize(e.added_at)||""
    }));
  renderAll();
}

function renderAll(){
  renderTabs();
  renderGallery();
}

const refreshBtn = $("refresh");
if (refreshBtn) refreshBtn.addEventListener("click", reloadData);
const filterEl = $("filter");
if (filterEl) filterEl.addEventListener("input", renderAll);
const sortEl = $("sort");
if (sortEl) sortEl.addEventListener("change", renderAll);

if("serviceWorker" in navigator){
  window.addEventListener("load",()=>{navigator.serviceWorker.register("./sw.js").catch(()=>{});});
}

reloadData();
