'use strict';

// "Dinesh Aarjav, NRI Tax!" -> "dinesh-aarjav-nri-tax"
function slugify(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60).replace(/-+$/, '');
}

/**
 * A slug that is not in `taken`. A name that slugifies to something reserved (a word the address bar already
 * uses, such as "new") is swapped for the fallback given in `reserved`.
 */
function uniqueSlug(name, taken, { reserved = {}, fallback = 'item' } = {}) {
  let base = slugify(name) || fallback;
  if (reserved[base]) base = reserved[base];
  let s = base, n = 2;
  while (taken.has(s)) s = `${base}-${n++}`;
  return s;
}

module.exports = { slugify, uniqueSlug };
