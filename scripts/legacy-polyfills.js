// ╔══════════════════════════════════════════════════════════════════════╗
// ║  Rustines posées en tête de chaque fichier de legacy/                ║
// ╚══════════════════════════════════════════════════════════════════════╝
//
// esbuild convertit la SYNTAXE vers Chrome 61. Il ne touche pas aux API : un
// « globalThis » compile tel quel et lève une ReferenceError sur le poste.
//
// Le bundle supabase-js en référence au premier niveau. Résultat sur
// l'autoradio : le fichier ne s'évalue pas, « window.supabase » reste indéfini,
// auth.js en conclut « Supabase CDN non chargé » et toute connexion répond
// « Service d'authentification indisponible ». Le poste avait pourtant
// Internet — rien dans le message ne pouvait le laisser deviner.
//
// Ces trois rustines sont exactes et sans effet sur un moteur récent : chacune
// ne se pose que si l'API manque vraiment.
//
// N'est PAS rustiné : AbortController (Chrome 66). Une version qui n'annule
// rien donnerait l'illusion d'un délai de garde là où il n'y en a plus. Les
// appels du dépôt le testent donc eux-mêmes avant de s'en servir.
(function () {
  "use strict";

  // ── globalThis — Chrome 71 ───────────────────────────────────────────
  // Le détour par un accesseur sur Object.prototype est la seule méthode qui
  // trouve l'objet global dans tous les contextes, y compris en mode strict.
  if (typeof globalThis !== "object") {
    var global_;
    try {
      Object.defineProperty(Object.prototype, "__pipsily_global__", {
        get: function () { return this; },
        configurable: true
      });
      global_ = __pipsily_global__;
      delete Object.prototype.__pipsily_global__;
    } catch (e) {
      global_ = typeof self !== "undefined" ? self
              : typeof window !== "undefined" ? window : null;
    }
    if (global_) { global_.globalThis = global_; }
  }

  // ── Object.fromEntries — Chrome 73 ───────────────────────────────────
  if (typeof Object.fromEntries !== "function") {
    Object.fromEntries = function (entries) {
      var out = {}, list = Array.from(entries);
      for (var i = 0; i < list.length; i++) { out[list[i][0]] = list[i][1]; }
      return out;
    };
  }

  // ── Promise.prototype.finally — Chrome 63 ────────────────────────────
  if (typeof Promise.prototype["finally"] !== "function") {
    Promise.prototype["finally"] = function (apres) {
      var C = this.constructor || Promise;
      return this.then(
        function (valeur) { return C.resolve(apres()).then(function () { return valeur; }); },
        function (erreur) { return C.resolve(apres()).then(function () { throw erreur; }); }
      );
    };
  }
})();
