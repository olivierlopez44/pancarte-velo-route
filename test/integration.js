// Test d'intégration réseau (Overpass réel) : node test/integration.js
// Tracé synthétique Nantes → Saint-Herblain → Couëron, en ligne droite par tronçons.
const Core = require('../core.js');

const waypoints = [
  {lat:47.2184, lon:-1.5536},  // Nantes centre
  {lat:47.2122, lon:-1.6497},  // Saint-Herblain
  {lat:47.2156, lon:-1.7228},  // Couëron
];
const pts = [];
for(let k=1;k<waypoints.length;k++){
  const a = waypoints[k-1], b = waypoints[k];
  const n = Math.ceil(Core.haversine(a,b)/20);
  for(let i=(k===1?0:1); i<=n; i++) pts.push({lat:a.lat+(b.lat-a.lat)*i/n, lon:a.lon+(b.lon-a.lon)*i/n});
}

(async () => {
  const cum = Core.cumulativeDistances(pts);
  const total = cum[cum.length-1];
  const query = Core.buildOverpassQuery(pts, 8);
  let t = Date.now();
  let resp;
  for(let attempt=0; attempt<3; attempt++){
    if(attempt) await new Promise(r=>setTimeout(r, 5000));
    resp = await fetch('https://overpass-api.de/api/interpreter', {
      method:'POST', body:new URLSearchParams({data:query}),
      headers:{'User-Agent':'pancarte-velo-route-test'}
    });
    if(resp.ok) break;
    console.log('Overpass HTTP '+resp.status+', nouvelle tentative…');
  }
  if(!resp.ok) throw new Error('Overpass HTTP '+resp.status);
  const json = await resp.json();
  const communes = Core.communesFromOverpass(json);
  console.log(`${communes.length} communes en ${Date.now()-t} ms :`, communes.map(c=>c.name).join(', '));

  t = Date.now();
  const locate = Core.makeLocator(communes);
  const raw = await Core.findCrossings(d => locate(Core.pointAtDistance(pts, cum, d)), total, 10, 1);
  const kept = Core.filterShortRuns(raw, total, 50);
  console.log(`${(total/1000).toFixed(1)} km analysés en ${Date.now()-t} ms`);
  kept.forEach(c => console.log(`  km ${(c.dist/1000).toFixed(3)}  ${c.from} → ${c.to}  [${Core.waypointName('sign', c.to, 'compact')}]`));

  const names = kept.map(c => c.to);
  if(!names.includes('Saint-Herblain') || !names.includes('Couëron')) throw new Error('frontières attendues non trouvées');
  console.log('OK');
})().catch(e => { console.error('ÉCHEC :', e.message); process.exit(1); });
