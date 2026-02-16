let deferredPrompt=null;
const $=id=>document.getElementById(id);

const titleEl=$("title"), categoryEl=$("category"), newCatBtn=$("newCatBtn");
const videoUrlEl=$("videoUrl"), imageUrlEl=$("imageUrl");
const addBtn=$("addBtn"), addNextBtn=$("addNextBtn"), clearFormBtn=$("clearFormBtn");
const formStatus=$("formStatus");

const countEl=$("count"), playlistNameEl=$("playlistName"), logoModeEl=$("logoMode");
const sortEl=$("sort"), filterEl=$("filter");
const buildBtn=$("buildBtn"), downloadBtn=$("downloadBtn");
const exportJsonBtn=$("exportJsonBtn"), importJsonBtn=$("importJsonBtn"), jsonFile=$("jsonFile");
const importM3uBtn=$("importM3uBtn"), m3uFile=$("m3uFile");
const clearAllBtn=$("clearAllBtn");
const tbody=$("tbody"), preview=$("preview"), status=$("status"), installBtn=$("installBtn");
const bulkEl=$("bulk"), bulkBtn=$("bulkBtn"), bulkStatus=$("bulkStatus");

const tabsEl=$("tabs"), galleryEl=$("gallery");

const modal=$("modal"), mImg=$("mImg"), mTitle=$("mTitle"), mCat=$("mCat"), mUrl=$("mUrl");
const copyUrlBtn=$("copyUrlBtn"), copyImgBtn=$("copyImgBtn"), closeBtn=$("closeBtn");

const STORAGE="vod_m3u_entries_v4";
const CATS="vod_m3u_cats_v4";
let entries=[];
let cats=["Action","Horreur","Animé","Fantastique","Comédie","Thriller","Drame","Déjà vus"];
let activeCat="Tous";

const sanitize=s=>(s||"").trim();
function nowIso(){return new Date().toISOString();}
function isUrl(u){try{new URL(u);return true;}catch{return false;}}
function looksTruncated(u){return (u||"").includes("...") || (u||"").includes("…");}
function setForm(m){formStatus.textContent=m||"";}
function setStatus(m){status.textContent=m||"";}
function setBulk(m){bulkStatus.textContent=m||"";}

function save(){localStorage.setItem(STORAGE,JSON.stringify(entries));localStorage.setItem(CATS,JSON.stringify(cats));}
function load(){
  try{const raw=localStorage.getItem(STORAGE); if(raw){const a=JSON.parse(raw); if(Array.isArray(a)) entries=a;}}catch{}
  try{const raw=localStorage.getItem(CATS); if(raw){const a=JSON.parse(raw); if(Array.isArray(a)&&a.length) cats=a;}}catch{}
}

function ensureCat(c){
  const cc=sanitize(c);
  if(!cc) return;
  if(!cats.some(x=>x.toLowerCase()===cc.toLowerCase())) cats.push(cc);
}

function renderCats(){
  categoryEl.innerHTML="";
  for(const c of cats){
    const o=document.createElement("option");
    o.value=c;o.textContent=c;
    categoryEl.appendChild(o);
  }
}

function clearForm(keepCategory=false){
  titleEl.value=""; videoUrlEl.value=""; imageUrlEl.value="";
  if(!keepCategory) categoryEl.selectedIndex=0;
  setForm(""); titleEl.focus();
}

function addEntry({next=false}={}){
  const title=sanitize(titleEl.value);
  const category=sanitize(categoryEl.value)||"Films";
  const url=sanitize(videoUrlEl.value);
  const image=sanitize(imageUrlEl.value);

  if(!title){setForm("Titre manquant.");return;}
  if(!url||!isUrl(url)){setForm("URL vidéo invalide.");return;}
  if(looksTruncated(url)){setForm("URL vidéo tronquée ( ... ). Copie l’URL complète.");return;}
  if(image){
    if(!isUrl(image)){setForm("URL image invalide.");return;}
    if(looksTruncated(image)){setForm("URL image tronquée ( ... ). Copie l’URL complète.");return;}
  }
  if(entries.some(e=>sanitize(e.url).toLowerCase()===url.toLowerCase())){setForm("Déjà présent (même URL).");return;}

  entries.push({title,category,url,image,added_at:nowIso()});
  ensureCat(category);
  save();
  renderAll();
  setForm("Ajouté.");
  if(next) clearForm(true);
}

function removeEntry(idx){
  if(!confirm("Supprimer cette entrée ?")) return;
  entries.splice(idx,1); save(); renderAll();
}

function formatDate(iso){try{return new Date(iso).toLocaleString();}catch{return iso||"";}}

function getVisibleEntries(){
  const q=sanitize(filterEl.value).toLowerCase();
  let arr=entries.slice();

  if(activeCat && activeCat!=="Tous"){
    arr = arr.filter(e => (e.category||"").toLowerCase() === activeCat.toLowerCase());
  }
  if(q){arr=arr.filter(e=>(e.title||"").toLowerCase().includes(q)||(e.category||"").toLowerCase().includes(q)||(e.url||"").toLowerCase().includes(q));}

  const s=sortEl.value;
  if(s==="title"){arr.sort((a,b)=>(a.title||"").localeCompare(b.title||""));}
  else if(s==="cat_title"){arr.sort((a,b)=>(a.category||"").localeCompare(b.category||"")||(a.title||"").localeCompare(b.title||""));}
  else {arr.sort((a,b)=>(b.added_at||"").localeCompare(a.added_at||""));}
  return arr;
}

function renderTable(){
  const arr=getVisibleEntries();
  tbody.innerHTML="";
  arr.forEach((it,i)=>{
    const idx=entries.indexOf(it);
    const tr=document.createElement("tr");
    tr.innerHTML=`<td>${i+1}</td>
      <td>${it.title||""}</td>
      <td>${it.category||""}</td>
      <td class="mono">${it.url||""}</td>
      <td class="mono">${it.image||""}</td>
      <td>${formatDate(it.added_at)}</td>
      <td><button class="btn btn-danger" data-idx="${idx}">Suppr</button></td>`;
    tr.querySelector("button").onclick=()=>removeEntry(idx);
    tbody.appendChild(tr);
  });
  countEl.textContent=String(entries.length);
  downloadBtn.disabled=entries.length===0;
}

function renderTabs(){
  tabsEl.innerHTML="";
  const allCats = ["Tous", ...cats];
  for(const c of allCats){
    const b=document.createElement("button");
    b.className="tab" + (c===activeCat ? " active" : "");
    b.textContent=c;
    b.onclick=()=>{activeCat=c; renderAll();};
    tabsEl.appendChild(b);
  }
}

function openModal(it){
  mTitle.textContent = it.title || "";
  mCat.textContent = it.category ? `Catégorie: ${it.category}` : "";
  mUrl.textContent = it.url || "";
  mImg.src = it.image || "";
  mImg.alt = it.title || "Poster";
  modal.classList.add("open");
  copyUrlBtn.onclick = async()=>{ try{ await navigator.clipboard.writeText(it.url||""); }catch{} };
  copyImgBtn.onclick = async()=>{ try{ await navigator.clipboard.writeText(it.image||""); }catch{} };
}
function closeModal(){ modal.classList.remove("open"); }
closeBtn.addEventListener("click", closeModal);
modal.addEventListener("click", (e)=>{ if(e.target===modal) closeModal(); });

function renderGallery(){
  const arr=getVisibleEntries();
  galleryEl.innerHTML="";
  arr.forEach(it=>{
    const d=document.createElement("div");
    d.className="poster";
    const img=document.createElement("img");
    img.loading="lazy";
    img.referrerPolicy="no-referrer";
    img.src=it.image || "";
    img.alt=it.title || "poster";
    img.onerror=()=>{ img.removeAttribute("src"); img.alt="(image indisponible)"; img.style.background="rgba(255,255,255,.06)"; };
    const cap=document.createElement("div");
    cap.className="cap";
    cap.textContent=it.title || "";
    d.appendChild(img); d.appendChild(cap);
    d.onclick=()=>openModal(it);
    galleryEl.appendChild(d);
  });
}

function escapeAttr(s){return String(s||"").replace(/"/g,'\"');}
function buildM3UText(){
  const logoMode=logoModeEl.value;
  const lines=["#EXTM3U"];
  // export ALL entries (not only active tab)
  const arr = entries.slice().sort((a,b)=>(b.added_at||"").localeCompare(a.added_at||""));
  for(const it of arr){
    const attrs=[];
    if(it.category) attrs.push(`group-title="${escapeAttr(it.category)}"`);
    if(it.image && logoMode!=="none"){
      if(logoMode==="tvg-logo"||logoMode==="both") attrs.push(`tvg-logo="${escapeAttr(it.image)}"`);
      if(logoMode==="logo"||logoMode==="both") attrs.push(`logo="${escapeAttr(it.image)}"`);
    }
    if(it.title) attrs.push(`tvg-name="${escapeAttr(it.title)}"`);
    const a=attrs.length?" "+attrs.join(" "):"";
    lines.push(`#EXTINF:-1${a},${it.title}`);
    lines.push(it.url);
  }
  return lines.join("\n")+"\n";
}

let lastM3U="", lastFile="vod.m3u";
function generate(){
  if(!entries.length){setStatus("Aucune entrée."); preview.textContent=""; return;}
  lastM3U=buildM3UText();
  lastFile=(sanitize(playlistNameEl.value)||"vod")+".m3u";
  preview.textContent=lastM3U;
  setStatus("Playlist générée.");
}
function download(){
  if(!lastM3U) generate();
  if(!lastM3U) return;
  const blob=new Blob([lastM3U],{type:"audio/x-mpegurl;charset=utf-8"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a"); a.href=url; a.download=lastFile;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1500);
  setStatus(`Téléchargé: ${lastFile}`);
}

function exportJson(){
  const blob=new Blob([JSON.stringify({cats,entries},null,2)],{type:"application/json;charset=utf-8"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a"); a.href=url; a.download=(sanitize(playlistNameEl.value)||"vod")+".json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1500);
  setStatus("JSON exporté.");
}
function importJsonObj(obj){
  if(!obj) throw new Error("vide");
  if(Array.isArray(obj)){ entries=obj; }
  else { if(Array.isArray(obj.cats)) cats=obj.cats; if(Array.isArray(obj.entries)) entries=obj.entries; }
  entries=entries.filter(e=>e&&typeof e==="object"&&isUrl(e.url))
    .map(e=>({title:sanitize(e.title)||"video",category:sanitize(e.category)||"Films",url:sanitize(e.url),image:sanitize(e.image)||"",added_at:sanitize(e.added_at)||nowIso()}));
  for(const e of entries) ensureCat(e.category);
  save(); renderAll(); setStatus(`Import OK: ${entries.length} entrée(s).`);
}
function importJsonFile(file){
  const r=new FileReader();
  r.onload=()=>{try{importJsonObj(JSON.parse(String(r.result||"null")));}catch{setStatus("Import JSON impossible.");}};
  r.readAsText(file,"utf-8");
}

function clearAll(){
  if(!confirm("Tout supprimer ?")) return;
  entries=[]; save(); renderAll(); preview.textContent=""; lastM3U=""; setStatus("Tout supprimé.");
}

function newCategory(){
  const name=prompt("Nom de la nouvelle catégorie ?");
  const c=sanitize(name); if(!c) return;
  ensureCat(c);
  renderCats();
  categoryEl.value=c;
  save();
}

function bulkImport(){
  const t=sanitize(bulkEl.value);
  if(!t){setBulk("Colle au moins une ligne."); return;}
  const lines=t.split(/\r?\n/).map(sanitize).filter(Boolean);
  let added=0, skipped=0;
  for(const line of lines){
    const parts=line.split("|").map(p=>sanitize(p));
    if(parts.length<3){skipped++; continue;}
    const [title,category,url,image]=parts;
    if(!title||!category||!url){skipped++; continue;}
    if(!isUrl(url)||looksTruncated(url)){skipped++; continue;}
    if(image && (!isUrl(image)||looksTruncated(image))){skipped++; continue;}
    if(entries.some(e=>sanitize(e.url).toLowerCase()===url.toLowerCase())){skipped++; continue;}
    ensureCat(category);
    entries.push({title,category,url,image:image||"",added_at:nowIso()});
    added++;
  }
  save(); renderAll();
  setBulk(added?`Ajouté ${added} entrée(s). (Ignoré: ${skipped})`:`Aucune entrée ajoutée. (Ignoré: ${skipped})`);
}

/* M3U import */
function attrValue(line, key){
  const re = new RegExp(key + '="([^"]*)"', 'i');
  const m = line.match(re);
  return m ? m[1] : "";
}
function parseExtinf(line){
  const category = attrValue(line, "group-title");
  const logo1 = attrValue(line, "tvg-logo");
  const logo2 = attrValue(line, "logo");
  const image = logo1 || logo2 || "";
  let title = "";
  const idx = line.indexOf(",");
  if(idx >= 0) title = sanitize(line.slice(idx+1));
  if(!title) title = attrValue(line, "tvg-name");
  return {title, category, image};
}
function importM3UText(text){
  const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l.length>0);
  let i=0, added=0;
  while(i < lines.length){
    const line = lines[i];
    if(line.startsWith("#EXTINF")){
      const info = parseExtinf(line);
      const url = (i+1 < lines.length) ? sanitize(lines[i+1]) : "";
      if(url && isUrl(url)){
        if(!entries.some(e=>sanitize(e.url).toLowerCase()===url.toLowerCase())){
          const title = info.title || "video";
          const category = info.category || "Films";
          const image = info.image || "";
          ensureCat(category);
          entries.push({title,category,url,image,added_at:nowIso()});
          added++;
        }
      }
      i += 2;
      continue;
    }
    i++;
  }
  save(); renderAll();
  setStatus(added ? `Import M3U OK: +${added} entrée(s).` : "Import M3U: aucune nouvelle entrée.");
}
function importM3UFile(file){
  const r=new FileReader();
  r.onload=()=>{ try{ importM3UText(String(r.result||"")); }catch{ setStatus("Import M3U impossible."); } };
  r.readAsText(file, "utf-8");
}

function renderAll(){
  renderCats();
  renderTabs();
  renderTable();
  renderGallery();
}

window.addEventListener("beforeinstallprompt",(e)=>{e.preventDefault(); deferredPrompt=e; installBtn.hidden=false;});
installBtn.addEventListener("click",async()=>{if(!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt=null; installBtn.hidden=true;});

if("serviceWorker" in navigator){
  window.addEventListener("load",()=>{navigator.serviceWorker.register("./sw.js").catch(()=>{});});
}

addBtn.addEventListener("click",()=>addEntry({next:false}));
addNextBtn.addEventListener("click",()=>addEntry({next:true}));
clearFormBtn.addEventListener("click",()=>clearForm(false));
newCatBtn.addEventListener("click",newCategory);

buildBtn.addEventListener("click",generate);
downloadBtn.addEventListener("click",download);

exportJsonBtn.addEventListener("click",exportJson);
importJsonBtn.addEventListener("click",()=>jsonFile.click());
jsonFile.addEventListener("change",(e)=>{const f=e.target.files && e.target.files[0]; if(f) importJsonFile(f); jsonFile.value="";});

importM3uBtn.addEventListener("click",()=>m3uFile.click());
m3uFile.addEventListener("change",(e)=>{const f=e.target.files && e.target.files[0]; if(f) importM3UFile(f); m3uFile.value="";});

clearAllBtn.addEventListener("click",clearAll);
sortEl.addEventListener("change",renderAll);
filterEl.addEventListener("input",renderAll);
bulkBtn.addEventListener("click",bulkImport);

closeBtn.addEventListener("click",()=>modal.classList.remove("open"));

load();
renderAll();
