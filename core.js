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
// Avec opts.signs : aussi les panneaux d'agglomération proches du tracé, les routes qui les portent
// (pour l'orientation forward/backward) et les lieux nommés (pour savoir de quel côté est le centre).
function buildOverpassQuery(pts, adminLevel=8, opts={}){
  const maxPoints = opts.maxPoints || 1500;
  let tol = 25, s = simplify(pts, tol);
  while(s.length > maxPoints){ tol *= 2; s = simplify(pts, tol); }
  const radius = Math.max(50, Math.ceil(tol*2));
  const coords = s.map(p=>p.lat.toFixed(5)+','+p.lon.toFixed(5)).join(',');
  const communes = `rel["boundary"="administrative"]["admin_level"="${adminLevel}"](around:${radius},${coords})`;
  if(!opts.signs) return `[out:json][timeout:180];${communes};out geom;`;
  const signRadius = Math.ceil(tol + (opts.maxSignDist || 25));
  return `[out:json][timeout:180];` +
    `${communes};out geom;` +
    `node["traffic_sign"~"city_limit|FR:EB10|FR:EB20"](around:${signRadius},${coords})->.signs;.signs out;` +
    `way(bn.signs)["highway"];out skel geom;` +
    `node["place"~"^(city|town|village|hamlet|suburb|quarter|neighbourhood|isolated_dwelling|locality)$"]["name"](around:${PLACE_RADIUS},${coords});out;`;
}
const PLACE_RADIUS = 2000;

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

// ---------- Panneaux d'agglomération (OSM) ----------
const CARDINAL = {N:0,NNE:22.5,NE:45,ENE:67.5,E:90,ESE:112.5,SE:135,SSE:157.5,S:180,SSW:202.5,SW:225,WSW:247.5,W:270,WNW:292.5,NW:315,NNW:337.5};

function bearing(a,b){
  const p1 = toRad(a.lat), p2 = toRad(b.lat), dl = toRad(b.lon-a.lon);
  const y = Math.sin(dl)*Math.cos(p2), x = Math.cos(p1)*Math.sin(p2) - Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
  return (Math.atan2(y,x)*180/Math.PI + 360) % 360;
}
function angleDiff(a,b){
  const d = Math.abs(((a-b)%360 + 360) % 360);
  return d>180 ? 360-d : d;
}
// Degrés, point cardinal, ou 'forward'/'backward' (relatif à la route qui porte le nœud).
function parseDirection(v){
  if(v==null) return null;
  v = String(v).trim();
  if(/^\d+(\.\d+)?$/.test(v)) return parseFloat(v) % 360;
  const c = CARDINAL[v.toUpperCase()];
  if(c!=null) return c;
  return v==='forward' || v==='backward' ? v : null;
}
// Clé de comparaison de noms, tolérante aux variantes d'écriture :
// "St-Aignan-de-Grand-Lieu" == "Saint-Aignan-Grandlieu" == "saint aignan grand lieu"
const STOP_WORDS = new Set(['de','du','des','la','le','les','l','d','sur','sous','en','et','a','au','aux']);
function normName(s){
  return stripAccents(String(s||'')).toLowerCase()
    .replace(/\bst\b/g,'saint').replace(/\bste\b/g,'sainte')
    .split(/[^a-z0-9]+/).filter(w => w && !STOP_WORDS.has(w)).join('');
}
function signName(tags){
  if(tags.name) return tags.name;
  const m = /\[([^\]]+)\]/.exec(tags.traffic_sign || '');
  return m ? m[1] : null;
}

// Réponse Overpass -> communes, panneaux (avec l'orientation de la route qui les porte) et lieux nommés.
function parseOverpass(json){
  const els = json.elements || [];
  const wayBearing = new Map();
  els.filter(e => e.type==='way' && Array.isArray(e.nodes) && Array.isArray(e.geometry)).forEach(w => {
    w.nodes.forEach((id,i) => {
      const a = w.geometry[Math.max(0,i-1)], b = w.geometry[Math.min(w.geometry.length-1,i+1)];
      if(a && b && (a.lat!==b.lat || a.lon!==b.lon)) wayBearing.set(id, bearing(a,b));
    });
  });
  return {
    communes: communesFromOverpass(json),
    signs: els.filter(e => e.type==='node' && e.tags && e.tags.traffic_sign)
      .map(e => ({id:e.id, lat:e.lat, lon:e.lon, tags:e.tags, wayBearing: wayBearing.has(e.id) ? wayBearing.get(e.id) : null})),
    places: els.filter(e => e.type==='node' && e.tags && e.tags.place && e.tags.name)
      .map(e => ({name:e.tags.name, key:normName(e.tags.name), lat:e.lat, lon:e.lon})),
  };
}

// Chaque passage du tracé à moins de `maxDist` m d'un panneau (un panneau peut être croisé
// plusieurs fois sur un aller-retour). side : 1 = panneau à droite, -1 = à gauche, 0 = sur la route.
function findSignPasses(pts, cum, signs, maxDist=25){
  const passes = [];
  const dLat = maxDist/111320;
  for(const s of signs){
    const kx = R*Math.cos(toRad(s.lat))*Math.PI/180, ky = R*Math.PI/180;
    const dLon = dLat*ky/kx;
    const cand = [];
    for(let i=1;i<pts.length;i++){
      const a = pts[i-1], b = pts[i];
      if(Math.min(a.lat,b.lat) > s.lat+dLat || Math.max(a.lat,b.lat) < s.lat-dLat ||
         Math.min(a.lon,b.lon) > s.lon+dLon || Math.max(a.lon,b.lon) < s.lon-dLon) continue;
      // Repère local centré sur le panneau (mètres)
      const ax = (a.lon-s.lon)*kx, ay = (a.lat-s.lat)*ky, bx = (b.lon-s.lon)*kx, by = (b.lat-s.lat)*ky;
      const dx = bx-ax, dy = by-ay, len2 = dx*dx+dy*dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax*dx+ay*dy)/len2)) : 0;
      const px = ax+t*dx, py = ay+t*dy, offset = Math.hypot(px,py);
      if(offset > maxDist) continue;
      const cross = dx*(-py) - dy*(-px); // < 0 : panneau à droite du sens de marche
      cand.push({dist: cum[i-1] + t*(cum[i]-cum[i-1]), offset, side: offset<3 ? 0 : (cross<0 ? 1 : -1)});
    }
    cand.sort((p,q) => p.dist-q.dist);
    let cluster = [];
    const flush = () => {
      if(!cluster.length) return;
      passes.push({sign:s, ...cluster.reduce((m,c) => c.offset<m.offset ? c : m)});
      cluster = [];
    };
    for(const c of cand){
      if(cluster.length && c.dist - cluster[cluster.length-1].dist > 100) flush();
      cluster.push(c);
    }
    flush();
  }
  passes.forEach(p => {
    p.heading = bearing(pointAtDistance(pts, cum, p.dist-15), pointAtDistance(pts, cum, p.dist+15));
    const pt = pointAtDistance(pts, cum, p.dist);
    p.lat = pt.lat; p.lon = pt.lon;
  });
  return passes.sort((a,b) => a.dist-b.dist);
}

// Détermine pour chaque passage si c'est une entrée (entry=true) ou une sortie d'agglomération.
// method : 'orientation' (tag direction), 'côté' (panneau simple face à droite de la route),
// 'centre' (on se rapproche du lieu du même nom), 'alternance' (déduit des autres panneaux : incertain).
// Les panneaux d'une route transversale ou tournés vers l'autre sens sont écartés.
function resolveSigns(passes, places, pts, cum, communeAt){
  const out = [];
  for(const p of passes){
    const t = p.sign.tags, code = t.traffic_sign || '';
    let name = signName(t);
    const onlyEB10 = /EB10/.test(code) && !/EB20/.test(code), onlyEB20 = /EB20/.test(code) && !/EB10/.test(code);
    const describesEnd = t.city_limit==='end' || onlyEB20;
    const singleSided = t.city_limit==='begin' || t.city_limit==='end' || onlyEB10 || onlyEB20;
    const dir = parseDirection(t['traffic_sign:direction'] ?? t.direction);
    const alongWay = p.sign.wayBearing!=null ? angleDiff(p.heading, p.sign.wayBearing) < 90 : null;

    if(p.sign.wayBearing!=null){
      const d = angleDiff(p.heading, p.sign.wayBearing);
      if(d>35 && d<145) continue; // panneau sur une route qui croise le tracé
    }

    let seesFront = null, method = null, entry = null;
    if(typeof dir === 'number'){
      // direction = sens vers lequel le panneau est tourné ; on voit sa face en roulant à l'opposé
      const d = angleDiff(p.heading, (dir+180)%360);
      if(d>50 && d<130) continue;
      seesFront = d<=50; method = 'orientation';
    }else if(dir && alongWay!==null){
      seesFront = (dir==='forward') === alongWay; method = 'orientation';
    }else if(singleSided && p.sign.wayBearing==null && p.side!==0){
      if(p.side===-1) continue; // panneau simple face à gauche : destiné à l'autre sens
      seesFront = true; method = 'côté';
    }
    if(seesFront!==null) entry = describesEnd ? !seesFront : seesFront;

    // Panneau de limite entre deux communes : name:forward / name:backward
    if(alongWay!==null && (t['name:forward'] || t['name:backward'])){
      const n = alongWay ? t['name:forward'] : t['name:backward'];
      if(n){ name = n; entry = true; method = 'orientation'; }
    }
    if(!name && communeAt) name = communeAt(p);
    if(!name) continue;

    if(entry===null){
      const keys = [name, t.alt_name, t.official_name].filter(Boolean).map(normName);
      let best = null, bd = 5000;
      for(const pl of places){
        if(!keys.includes(pl.key)) continue;
        const d = haversine(p, pl);
        if(d<bd){ bd = d; best = pl; }
      }
      // Se rapproche-t-on du centre après le panneau ? (fenêtre élargie si la route le contourne)
      for(const w of best ? [150, 400] : []){
        const before = haversine(pointAtDistance(pts, cum, p.dist-w), best);
        const after = haversine(pointAtDistance(pts, cum, p.dist+w), best);
        if(Math.abs(after-before) > 20){ entry = after < before; method = 'centre'; break; }
      }
    }
    out.push({...p, name, entry, method});
  }

  // Alternance entrée/sortie entre panneaux du même nom pour les cas restants
  const groups = new Map();
  out.forEach(s => { const k = normName(s.name); if(!groups.has(k)) groups.set(k, []); groups.get(k).push(s); });
  for(const g of groups.values()){
    for(let i=0;i<g.length;i++){
      if(g[i].entry!==null) continue;
      let entry;
      if(i>0) entry = !g[i-1].entry;
      else{
        const k = g.findIndex(s => s.entry!==null);
        entry = k<0 ? true : ((k-i)%2===0 ? g[k].entry : !g[k].entry);
      }
      g[i].entry = entry; g[i].method = 'alternance';
    }
  }
  return out;
}

const REENTRY_MIN = 1500; // m
// Combine pancartes réelles (entrées) et limites de commune. Une limite est gardée comme
// estimation seulement si aucune pancarte du même nom n'est trouvée dans ce tronçon de commune.
function mergeWaypoints(crossings, signs, total, keepLimits=true){
  const entries = [];
  const inside = new Map(); // nom -> distance de la dernière entrée sans sortie depuis
  [...signs].sort((a,b) => a.dist-b.dist).forEach(s => {
    const key = normName(s.name);
    if(!s.entry){ inside.delete(key); return; }
    // Doublon, ou nouvelle "entrée" peu après une entrée sans sortie entre les deux
    if(inside.has(key) && s.dist - inside.get(key) < REENTRY_MIN) return;
    inside.set(key, s.dist);
    entries.push({kind:'sign', key, dist:s.dist, lat:s.lat, lon:s.lon, label:s.name,
                  method:s.method, certain:s.method!=='alternance', osmId:s.sign.id});
  });
  const out = [...entries];
  if(keepLimits){
    crossings.forEach((c,i) => {
      const end = i+1<crossings.length ? crossings[i+1].dist : total;
      const key = normName(c.to);
      if(entries.some(e => e.key===key && e.dist >= c.dist-100 && e.dist < end)) return;
      out.push({kind:'limit', dist:c.dist, label:c.to, from:c.from});
    });
  }
  return out.sort((a,b) => a.dist-b.dist);
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
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g,'')
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

// kind : 'sign' (pancarte OSM), 'limit' (limite de commune, estimation) ou 'alert'.
// style : 'full' (lisible) ou 'compact' (ASCII, abrégé, ≤ 15 caractères)
function waypointName(kind, label, style, alertDist){
  if(style==='compact'){
    const base = stripAccents(abbreviate(label));
    if(kind==='sign') return shorten(base, COMPACT_MAX);
    const prefix = kind==='alert' ? formatDist(alertDist) + ' ' : '~';
    return prefix + shorten(base, COMPACT_MAX - prefix.length);
  }
  if(kind==='alert') return `⚠ ${alertDist}m avant : ${label}`;
  return kind==='limit' ? `Limite ${label}` : `Entrée ${label}`;
}

// ---------- Exports ----------
function toCSV(rows){
  const esc = v => { const s = String(v); return /[";\r\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
  const types = {sign:'pancarte', limit:'limite', alert:'alerte'};
  const lines = [['km','type','lieu','nom_gps','detail','lat','lon'].join(';')];
  rows.forEach(w => lines.push([
    (w.dist/1000).toFixed(2).replace('.',','),
    types[w.kind] || w.kind,
    w.label, w.name, w.desc || '',
    w.lat.toFixed(6), w.lon.toFixed(6)
  ].map(esc).join(';')));
  return '\uFEFF' + lines.join('\r\n') + '\r\n'; // BOM : accents corrects dans Excel
}

const PancarteCore = {
  haversine, cumulativeDistances, pointAtDistance, simplify,
  buildOverpassQuery, assembleRings, communesFromOverpass, pointInRings, makeLocator,
  findCrossings, filterShortRuns,
  bearing, angleDiff, parseDirection, normName, parseOverpass, findSignPasses, resolveSigns, mergeWaypoints,
  abbreviate, stripAccents, shorten, waypointName, COMPACT_MAX, toCSV
};
if(typeof module !== 'undefined' && module.exports) module.exports = PancarteCore;
else root.PancarteCore = PancarteCore;
})(typeof self !== 'undefined' ? self : this);
