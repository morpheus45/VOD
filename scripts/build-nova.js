#!/usr/bin/env node
/**
 * Génère nova.html (3e thème, visuel moderne) à partir de cosmos.html.
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
const css  = fs.readFileSync(path.join(__dirname, 'nova', 'style.css'), 'utf8');

let out = src;
function sub(from, to, count = 1){
  const n = out.split(from).length - 1;
  if (n !== count) {
    console.error(`ECHEC: « ${from.slice(0, 60)} » trouvé ${n} fois (attendu ${count}) dans cosmos.html`);
    process.exit(1);
  }
  out = out.split(from).join(to);
}

// 1. Le grand bloc de style (celui qui suit <title>Cosmos TV</title>)
const openTag  = '<title>Cosmos TV</title>\n<style>';
const start    = out.indexOf(openTag);
if (start < 0) { console.error('ECHEC: bloc <style> principal introuvable'); process.exit(1); }
const cssStart = start + openTag.length;
const cssEnd   = out.indexOf('</style>', cssStart);
out = out.slice(0, start)
    + '<title>PIPSILY Nova</title>\n<style>\n' + css.trim() + '\n'
    + out.slice(cssEnd);

// 2. Thème courant (routage de index.html, sélecteur d'interface, réglages)
sub("localStorage.getItem('pf_theme') === 'cosmos'", "localStorage.getItem('pf_theme') === 'nova'");
sub("const THEME_CUR='cosmos', THEME_LABEL='Cosmos TV';", "const THEME_CUR='nova', THEME_LABEL='Nova';");
sub("' — PIPSILY Cosmos'", "' — PIPSILY Nova'");
sub('<div id="voice-label">COSMOS · VOICE</div>', '<div id="voice-label">NOVA · VOICE</div>');
// Splash : même encre que le fond Nova
sub('background:#060b16;display:flex;', 'background:#070a12;display:flex;');
// En-tête : dire d'où vient le fichier
sub('<!DOCTYPE html>\n<html lang="fr">\n<head>',
    '<!DOCTYPE html>\n<!-- FICHIER GÉNÉRÉ par scripts/build-nova.js depuis cosmos.html — ne pas éditer à la main,\n     modifier cosmos.html (logique) ou scripts/nova/style.css (visuel) puis relancer le script. -->\n<html lang="fr">\n<head>');

fs.writeFileSync(path.join(ROOT, 'nova.html'), out);
console.log(`nova.html écrit : ${out.split('\n').length} lignes (cosmos.html : ${src.split('\n').length})`);
