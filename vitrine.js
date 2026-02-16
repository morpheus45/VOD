
const STORAGE="vod_m3u_entries_v4";
const CATS="vod_m3u_cats_v4";
const $=id=>document.getElementById(id);

// --- PWA install button (Android Chrome) ---
let deferredPrompt = null;
function setupInstallButton(){
  const btn = document.getElementById("installBtn");
  if(!btn) return;
  // Hide if already installed
  try{
    if(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches){
      btn.hidden = true;
      return;
    }
  }catch(_){}
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    btn.hidden = false;
  });
  btn.addEventListener("click", async () => {
    if(!deferredPrompt){
      alert("Installation non disponible sur ce navigateur / cet appareil. Sur Android: menu ⋮ > Ajouter à l’écran d’accueil.");
      return;
    }
    deferredPrompt.prompt();
    try{ await deferredPrompt.userChoice; }catch(_){}
    deferredPrompt = null;
    btn.hidden = true;
  });
  window.addEventListener("appinstalled", () => {
    btn.hidden = true;
    deferredPrompt = null;
  });
}

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

setupInstallButton();
reloadData();