const fs = require('fs');
const glob = require('glob');
const compFiles = glob.sync('src/**/*.js');
const keys = new Set();
const re = /t\(['\"]([^'\"]+)['\"]\)/g;
for (const file of compFiles) {
  const txt = fs.readFileSync(file, 'utf8');
  let m;
  while ((m = re.exec(txt))) {
    keys.add(m[1]);
  }
}
const langs = ['en', 'hu', 'de'];
const localeKeys = new Set();
for (const lang of langs) {
  const obj = JSON.parse(fs.readFileSync(`src/locales/${lang}.json`, 'utf8'));
  const walk = (o, p = '') => {
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      Object.keys(o).forEach(k => walk(o[k], p ? `${p}.${k}` : k));
    } else {
      localeKeys.add(p);
    }
  };
  walk(obj);
}
const missing = [];
for (const key of keys) {
  if (!localeKeys.has(key)) missing.push(key);
}
console.log('Used keys:', keys.size);
console.log('Missing in locale files:', missing.length);
missing.sort().forEach(k => console.log(k));
