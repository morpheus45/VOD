/* PIPSILY — réglage Xtream (admin) + pays des chaînes TV. Partagé par Xstream,
   Cosmos et l'admin. Écrit en ES5 : il doit tourner sur tous les moteurs.
   - Les identifiants (url, port, id, mot de passe) vivent dans Supabase
     (table app_config, clé "xtream"), copiés en local pour démarrer sans réseau.
   - fix() réécrit les URL Xtream des catalogues avec ces identifiants.
   - Pays : code tiré de la catégorie (« EU | FR | SPORTS » → FR). */
(function (w) {
  var SB = 'https://gwmuazostbbgroplnlql.supabase.co';
  var AK = 'sb_publishable_cNZ37Mjd57b_9nlyCvtkkA_wSIszOMR';
  var K = 'pf_xt', KC = 'pf_live_country';
  var REGIONS = { EU: 1, AF: 1, AS: 1, AM: 1, LATAM: 1, INT: 1, VIP: 1 };
  var RE1 = /(https?:\/\/[^\/"\s]+)\/(live|movie|series)\/([^\/"\s]+)\/([^\/"\s]+)\//g;
  var RE2 = /(https?:\/\/[^\/"\s]+)\/(player_api|get|xmltv)\.php\?username=([^&"\s]+)&password=([^&"\s]+)/g;

  function ls(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {}
    return null;
  }
  function cfg() {
    try { var c = JSON.parse(ls(K) || 'null'); return c && c.url && c.user && c.pass ? c : null; } catch (e) { return null; }
  }
  function base(c) {
    var u = String(c.url).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    if (c.port) u = u.replace(/:\d+$/, '') + ':' + String(c.port).trim();
    return u;
  }
  function fixStr(s, c) {
    var b = base(c);
    return s.replace(RE1, function (m, h, t) { return /pluto/i.test(h) ? m : b + '/' + t + '/' + c.user + '/' + c.pass + '/'; })
            .replace(RE2, function (m, h, t) { return b + '/' + t + '.php?username=' + c.user + '&password=' + c.pass; });
  }
  function fix(o) {
    var c = cfg();
    if (!c || o == null) return o;
    if (typeof o === 'string') return fixStr(o, c);
    try { var s = JSON.stringify(o), f = fixStr(s, c); return f === s ? o : JSON.parse(f); } catch (e) { return o; }
  }
  // Lit la config publiée par l'admin ; si elle a changé, recharge une fois
  // pour que les catalogues soient relus avec les nouveaux identifiants.
  function sync() {
    if (!w.fetch) return;
    w.fetch(SB + '/rest/v1/app_config?key=eq.xtream&select=value', { headers: { apikey: AK, Authorization: 'Bearer ' + AK } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        if (!rows) return;                       // erreur réseau / table absente : on garde l'existant
        var v = rows[0] && rows[0].value && rows[0].value.url ? JSON.stringify(rows[0].value) : null;
        if (v === ls(K)) return;
        ls(K, v);
        if (v === ls(K) && !w.PF_XT_NORELOAD) { try { if (sessionStorage.getItem('pf_xt_rl') === String(v)) return; sessionStorage.setItem('pf_xt_rl', String(v)); } catch (e) { return; } location.reload(); }
      })['catch'](function () {});
  }

  function country(cat) {
    var p = String(cat || '').split('|'), i, out = [];
    for (i = 0; i < p.length; i++) if (p[i].trim()) out.push(p[i].trim());
    var re = /^[A-Z]{2,3}$/;
    if (out.length >= 3 && re.test(out[1])) return out[1];
    if (out.length >= 2 && re.test(out[0]) && !REGIONS[out[0]]) return out[0];
    return '';
  }
  // codeOf(item) → code pays de l'item ('' si aucun)
  function countries(items, codeOf) {
    var seen = {}, list = [], i, c;
    for (i = 0; i < items.length; i++) { c = codeOf(items[i]); if (c && !seen[c]) { seen[c] = 1; list.push(c); } }
    return list.sort();
  }
  function label(code) {
    try { var n = new Intl.DisplayNames(['fr'], { type: 'region' }).of(code === 'UK' ? 'GB' : code); if (n && n !== code) return n + ' (' + code + ')'; } catch (e) {}
    return code;
  }
  // Choix mémorisé ; par défaut FR s'il existe, sinon tous les pays ('').
  function getCountry(list) {
    var c = ls(KC);
    if (c === null) c = list.indexOf('FR') >= 0 ? 'FR' : '';
    return c && list.indexOf(c) < 0 ? '' : c;
  }
  function setCountry(c) { ls(KC, c || ''); }
  // Les chaînes sans code pays (ex. « For Adults ») ne sont jamais écartées.
  function filterLive(items, codeOf, sel) {
    if (!sel) return items;
    var out = [], i, c;
    for (i = 0; i < items.length; i++) { c = codeOf(items[i]); if (!c || c === sel) out.push(items[i]); }
    return out;
  }

  w.PF_XT = { cfg: cfg, base: base, fix: fix, sync: sync, KEY: K, country: country, countries: countries, label: label, getCountry: getCountry, setCountry: setCountry, filterLive: filterLive };
  sync();
})(window);
