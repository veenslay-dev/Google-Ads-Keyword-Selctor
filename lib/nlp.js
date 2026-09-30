'use strict';

const STOP = new Set(('a an and are as at be by for from has have i if in into is it its of on or our so that the their them then there these they this to us was we were what when where which who why will with you your ' +
  'about all also any can do does how more most not only other out over than too very just up down off own same such no nor both each few some ' +
  'am been being did having he her hers him his me my she should would could may might must shall').split(/\s+/));

// Words that shape intent but say nothing about what the business sells.
const MODIFIERS = new Set(('near nearby me best top cheap cheapest affordable buy price prices pricing cost costs quote quotes online service services company companies ' +
  'agency agencies provider providers shop shops store stores sale hire order get find good new review reviews compare vs versus local ' +
  'professional expert experts specialist specialists firm firms contractor contractors supplier suppliers').split(/\s+/));

// Boilerplate that shows up on almost every site and would pollute the profile.
const WEB_NOISE = new Set(('home contact privacy policy cookie cookies terms conditions login menu skip content copyright rights reserved click read subscribe newsletter ' +
  'share follow facebook twitter instagram linkedin youtube pinterest tiktok whatsapp email phone call address website site page pages search cart checkout account ' +
  'sign register blog news faq faqs sitemap powered').split(/\s+/));

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Light suffix stripper. It does not need to be linguistically right,
// only consistent so "plumber", "plumbers" and "plumbing" land on one form.
function stem(w) {
  if (w.length <= 3 || /^\d+$/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) w = w.slice(0, -3) + 'y';
  else if (/(ss|us|is)$/.test(w)) { /* leave as is */ }
  else if (/(ch|sh|x|z|ss)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) {
    w = w.slice(0, -3);
    if (/([^aeiou])\1$/.test(w)) w = w.slice(0, -1);
  } else if (w.length > 5 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 6 && w.endsWith('er')) w = w.slice(0, -2);
  return w;
}

function words(s) {
  const n = normalize(s);
  return n ? n.split(' ') : [];
}

// Content tokens: stemmed, no stop words, no intent modifiers, no web noise.
function contentTokens(s) {
  const out = [];
  for (const w of words(s)) {
    if (STOP.has(w) || MODIFIERS.has(w) || WEB_NOISE.has(w)) continue;
    if (w.length < 2) continue;
    out.push(stem(w));
  }
  return out;
}

function bigrams(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length - 1; i++) out.push(tokens[i] + ' ' + tokens[i + 1]);
  return out;
}

module.exports = { STOP, MODIFIERS, WEB_NOISE, normalize, stem, words, contentTokens, bigrams };
