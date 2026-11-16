#!/usr/bin/env node
/**
 * Génère les thèmes dérivés de cosmos.html : nova.html et bobine.html.
 *
 * Nova = la logique de Cosmos (navigation télécommande, zones, lecteur,
 * réglages) avec une autre peau : scripts/nova/style.css remplace le grand
 * <style> de cosmos.html, et quelques chaînes (titre, thème courant) sont
 * substituées. Toute correction faite dans cosmos.html se propage donc à
 * Nova en relançant :   node scripts/build-nova.js
 *
 * Le script échoue si un point de substitution n'existe plus dans
 * cosmos.html : c'est voulu, cela signale qu'il faut le mettre à jour.
 */
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src  = fs.readFileSync(path.join(ROOT, 'cosmos.html'), 'utf8');

// Une entrée par thème généré. `css` : feuilles concaténées dans l'ordre
// (Bobine s'applique par-dessus Nova).
const THEMES = [
  { id: 'nova',  label: 'Nova',  title: 'PIPSILY Nova',  splash: '#070a12', css: ['nova/style.css'] },
  { id: 'bobine', label: 'Bobine', title: 'PIPSILY Bobine', splash: '#050403', css: ['nova/style.css', 'bobine/style.css'] },
];

for (const T of THEMES) {
  let out = src;
  const sub = (from, to, count = 1) => {
    const n = out.split(from).length - 1;
    if (n !== count) {
      console.error(`ECHEC (${T.id}): « ${from.slice(0, 60)} » trouvé ${n} fois (attendu ${count}) dans cosmos.html`);
      process.exit(1);
    }
    out = out.split(from).join(to);
  };
  const css = T.css.map(f => fs.readFileSync(path.join(__dirname, f), 'utf8').trim()).join('\n\n');

  // 1. Le grand bloc de style (celui qui suit <title>Cosmos TV</title>)
  const openTag = '<title>Cosmos TV</title>\n<style>';
  const start = out.indexOf(openTag);
  if (start < 0) { console.error('ECHEC: bloc <style> principal introuvable'); process.exit(1); }
  const cssEnd = out.indexOf('</style>', start + openTag.length);
  out = out.slice(0, start) + '<title>' + T.title + '</title>\n<style>\n' + css + '\n' + out.slice(cssEnd);

  // 2. Thème courant (routage de index.html, sélecteur d'interface, réglages)
  sub("localStorage.getItem('pf_theme') === 'cosmos'", "localStorage.getItem('pf_theme') === '" + T.id + "'");
  sub("const THEME_CUR='cosmos', THEME_LABEL='Cosmos TV';", "const THEME_CUR='" + T.id + "', THEME_LABEL='" + T.label + "';");
  sub("' — PIPSILY Cosmos'", "' — PIPSILY " + T.label + "'");
  sub('<div id="voice-label">COSMOS · VOICE</div>', '<div id="voice-label">' + T.label.toUpperCase() + ' · VOICE</div>');
  sub('background:#060b16;display:flex;', 'background:' + T.splash + ';display:flex;');
  sub('<!DOCTYPE html>\n<html lang="fr">\n<head>',
      '<!DOCTYPE html>\n<!-- FICHIER GÉNÉRÉ par scripts/build-nova.js depuis cosmos.html — ne pas éditer à la main,\n     modifier cosmos.html (logique) ou scripts/' + T.id + '/style.css (visuel) puis relancer le script. -->\n<html lang="fr">\n<head>');

  fs.writeFileSync(path.join(ROOT, T.id + '.html'), out);
  console.log(`${T.id}.html écrit : ${out.split('\n').length} lignes (cosmos.html : ${src.split('\n').length})`);
}
