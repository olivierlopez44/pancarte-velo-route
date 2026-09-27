// Logique pure de l'outil pancartes (sans DOM) : géométrie, limites communales,
// détection des frontières, formatage des noms. Utilisable dans le navigateur
// (window.PancarteCore) et dans Node (require) pour les tests.
(function(root){
'use strict';

const R = 6371000;
const toRad = x => x*Math.PI/180;

// ---------- Géométrie du tracé ----------
function haversine(a,b){
  const dLat = toRad(b.lat-a.lat), dLon = toRad(b.lon-a.lon);
  const s = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLon/2)**2;
  return 2*R*Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
}

function cumulativeDistances(pts){
  const cum = [0];
  for(let i=1;i<pts.length;i++) cum.push(cum[i-1] + haversine(pts[i-1], pts[i]));
  return cum;
}

function pointAtDistance(pts, cum, target){
  const total = cum[cum.length-1];
  if(target<=0) return pts[0];
  if(target>=total) return pts[pts.length-1];
  let lo=0, hi=cum.length-1;
  while(lo<hi){
    const mid=(lo+hi)>>1;
    if(cum[mid]<target) lo=mid+1; else hi=mid;
  }
  const i=lo, i0=i-1;
  const segLen = cum[i]-cum[i0];
  const t = segLen===0 ? 0 : (target-cum[i0])/segLen;
  return {
    lat: pts[i0].lat + t*(pts[i].lat-pts[i0].lat),
    lon: pts[i0].lon + t*(pts[i].lon-pts[i0].lon)
  };
}

// Douglas-Peucker en projection locale (tolérance en mètres).
function simplify(pts, tolerance){
  if(pts.length<=2) return pts.slice();
  const kx = R*Math.cos(toRad(pts[0].lat))*Math.PI/180, ky = R*Math.PI/180;
  const xy = pts.map(p=>[p.lon*kx, p.lat*ky]);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length-1] = 1;
  const stack = [[0, pts.length-1]];
  const tol2 = tolerance*tolerance;
  while(stack.length){
    const [a,b] = stack.pop();
    const [ax,ay] = xy[a], [bx,by] = xy[b];
    const dx = bx-ax, dy = by-ay, len2 = dx*dx+dy*dy;
    let maxD = -1, idx = -1;
    for(let i=a+1;i<b;i++){
      const [px,py] = xy[i];
      let t = len2 ? ((px-ax)*dx+(py-ay)*dy)/len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = ax+t*dx-px, ey = ay+t*dy-py, d = ex*ex+ey*ey;
      if(d>maxD){ maxD=d; idx=i; }
    }
    if(idx>=0 && maxD>tol2){ keep[idx]=1; stack.push([a,idx],[idx,b]); }
  }
  return pts.filter((_,i)=>keep[i]);
}

// ---------- Limites communales (Overpass) ----------
// Requête : toutes les limites admin_level donné à moins de `radius` m du tracé simplifié.
function buildOverpassQuery(pts, adminLevel=8, maxPoints=1500){
  let tol = 25, s = simplify(pts, tol);
  while(s.length > maxPoints){ tol *= 2; s = simplify(pts, tol); }
  const radius = Math.max(50, Math.ceil(tol*2));
  const coords = s.map(p=>p.lat.toFixed(5)+','+p.lon.toFixed(5)).join(',');
  return `[out:json][timeout:180];rel["boundary"="administrative"]["admin_level"="${adminLevel}"](around:${radius},${coords});out geom;`;
}

// Recolle des chemins ([lon,lat][]) bout à bout pour former des anneaux fermés.
function assembleRings(ways){
  const same = (p,q) => p[0]===q[0] && p[1]===q[1];
  const pool = ways.filter(w=>w.length>=2).map(w=>w.slice());
  const rings = [];
  while(pool.length){
    let ring = pool.pop();
    while(!same(ring[0], ring[ring.length-1])){
      const end = ring[ring.length-1];
      let found = -1, rev = false;
      for(let i=0;i<pool.length;i++){
        if(same(pool[i][0], end)){ found=i; break; }
        if(same(pool[i][pool[i].length-1], end)){ found=i; rev=true; break; }
      }
      if(found<0) break; // anneau incomplet : fermé implicitement par le test point-dans-polygone
      let w = pool.splice(found,1)[0];
      if(rev) w.reverse();
      ring = ring.concat(w.slice(1));
    }
    if(ring.length>=3) rings.push(ring);
  }
  return rings;
}

function communesFromOverpass(json){
  return (json.elements||[])
    .filter(e => e.type==='relation' && e.tags && e.tags.name && Array.isArray(e.members))
    .map(rel => {
      const ways = rel.members
        .filter(m => m.type==='way' && Array.isArray(m.geometry) && m.role!=='subarea')
        .map(m => m.geometry.filter(Boolean).map(g=>[g.lon, g.lat]));
      const rings = assembleRings(ways);
      let minLon=Infinity, minLat=Infinity, maxLon=-Infinity, maxLat=-Infinity;
      rings.forEach(r=>r.forEach(([x,y])=>{
        if(x<minLon) minLon=x; if(x>maxLon) maxLon=x;
        if(y<minLat) minLat=y; if(y>maxLat) maxLat=y;
      }));
      return {id:rel.id, name:rel.tags.name, rings, bbox:[minLon,minLat,maxLon,maxLat]};
    })
    .filter(c => c.rings.length);
}

// Règle pair-impair sur tous les anneaux (gère les enclaves / trous).
function pointInRings(lon, lat, rings){
  let inside = false;
  for(const ring of rings){
    for(let i=0, j=ring.length-1; i<ring.length; j=i++){
      const [xi,yi] = ring[i], [xj,yj] = ring[j];
      if((yi>lat) !== (yj>lat) && lon < (xj-xi)*(lat-yi)/(yj-yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function inCommune(c, p){
  const b = c.bbox;
  return p.lon>=b[0] && p.lon<=b[2] && p.lat>=b[1] && p.lat<=b[3] && pointInRings(p.lon, p.lat, c.rings);
}

// Renvoie une fonction point -> nom de commune (ou null). Teste d'abord la dernière commune trouvée.
function makeLocator(communes){
  let last = null;
  return p => {
    if(last && inCommune(last, p)) return last.name;
    for(const c of communes){
      if(c!==last && inCommune(c, p)){ last = c; return c.name; }
    }
    return null;
  };
}

// ---------- Détection des frontières ----------
// lookup(dist) -> nom | null | undefined (sync ou async). Échantillonne tous les `step` m,
// puis affine chaque changement par dichotomie jusqu'à `precision` m.
async function findCrossings(lookup, total, step, precision, hooks={}){
  const samples = [];
  for(let d=0; d<total; d+=step) samples.push(d);
  samples.push(total);

  const known = [];
  for(let i=0;i<samples.length;i++){
    const name = await lookup(samples[i]);
    if(name) known.push({dist:samples[i], name});
    if(hooks.onSample) await hooks.onSample(i, samples.length, samples[i], name);
  }

  const transitions = [];
  for(let i=1;i<known.length;i++){
    if(known[i].name !== known[i-1].name) transitions.push([known[i-1], known[i]]);
  }

  const crossings = [];
  for(let t=0;t<transitions.length;t++){
    if(hooks.onTransition) await hooks.onTransition(t, transitions.length);
    const [a,b] = transitions[t];
    const found = [];
    await refine(lookup, a.dist, a.name, b.dist, b.name, precision, found);
    found.forEach(c => { crossings.push(c); if(hooks.onCrossing) hooks.onCrossing(c); });
  }
  return crossings;
}

// Si un point intermédiaire tombe dans une 3e commune, les deux sous-intervalles sont affinés.
async function refine(lookup, loD, loName, hiD, hiName, precision, out){
  if(hiD - loD <= precision){
    out.push({dist:hiD, from:loName, to:hiName});
    return;
  }
  const mid = (loD+hiD)/2;
  const name = await lookup(mid);
  if(name === hiName){
    await refine(lookup, loD, loName, mid, hiName, precision, out);
  }else if(name === loName || !name){
    await refine(lookup, mid, loName, hiD, hiName, precision, out);
  }else{
    await refine(lookup, loD, loName, mid, name, precision, out);
    await refine(lookup, mid, name, hiD, hiName, precision, out);
  }
}

// Supprime les passages plus courts que `minStay` m (route qui longe une limite, etc.).
// Le premier et le dernier tronçon sont toujours conservés.
function filterShortRuns(crossings, total, minStay){
  if(!crossings.length) return [];
  let runs = [{name:crossings[0].from, start:0}];
  crossings.forEach(c => runs.push({name:c.to, start:c.dist}));
  runs.forEach((r,i) => { r.end = i+1<runs.length ? runs[i+1].start : total; });
  if(minStay>0){
    runs = runs.filter((r,i) => i===0 || i===runs.length-1 || r.end-r.start >= minStay);
  }
  const merged = [];
  for(const r of runs){
    if(merged.length && merged[merged.length-1].name===r.name) continue;
    merged.push(r);
  }
  return merged.slice(1).map((r,i) => ({dist:r.start, from:merged[i].name, to:r.name}));
}

// ---------- Noms des waypoints ----------
const COMPACT_MAX = 15; // limite des "course points" Garmin (champ FIT de 16 octets)

function abbreviate(name){
  return name
    .replace(/(^|[-\s])Saint(e?)(?=[-\s])/g, '$1St$2')
    .replace(/-sur-/g, '-s/')
    .replace(/-sous-/g, '-ss-');
}
function stripAccents(s){
  return s.normalize('NFD').replace(/[̀-ͯ]/g,'')
    .replace(/œ/g,'oe').replace(/Œ/g,'OE').replace(/æ/g,'ae').replace(/Æ/g,'AE')
    .replace(/[’‘]/g,"'").replace(/[^\x20-\x7E]/g,'');
}
function formatDist(m){
  return m>=1000 && m%100===0 ? `${m/1000}km` : `${m}m`;
}

// Raccourcit en retirant d'abord les derniers morceaux ("St-Sebastien-s/Loire" -> "St-Sebastien").
function shorten(name, max){
  if(name.length<=max) return name;
  const parts = name.split('-');
  while(parts.length>2 && parts.join('-').length>max) parts.pop();
  return parts.join('-').slice(0, max).replace(/[-\s]+$/,'');
}

// style : 'full' (lisible) ou 'compact' (ASCII, abrégé, ≤ 15 caractères)
function waypointName(kind, commune, style, alertDist){
  if(style==='compact'){
    const base = stripAccents(abbreviate(commune));
    if(kind!=='alert') return shorten(base, COMPACT_MAX);
    const prefix = formatDist(alertDist) + ' ';
    return prefix + shorten(base, COMPACT_MAX - prefix.length);
  }
  return kind==='alert' ? `⚠ ${alertDist}m avant : ${commune}` : `Entrée ${commune}`;
}

// ---------- Exports ----------
function toCSV(rows){
  const esc = v => { const s = String(v); return /[";\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
  const lines = [['km','type','commune','depuis','nom_gps','lat','lon'].join(';')];
  rows.forEach(w => lines.push([
    (w.dist/1000).toFixed(2).replace('.',','),
    w.isAlert ? 'alerte' : 'pancarte',
    w.to, w.from || '', w.name,
    w.lat.toFixed(6), w.lon.toFixed(6)
  ].map(esc).join(';')));
  return '﻿' + lines.join('\r\n') + '\r\n'; // BOM : accents corrects dans Excel
}

const PancarteCore = {
  haversine, cumulativeDistances, pointAtDistance, simplify,
  buildOverpassQuery, assembleRings, communesFromOverpass, pointInRings, makeLocator,
  findCrossings, filterShortRuns,
  abbreviate, stripAccents, shorten, waypointName, COMPACT_MAX, toCSV
};
if(typeof module !== 'undefined' && module.exports) module.exports = PancarteCore;
else root.PancarteCore = PancarteCore;
})(typeof self !== 'undefined' ? self : this);
