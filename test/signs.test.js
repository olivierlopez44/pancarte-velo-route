// Tests hors ligne de la détection des panneaux d'agglomération : node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../core.js');

const M_PER_DEG_LAT = 111320, M_PER_DEG_LON = 111320*Math.cos(47*Math.PI/180);

// Tracé rectiligne vers l'est à 47°N, 2 km, un point tous les 10 m
function eastTrack(){
  const pts = Array.from({length:201}, (_,i) => ({lat:47, lon:i*10/M_PER_DEG_LON}));
  return {pts, cum:Core.cumulativeDistances(pts)};
}
// Panneau à `x` m le long du tracé, décalé de `y` m vers le nord (y<0 : à droite en roulant vers l'est)
const sign = (id, x, y, tags, wayBearing=null) => ({id, lat:47 + y/M_PER_DEG_LAT, lon:x/M_PER_DEG_LON, tags, wayBearing});
const resolve = (signs, places=[]) => {
  const {pts, cum} = eastTrack();
  return Core.resolveSigns(Core.findSignPasses(pts, cum, signs, 25), places, pts, cum);
};

test('normName : variantes d\'écriture d\'un même lieu', () => {
  assert.equal(Core.normName('Saint-Aignan-de-Grand-Lieu'), Core.normName('Saint-Aignan-Grandlieu'));
  assert.equal(Core.normName('St-Herblain'), Core.normName('Saint Herblain'));
  assert.equal(Core.normName('La Noë Nozou'), Core.normName('LA NOE NOZOU'));
  assert.notEqual(Core.normName('Bouaye'), Core.normName('Bouguenais'));
});

test('parseDirection : degrés, cardinaux, forward/backward', () => {
  assert.equal(Core.parseDirection('90'), 90);
  assert.equal(Core.parseDirection('NE'), 45);
  assert.equal(Core.parseDirection('forward'), 'forward');
  assert.equal(Core.parseDirection('both'), null);
  assert.equal(Core.parseDirection(undefined), null);
});

test('bearing / angleDiff', () => {
  assert.ok(Math.abs(Core.bearing({lat:47, lon:0}, {lat:47, lon:0.01}) - 90) < 0.1);
  assert.equal(Core.angleDiff(350, 10), 20);
  assert.equal(Core.angleDiff(0, 180), 180);
});

test('buildOverpassQuery avec panneaux : communes, panneaux, routes et lieux', () => {
  const q = Core.buildOverpassQuery([{lat:47.2, lon:-1.55}, {lat:47.21, lon:-1.6}], 8, {signs:true});
  assert.match(q, /rel\["boundary"="administrative"\]\["admin_level"="8"\]\(around:50,/);
  assert.match(q, /node\["traffic_sign"~"city_limit\|FR:EB10\|FR:EB20"\]\(around:50,.*->\.signs;/);
  assert.match(q, /way\(bn\.signs\)\["highway"\];out skel geom;/);
  assert.match(q, /node\["place"~.*\]\["name"\]\(around:2000,/);
});

test('parseOverpass : orientation de la route qui porte le panneau', () => {
  const d = Core.parseOverpass({elements:[
    {type:'node', id:10, lat:47, lon:0.001, tags:{traffic_sign:'city_limit', name:'A'}},
    {type:'node', id:11, lat:47.01, lon:0, tags:{place:'village', name:'A'}},
    {type:'way', id:1, nodes:[9,10,12], geometry:[{lat:47,lon:0},{lat:47,lon:0.001},{lat:47,lon:0.002}]},
  ]});
  assert.equal(d.signs.length, 1);
  assert.ok(Math.abs(d.signs[0].wayBearing - 90) < 0.1);
  assert.equal(d.places[0].key, Core.normName('A'));
});

test('findSignPasses : distance au tracé, côté de la route, position le long du tracé', () => {
  const {pts, cum} = eastTrack();
  const passes = Core.findSignPasses(pts, cum, [
    sign(1, 500, -8, {traffic_sign:'city_limit'}),   // à droite
    sign(2, 800, 8, {traffic_sign:'city_limit'}),    // à gauche
    sign(3, 1200, 0, {traffic_sign:'city_limit'}),   // sur la route
    sign(4, 1500, 80, {traffic_sign:'city_limit'}),  // trop loin
  ], 25);
  assert.deepEqual(passes.map(p => p.sign.id), [1,2,3]);
  assert.deepEqual(passes.map(p => p.side), [1,-1,0]);
  assert.ok(Math.abs(passes[0].dist - 500) < 2, passes[0].dist);
  assert.ok(Math.abs(passes[0].heading - 90) < 1);
});

test('findSignPasses : un panneau croisé deux fois (aller-retour) donne deux passages', () => {
  const a = eastTrack();
  const pts = [...a.pts, ...a.pts.slice(0,-1).reverse()];
  const cum = Core.cumulativeDistances(pts);
  const passes = Core.findSignPasses(pts, cum, [sign(1, 500, -8, {traffic_sign:'city_limit'})], 25);
  assert.equal(passes.length, 2);
  assert.deepEqual(passes.map(p => p.side), [1,-1]);
});

test('resolveSigns : orientation en degrés (face tournée vers l\'ouest = entrée en roulant vers l\'est)', () => {
  const r = resolve([
    sign(1, 400, -6, {traffic_sign:'city_limit', name:'A', direction:'270'}),
    sign(2, 900, -6, {traffic_sign:'city_limit', name:'A', direction:'W'}),
    sign(3, 1400, -6, {traffic_sign:'city_limit', name:'B', direction:'90'}),  // face entrée vers l'est : sortie pour nous
    sign(4, 1700, -6, {traffic_sign:'city_limit', name:'C', direction:'0'}),   // perpendiculaire : route transversale
  ]);
  assert.deepEqual(r.map(s => [s.name, s.entry, s.method]), [
    ['A', true, 'orientation'], ['A', true, 'orientation'], ['B', false, 'orientation'],
  ]);
});

test('resolveSigns : forward/backward relatif à la route, name:forward/backward', () => {
  const r = resolve([
    sign(1, 300, 0, {traffic_sign:'city_limit', name:'A', 'traffic_sign:direction':'forward'}, 90),   // route dessinée vers l'est
    sign(2, 600, 0, {traffic_sign:'city_limit', name:'B', 'traffic_sign:direction':'forward'}, 270),  // route dessinée vers l'ouest
    sign(3, 900, 0, {traffic_sign:'city_limit', 'name:forward':'X', 'name:backward':'Y'}, 270),
    sign(4, 1200, 0, {traffic_sign:'city_limit', name:'Z', direction:'forward'}, 0),                  // route perpendiculaire
  ]);
  assert.deepEqual(r.map(s => [s.name, s.entry]), [['A', true], ['B', false], ['Y', true]]);
});

test('resolveSigns : panneaux simple face selon le côté de la route', () => {
  const r = resolve([
    sign(1, 300, -7, {traffic_sign:'city_limit', name:'A', city_limit:'begin'}),  // à droite : entrée
    sign(2, 310, 7, {traffic_sign:'city_limit', name:'A', city_limit:'end'}),     // à gauche : pour l'autre sens
    sign(3, 1500, -7, {traffic_sign:'FR:EB20', name:'A'}),                       // à droite : sortie
  ]);
  assert.deepEqual(r.map(s => [s.sign.id, s.entry, s.method]), [[1, true, 'côté'], [3, false, 'côté']]);
});

test('resolveSigns : position du centre, puis alternance en dernier recours', () => {
  const place = {name:'Bourg', key:Core.normName('Bourg'), lat:47, lon:1000/M_PER_DEG_LON};
  const r = resolve([
    sign(1, 600, 0, {traffic_sign:'city_limit', name:'Bourg', 'traffic_sign:direction':'both'}),
    sign(2, 1400, 0, {traffic_sign:'city_limit', name:'Bourg'}),
    sign(3, 1600, 0, {traffic_sign:'city_limit', name:'Hameau'}),
    sign(4, 1800, 0, {traffic_sign:'city_limit', name:'Hameau'}),
  ], [place]);
  assert.deepEqual(r.map(s => [s.name, s.entry, s.method]), [
    ['Bourg', true, 'centre'], ['Bourg', false, 'centre'], ['Hameau', true, 'alternance'], ['Hameau', false, 'alternance'],
  ]);
});

test('resolveSigns : nom tiré du code FR:EB10[...] ou de la commune', () => {
  const r = Core.resolveSigns(
    Core.findSignPasses(eastTrack().pts, eastTrack().cum, [
      sign(1, 300, 0, {traffic_sign:'FR:EB10[Saint-Martin-des-Tilleuls]'}),
      sign(2, 900, 0, {traffic_sign:'city_limit'}),
    ], 25), [], eastTrack().pts, eastTrack().cum, () => 'Commune');
  assert.deepEqual(r.map(s => s.name), ['Saint-Martin-des-Tilleuls', 'Commune']);
});

test('mergeWaypoints : la pancarte remplace la limite de sa commune, doublons écartés', () => {
  const crossings = [{dist:1000, from:'A', to:'B'}, {dist:5000, from:'B', to:'C'}];
  const s = (dist, name, entry, method='centre') => ({dist, name, entry, method, lat:0, lon:0, sign:{id:dist}});
  const w = Core.mergeWaypoints(crossings, [
    s(1800, 'B', true), s(1830, 'B', true),        // doublon
    s(2500, 'Hameau', true), s(2900, 'Hameau', false),
    s(4000, 'B', false),
    s(4500, 'B', true, 'alternance'),              // réentrée après une sortie : gardée
  ], 8000, true);
  assert.deepEqual(w.map(x => [x.kind, x.label, x.dist, x.certain]), [
    ['sign','B',1800,true], ['sign','Hameau',2500,true], ['sign','B',4500,false], ['limit','C',5000,undefined],
  ]);
  assert.equal(Core.mergeWaypoints(crossings, [], 8000, false).length, 0);
});

// Données réelles figées (itinéraire OSRM + réponse Overpass, sud de Nantes) : non-régression
test('parcours réel Bouguenais → Les Sorinières', async () => {
  const dir = path.join(__dirname, 'fixtures');
  const gpx = fs.readFileSync(path.join(dir, 'sud-loire.gpx'), 'utf8');
  const pts = [...gpx.matchAll(/lat="([-\d.]+)" lon="([-\d.]+)"/g)].map(m => ({lat:+m[1], lon:+m[2]}));
  const cum = Core.cumulativeDistances(pts), total = cum[cum.length-1];
  const data = Core.parseOverpass(JSON.parse(fs.readFileSync(path.join(dir, 'sud-loire.overpass.json'), 'utf8')));
  const locate = Core.makeLocator(data.communes);
  const raw = await Core.findCrossings(d => locate(Core.pointAtDistance(pts, cum, d)), total, 10, 1);
  const crossings = Core.filterShortRuns(raw, total, 150);
  const signs = Core.resolveSigns(Core.findSignPasses(pts, cum, data.signs, 25), data.places, pts, cum, locate);
  const w = Core.mergeWaypoints(crossings, signs, total, true);
  assert.deepEqual(w.map(x => `${x.kind} ${x.label} ${(x.dist/1000).toFixed(1)}`), [
    'sign Bouaye 4.2',
    'sign La Noë Nozou 11.3',
    'sign Saint-Aignan-de-Grand-Lieu 12.5',
    'sign Le Champ de Foire 14.0',
    'sign Pont-Saint-Martin 16.3',
    'sign Les Sorinières 21.8',
  ]);
});
