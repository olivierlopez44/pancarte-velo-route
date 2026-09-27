// Test de bout en bout dans un vrai navigateur (Chrome/Edge headless, via le protocole DevTools).
// Charge test/fixtures/nantes-coueron.gpx, lance l'analyse rapide (Overpass réel) et vérifie le GPX produit.
// Usage : node test/e2e.js [dossier-captures]
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'nantes-coueron.gpx');
const SHOTS = process.argv[2];
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const assert = (cond, msg) => { if(!cond) throw new Error(msg); };

function serve(){
  const types = {'.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.gpx':'application/gpx+xml'};
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if(!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()){ res.writeHead(404); return res.end(); }
    res.writeHead(200, {'Content-Type': types[path.extname(file)] || 'application/octet-stream'});
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

async function cdp(wsUrl){
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map(); const listeners = [];
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if(msg.id && pending.has(msg.id)){
      const {resolve, reject} = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }else listeners.forEach(fn => fn(msg));
  };
  const send = (method, params={}) => new Promise((resolve, reject) => {
    pending.set(++id, {resolve, reject});
    ws.send(JSON.stringify({id, method, params}));
  });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', {expression:expr, awaitPromise:true, returnByValue:true});
    if(r.exceptionDetails) throw new Error('evaluate: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  return {send, evaluate, on: fn => listeners.push(fn), close: () => ws.close()};
}

(async () => {
  const exe = BROWSERS.find(p => fs.existsSync(p));
  assert(exe, 'aucun Chrome/Edge trouvé');
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pancarte-e2e-'));
  const port = 9300 + Math.floor(Math.random()*500);
  const browser = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--window-size=900,1400', 'about:blank'], {stdio:'ignore'});
  let client;
  try{
    let targets;
    for(let i=0;i<50;i++){
      try{ targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if(targets.some(t=>t.type==='page')) break; }catch(e){}
      await sleep(200);
    }
    client = await cdp(targets.find(t => t.type==='page').webSocketDebuggerUrl);
    const {send, evaluate} = client;
    const errors = [];
    client.on(m => {
      if(m.method==='Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if(m.method==='Runtime.consoleAPICalled' && m.params.type==='error') errors.push(m.params.args.map(a=>a.value ?? a.description).join(' '));
    });
    await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');
    await send('Page.navigate', {url});
    for(let i=0;i<100 && !(await evaluate('document.readyState==="complete" && !!window.PancarteCore').catch(()=>false)); i++) await sleep(100);
    await evaluate(`localStorage.clear()`);

    // Chargement du fichier
    const {root} = await send('DOM.getDocument');
    const {nodeId} = await send('DOM.querySelector', {nodeId:root.nodeId, selector:'#fileInput'});
    await send('DOM.setFileInputFiles', {nodeId, files:[FIXTURE]});
    for(let i=0;i<50 && !(await evaluate('trkpts.length>0')); i++) await sleep(100);
    console.log('Chargé :', await evaluate('dzText.textContent'));
    console.log(await evaluate('estimate.textContent'));

    // Analyse rapide
    const t0 = Date.now();
    await evaluate(`document.getElementById('launchBtn').click()`);
    for(let i=0;i<1800 && (await evaluate('running')); i++) await sleep(100);
    console.log(`Analyse : ${Date.now()-t0} ms — ${await evaluate('progressLabel.textContent')}`);
    console.log('Journal :\n  ' + (await evaluate(`[...logEl.children].map(e=>e.textContent).join('\\n  ')`)));
    const signs = await evaluate(`foundWaypoints.map(w=>w.name)`);
    const alerts = await evaluate(`alertWaypoints.map(w=>w.name)`);
    console.log('Pancartes :', signs, '\nAlertes :', alerts);
    assert(signs.includes('Entrée Saint-Herblain') && signs.includes('Entrée Couëron'), 'pancartes attendues absentes');
    assert(alerts.length === signs.length, 'une alerte par pancarte attendue');
    if(SHOTS){
      await sleep(600); // fin des transitions CSS
      fs.mkdirSync(SHOTS, {recursive:true});
      const {data} = await send('Page.captureScreenshot', {captureBeyondViewport:true});
      fs.writeFileSync(path.join(SHOTS, 'resultat.png'), Buffer.from(data, 'base64'));
    }

    // GPX produit : valide, contenu d'origine conservé, waypoints avant <trk>
    const check = await evaluate(`(() => {
      const d = new DOMParser().parseFromString(finalGpxText, 'application/xml');
      const r = d.documentElement, kids = [...r.children].map(c=>c.localName);
      return {
        parseError: d.getElementsByTagName('parsererror').length,
        ns: r.namespaceURI,
        order: kids.join(','),
        times: d.getElementsByTagName('time').length,
        trkpts: d.getElementsByTagName('trkpt').length,
        origWpt: [...d.getElementsByTagName('wpt')].some(w => w.getElementsByTagName('name')[0]?.textContent === 'Départ'),
        ext: d.getElementsByTagName('extensions').length,
        wpts: [...d.getElementsByTagName('wpt')].map(w => w.getElementsByTagName('name')[0].textContent + ' | ' + (w.getElementsByTagName('desc')[0]?.textContent||'')),
      };
    })()`);
    console.log('GPX :', JSON.stringify(check, null, 2));
    const src = fs.readFileSync(FIXTURE, 'utf8');
    assert(check.parseError === 0, 'GPX produit invalide');
    assert(check.ns === 'http://www.topografix.com/GPX/1/1', 'namespace perdu');
    assert(check.times === (src.match(/<time>/g)||[]).length, 'horodatages perdus');
    assert(check.trkpts === (src.match(/<trkpt/g)||[]).length, 'points perdus');
    assert(check.origWpt, 'waypoint d\'origine perdu');
    assert(check.ext >= 1, 'extensions perdues');
    assert(/^metadata,(wpt,)+trk/.test(check.order), 'ordre GPX incorrect : ' + check.order);

    // Style compact + alerte modifiée sans relancer l'analyse
    await evaluate(`styleSelect.value='compact'; styleSelect.dispatchEvent(new Event('change'));
                    alertInput.value='1000'; alertInput.dispatchEvent(new Event('input'));`);
    const compact = await evaluate(`[...foundWaypoints, ...alertWaypoints].map(w=>w.name)`);
    console.log('Compact :', compact);
    assert(compact.includes('St-Herblain') && compact.includes('1km Coueron'), 'noms compacts inattendus');
    assert(compact.every(n => n.length <= 15 && /^[\x20-\x7E]+$/.test(n)), 'nom compact trop long ou non ASCII');
    assert(/<name>1km Coueron<\/name>/.test(await evaluate('finalGpxText')), 'GPX non régénéré');

    assert(!(await evaluate('launchBtn.disabled')), 'bouton Lancer resté désactivé');
    const csv = await evaluate(`Core.toCSV([...foundWaypoints, ...alertWaypoints].sort((a,b)=>a.dist-b.dist))`);
    console.log('CSV :\n' + csv.replace('\uFEFF',''));

    assert(errors.length === 0, 'erreurs JavaScript : ' + errors.join(' / '));
    console.log('\nE2E OK');
  }finally{
    if(client) client.close();
    browser.kill();
    server.close();
    await sleep(500);
    try{ fs.rmSync(profile, {recursive:true, force:true}); }catch(e){}
  }
})().catch(e => { console.error('ÉCHEC :', e.message); process.exit(1); });
