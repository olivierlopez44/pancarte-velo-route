// Tests unitaires hors ligne : node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');

test('haversine : ~111 km par degré de latitude', () => {
  const d = Core.haversine({lat:47, lon:-1.5}, {lat:48, lon:-1.5});
  assert.ok(Math.abs(d - 111195) < 50, d);
});

test('pointAtDistance interpole le long du tracé', () => {
  const pts = [{lat:47, lon:0}, {lat:47.01, lon:0}, {lat:47.02, lon:0}];
  const cum = Core.cumulativeDistances(pts);
  const p = Core.pointAtDistance(pts, cum, cum[2]/4);
  assert.ok(Math.abs(p.lat - 47.005) < 1e-6);
  assert.deepEqual(Core.pointAtDistance(pts, cum, -5), pts[0]);
  assert.deepEqual(Core.pointAtDistance(pts, cum, 1e9), pts[2]);
});

test('simplify réduit une ligne droite à ses extrémités', () => {
  const pts = Array.from({length:100}, (_,i) => ({lat:47 + i*1e-4, lon:-1.5}));
  assert.equal(Core.simplify(pts, 5).length, 2);
});

test('buildOverpassQuery produit une requête around sur le tracé', () => {
  const pts = [{lat:47.2, lon:-1.55}, {lat:47.21, lon:-1.6}];
  const q = Core.buildOverpassQuery(pts, 8);
  assert.match(q, /admin_level"="8"\]\(around:50,47\.20000,-1\.55000,47\.21000,-1\.60000\);out geom;$/);
});

test('assembleRings recolle des chemins dans le désordre et inversés', () => {
  const ways = [
    [[0,0],[1,0]],
    [[1,1],[1,0]],        // inversé
    [[0,1],[0,0]],
    [[1,1],[0,1]],
  ];
  const rings = Core.assembleRings(ways);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 5);
  assert.deepEqual(rings[0][0], rings[0][4]);
});

test('pointInRings gère les enclaves (anneau intérieur)', () => {
  const outer = [[0,0],[10,0],[10,10],[0,10],[0,0]];
  const hole = [[4,4],[6,4],[6,6],[4,6],[4,4]];
  assert.equal(Core.pointInRings(2, 2, [outer, hole]), true);
  assert.equal(Core.pointInRings(5, 5, [outer, hole]), false);
  assert.equal(Core.pointInRings(12, 5, [outer, hole]), false);
});

test('communesFromOverpass + makeLocator', () => {
  const sq = (x0, name, id) => ({
    type:'relation', id, tags:{name},
    members:[
      {type:'way', role:'outer', geometry:[{lon:x0,lat:0},{lon:x0+1,lat:0},{lon:x0+1,lat:1}]},
      {type:'way', role:'outer', geometry:[{lon:x0+1,lat:1},{lon:x0,lat:1},{lon:x0,lat:0}]},
      {type:'node', role:'admin_centre', lat:0.5, lon:x0+0.5},
    ]
  });
  const communes = Core.communesFromOverpass({elements:[sq(0,'A',1), sq(1,'B',2)]});
  assert.equal(communes.length, 2);
  const locate = Core.makeLocator(communes);
  assert.equal(locate({lon:0.5, lat:0.5}), 'A');
  assert.equal(locate({lon:1.5, lat:0.5}), 'B');
  assert.equal(locate({lon:5, lat:0.5}), null);
});

// Communes définies par intervalles de distance le long du tracé
const byDist = zones => d => (zones.find(z => d >= z[0] && d < z[1]) || [0,0,null])[2];

test('findCrossings localise les frontières et une commune intermédiaire courte', async () => {
  const lookup = byDist([[0,1000,'A'],[1000,1030,'B'],[1030,1e9,'C']]);
  const c = await Core.findCrossings(lookup, 3000, 400, 1);
  assert.deepEqual(c.map(x => [x.from, x.to]), [['A','B'],['B','C']]);
  assert.ok(Math.abs(c[0].dist - 1000) <= 1, c[0].dist);
  assert.ok(Math.abs(c[1].dist - 1030) <= 1, c[1].dist);
});

test('findCrossings ignore les échantillons inconnus (erreur réseau)', async () => {
  const base = byDist([[0,1000,'A'],[1000,1e9,'B']]);
  const lookup = d => (d === 800 ? undefined : base(d));
  const c = await Core.findCrossings(lookup, 2000, 400, 5);
  assert.equal(c.length, 1);
  assert.ok(Math.abs(c[0].dist - 1000) <= 5);
});

test('findCrossings fonctionne avec un lookup asynchrone', async () => {
  const base = byDist([[0,500,'A'],[500,1e9,'B']]);
  const c = await Core.findCrossings(async d => base(d), 1000, 100, 1);
  assert.equal(c.length, 1);
});

test('filterShortRuns supprime les incursions courtes', () => {
  const crossings = [
    {dist:1000, from:'A', to:'B'},
    {dist:1030, from:'B', to:'C'},   // B : 30 m → supprimé
    {dist:2000, from:'C', to:'D'},
    {dist:2020, from:'D', to:'C'},   // D : 20 m, aller-retour → disparaît
    {dist:3000, from:'C', to:'E'},
  ];
  const r = Core.filterShortRuns(crossings, 3010, 50);
  assert.deepEqual(r.map(x => [x.dist, x.from, x.to]), [[1030,'A','C'], [3000,'C','E']]);
  // le dernier tronçon (10 m) est conservé ; minStay 0 garde tout
  assert.equal(Core.filterShortRuns(crossings, 3010, 0).length, 5);
});

test('waypointName : noms complets et compacts GPS', () => {
  assert.equal(Core.waypointName('sign', 'Saint-Herblain', 'full'), 'Entrée Saint-Herblain');
  assert.equal(Core.waypointName('alert', 'Couëron', 'full', 500), '⚠ 500m avant : Couëron');

  assert.equal(Core.waypointName('sign', 'Saint-Herblain', 'compact'), 'St-Herblain');
  assert.equal(Core.waypointName('sign', 'Saint-Sébastien-sur-Loire', 'compact'), 'St-Sebastien');
  assert.equal(Core.waypointName('sign', 'Sainte-Luce-sur-Loire', 'compact'), 'Ste-Luce');
  assert.equal(Core.waypointName('sign', 'Couëron', 'compact'), 'Coueron');
  assert.equal(Core.waypointName('alert', 'Couëron', 'compact', 500), '500m Coueron');
  assert.equal(Core.waypointName('alert', 'Couëron', 'compact', 1000), '1km Coueron');

  for(const n of ['Saint-Rémy-en-Bouzemont-Saint-Genest-et-Isson', 'Œuilly', 'Villeneuve-d’Ascq', 'Aix-en-Provence']){
    for(const kind of ['sign','alert']){
      const s = Core.waypointName(kind, n, 'compact', 500);
      assert.ok(s.length <= Core.COMPACT_MAX, `${s} (${s.length})`);
      assert.match(s, /^[\x20-\x7E]+$/, s);
    }
  }
});

test('toCSV : séparateur ; , BOM et échappement', () => {
  const csv = Core.toCSV([{dist:1234, isAlert:false, to:'Saint-Herblain', from:'Nantes', name:'Entrée "X"', lat:47.2, lon:-1.6}]);
  assert.ok(csv.startsWith('﻿km;type;commune'));
  assert.match(csv, /1,23;pancarte;Saint-Herblain;Nantes;"Entrée ""X""";47\.200000;-1\.600000/);
});
