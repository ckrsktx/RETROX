import { useState, useEffect, useRef } from 'react';
import JSZip from 'jszip';

// ─── BANCO DE DADOS LOCAL (ROMs e Histórico) ───
const DB_NAME = 'retrox-db';
const DB_VERSION = 5;

const initDB = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    if (!req.result.objectStoreNames.contains('roms')) req.result.createObjectStore('roms');
    if (!req.result.objectStoreNames.contains('history')) req.result.createObjectStore('history', { keyPath: 'id' });
    if (!req.result.objectStoreNames.contains('saves')) req.result.createObjectStore('saves');
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

// Save state functions
const saveGameState = async (gameId: string, stateData: Uint8Array) => {
  const db = await initDB();
  const tx = db.transaction('saves', 'readwrite');
  tx.objectStore('saves').put({ data: stateData, savedAt: Date.now() }, gameId);
  return new Promise<void>((r) => { tx.oncomplete = () => r(); });
};

const loadGameState = async (gameId: string): Promise<{ data: Uint8Array; savedAt: number } | null> => {
  const db = await initDB();
  return new Promise((resolve) => {
    const req = db.transaction('saves', 'readonly').objectStore('saves').get(gameId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
};

const hasGameState = async (gameId: string): Promise<boolean> => {
  const db = await initDB();
  return new Promise((resolve) => {
    const req = db.transaction('saves', 'readonly').objectStore('saves').count(gameId);
    req.onsuccess = () => resolve(req.result > 0);
    req.onerror = () => resolve(false);
  });
};

const storeROM = async (buffer: ArrayBuffer, name: string, core: string) => {
  const db = await initDB();
  const tx = db.transaction(['roms', 'history'], 'readwrite');
  tx.objectStore('roms').put({ buffer, name, core }, 'current-rom');
  const gameId = name + '_' + core;
  tx.objectStore('history').put({ id: gameId, name, core, buffer, lastPlayed: Date.now() });
  return new Promise<void>((r) => { tx.oncomplete = () => r(); });
};

const getHistory = async (): Promise<any[]> => {
  const db = await initDB();
  return new Promise((resolve) => {
    const req = db.transaction('history', 'readonly').objectStore('history').getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 8));
    req.onerror = () => resolve([]);
  });
};

const loadFromHistory = async (gameId: string) => {
  const db = await initDB();
  const tx = db.transaction(['history', 'roms'], 'readwrite');
  return new Promise<any>((resolve, reject) => {
    const getReq = tx.objectStore('history').get(gameId);
    getReq.onsuccess = () => {
      const game = getReq.result;
      if (game) {
        game.lastPlayed = Date.now();
        tx.objectStore('history').put(game);
        tx.objectStore('roms').put({ buffer: game.buffer, name: game.name, core: game.core }, 'current-rom');
        resolve(game);
      } else reject(new Error("Jogo não encontrado"));
    };
  });
};

const deleteFromHistory = async (gameId: string) => {
  const db = await initDB();
  const tx = db.transaction('history', 'readwrite');
  tx.objectStore('history').delete(gameId);
  return new Promise<void>((r) => { tx.oncomplete = () => r(); });
};

// ─── SISTEMAS SUPORTADOS (Cores Synthwave/Neon) ───
const SYSTEMS = [
  { id: 'snes', core: 'snes', name: 'Super Nintendo', short: 'SNES', exts: ['.smc', '.sfc'], color: '#ff00ff' },
  { id: 'gba',  core: 'gba',  name: 'Game Boy Advance', short: 'GBA', exts: ['.gba'], color: '#ff006e' },
  { id: 'gb',   core: 'gb',   name: 'Game Boy / Color', short: 'GB', exts: ['.gb', '.gbc'], color: '#00ff9f' },
  { id: 'nes',  core: 'nes',  name: 'Nintendo (NES)', short: 'NES', exts: ['.nes'], color: '#ff3864' },
  { id: 'md',   core: 'segaMD', name: 'Sega Mega Drive', short: 'MD', exts: ['.md', '.smd', '.gen', '.bin'], color: '#00d4ff' },
  { id: 'sms',  core: 'segaMS', name: 'Master System', short: 'SMS', exts: ['.sms'], color: '#00ffff' },
  { id: 'gg',   core: 'segaGG', name: 'Game Gear', short: 'GG', exts: ['.gg'], color: '#39ff14' },
  { id: 'a2600',core: 'atari2600', name: 'Atari 2600', short: 'A2600', exts: ['.a26'], color: '#ff10f0' },
  { id: 'a7800',core: 'atari7800', name: 'Atari 7800', short: 'A7800', exts: ['.a78'], color: '#ff44cc' },
  { id: 'lynx', core: 'lynx', name: 'Atari Lynx', short: 'LYNX', exts: ['.lnx'], color: '#fbbf24' },
  { id: 'vb',   core: 'vb',   name: 'Virtual Boy', short: 'VB', exts: ['.vb'], color: '#ff0040' },
  { id: 'ngp',  core: 'ngp',  name: 'Neo Geo Pocket', short: 'NGP', exts: ['.ngp', '.ngc'], color: '#5d8aff' },
  { id: 'ws',   core: 'ws',   name: 'WonderSwan', short: 'WS', exts: ['.ws', '.wsc'], color: '#b537f2' },
  { id: 'coleco', core: 'coleco', name: 'ColecoVision', short: 'COL', exts: ['.col'], color: '#00ffaa' },
  { id: 'pce',  core: 'pce',  name: 'PC Engine / TG16', short: 'PCE', exts: ['.pce'], color: '#ff8c00' },
];

const ALL_EXTS = [...SYSTEMS.flatMap(s => s.exts), '.zip'];

// ─── MAPEAMENTO DE BOTÕES (RetroArch) ───
const BTN: Record<string, number> = {
  b: 0, y: 1, sl: 2, st: 3,
  du: 4, dd: 5, dl: 6, dr: 7,
  a: 8, x: 9, l: 10, r: 11,
  // Alias para Genesis (3 botões: A=Y, B=B, C=A)
  genA: 1, genB: 0, genC: 8,
};

// ─── HTML do iframe do Emulador ───
const EJS_HTML = `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body,html{width:100%;height:100%;overflow:hidden;background:#000;font-family:system-ui,sans-serif}
  #game{width:100%;height:100%;position:absolute;display:flex;align-items:center;justify-content:center}
  #boot{position:fixed;inset:0;z-index:9;background:#09090b;display:flex;flex-direction:column;align-items:center;justify-content:center;transition:opacity .3s}
  .sp{width:28px;height:28px;border:3px solid #1a1a20;border-top-color:#ff00ff;border-radius:50%;animation:s .6s linear infinite;filter:drop-shadow(0 0 8px #ff00ff)}
  @keyframes s{to{transform:rotate(360deg)}}
  p{color:#ff00ff;font-size:10px;margin-top:12px;font-weight:900;letter-spacing:2px;text-transform:uppercase;text-shadow:0 0 8px #ff00ff}
  .ejs_virtual_gamepad,[class*="ejs_virtual"],[class*="nipple"]{display:none!important}
  canvas{image-rendering:pixelated!important;max-width:100%;max-height:100%}
</style>
</head><body>
<div id="boot"><div class="sp"></div><p>RETROX CORE</p></div>
<div id="game"></div>
<script>
(function(){
  var boot=document.getElementById('boot');
  var pendingAutoLoad=null;

  indexedDB.open('retrox-db',5).onsuccess=function(e){
    e.target.result.transaction('roms').objectStore('roms').get('current-rom').onsuccess=function(ev){
      var d=ev.target.result; if(!d)return;
      window.EJS_player='#game';
      window.EJS_core=d.core;
      window.EJS_pathtodata='https://cdn.emulatorjs.org/stable/data/';
      window.EJS_gameUrl=URL.createObjectURL(new Blob([d.buffer]));
      window.EJS_gameName=d.name;
      window.EJS_startOnLoaded=true;
      window.EJS_browserMode=2;
      window.EJS_defaultOptions={'save-state-location':'browser','webgl':true};

      window.EJS_onGameStart=function(){
        boot.style.opacity=0;
        setTimeout(function(){boot.remove()},400);
        // Avisa o React que o jogo iniciou — para auto-carregar save se houver
        window.parent.postMessage({t:'gameReady',gameId:d.name+'_'+d.core},'*');
      };

      var s=document.createElement('script');
      s.src='https://cdn.emulatorjs.org/stable/data/loader.js';
      document.body.appendChild(s);
    }
  };

  window.addEventListener('message',function(e){
    var d=e.data;if(!d||!d.t)return;
    var em=window.EJS_emulator;if(!em||!em.gameManager)return;

    if(d.t==='b')em.gameManager.simulateInput(0,d.i,d.v);

    // SALVAR ESTADO: captura bytes e devolve para o React
    if(d.t==='sv'){
      try{
        var stateData=em.gameManager.getState();
        if(stateData){
          window.parent.postMessage({t:'stateSaved',data:stateData},'*');
        }
      }catch(err){
        window.parent.postMessage({t:'stateError',msg:'Falha ao salvar'},'*');
      }
    }

    // CARREGAR ESTADO: recebe bytes e injeta no emulador
    if(d.t==='ld' && d.data){
      try{
        em.gameManager.loadState(d.data);
        window.parent.postMessage({t:'stateLoaded'},'*');
      }catch(err){
        window.parent.postMessage({t:'stateError',msg:'Falha ao carregar'},'*');
      }
    }

    if(d.t==='rs')em.gameManager.restart();
  });
})();
</script></body></html>`;

// ─── APLICAÇÃO PRINCIPAL ───
export default function App() {
  const [screen, setScreen] = useState<'home' | 'play'>('home');
  const [loading, setLoading] = useState(false);
  const [gameName, setGameName] = useState('');
  const [activeSys, setActiveSys] = useState<string>('snes');
  const [history, setHistory] = useState<any[]>([]);
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const [toast, setToast] = useState<{ msg: string; color: string } | null>(null);
  const [hasSave, setHasSave] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const currentGameId = useRef<string>('');
  const autoLoadOnReady = useRef<boolean>(false);

  // Toast helper
  const showToast = (msg: string, color: string = '#00ff9f') => {
    setToast({ msg, color });
    setTimeout(() => setToast(null), 2200);
  };

  useEffect(() => {
    if (screen === 'home') {
      getHistory().then(async (list) => {
        // Verifica quais jogos têm save state
        const enriched = await Promise.all(list.map(async (g) => ({
          ...g,
          hasSave: await hasGameState(g.id)
        })));
        setHistory(enriched);
      });
    }
    const handleBeforeInstall = (e: any) => { e.preventDefault(); setInstallPrompt(e); };
    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
  }, [screen]);

  // Listener das mensagens do iframe (save / load / ready)
  useEffect(() => {
    const handler = async (e: MessageEvent) => {
      const d = e.data;
      if (!d || !d.t) return;

      // Jogo iniciou - verifica se há save salvo
      if (d.t === 'gameReady') {
        currentGameId.current = d.gameId;
        const exists = await hasGameState(d.gameId);
        setHasSave(exists);

        // Auto-load se vier do "Continue Jogando"
        if (exists && autoLoadOnReady.current) {
          autoLoadOnReady.current = false;
          setTimeout(async () => {
            const saved = await loadGameState(d.gameId);
            if (saved) {
              iframeRef.current?.contentWindow?.postMessage({ t: 'ld', data: saved.data }, '*');
            }
          }, 800); // Aguarda emulador estabilizar
        }
      }

      // Estado salvo com sucesso pelo emulador
      if (d.t === 'stateSaved' && d.data && currentGameId.current) {
        try {
          await saveGameState(currentGameId.current, d.data);
          setHasSave(true);
          showToast('✓ JOGO SALVO', '#00ff9f');
        } catch {
          showToast('✗ ERRO AO SALVAR', '#ff006e');
        }
      }

      // Estado carregado com sucesso
      if (d.t === 'stateLoaded') {
        showToast('✓ JOGO CARREGADO', '#00d4ff');
      }

      if (d.t === 'stateError') {
        showToast('✗ ' + (d.msg || 'ERRO'), '#ff006e');
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const handleInstallClick = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') setInstallPrompt(null);
  };

  const post = (d: any) => iframeRef.current?.contentWindow?.postMessage(d, '*');

  // Salvar: pede ao emulador para extrair state, listener acima persiste no IndexedDB
  const handleSave = () => {
    post({ t: 'sv' });
  };

  // Carregar: busca no IndexedDB e envia ao emulador
  const handleLoad = async () => {
    if (!currentGameId.current) return;
    const saved = await loadGameState(currentGameId.current);
    if (!saved) {
      showToast('✗ NENHUM SAVE', '#ff006e');
      return;
    }
    post({ t: 'ld', data: saved.data });
  };

  const getSystemInfo = (filename: string) => {
    const lower = filename.toLowerCase();
    return SYSTEMS.find(sys => sys.exts.some(ext => lower.endsWith(ext)));
  };

  const processBuffer = async (buf: ArrayBuffer, fileName: string) => {
    let finalBuf = buf;
    let finalName = fileName;

    if (fileName.toLowerCase().endsWith('.zip')) {
      const zip = await JSZip.loadAsync(buf);
      const allExts = SYSTEMS.flatMap(s => s.exts);
      const f = Object.values(zip.files).find(x => !x.dir && allExts.some(e => x.name.toLowerCase().endsWith(e)));
      if (!f) throw new Error("Nenhuma ROM compatível encontrada no ZIP");
      finalBuf = await f.async('arraybuffer');
      finalName = f.name;
    }

    const sysInfo = getSystemInfo(finalName);
    if (!sysInfo) throw new Error("Console não suportado por este formato");

    const cleanName = finalName.replace(/\.[^/.]+$/, "");
    await storeROM(finalBuf, cleanName, sysInfo.core);
    setGameName(cleanName);
    setActiveSys(sysInfo.id);
    setScreen('play');
    setLoading(false);
  };

  const handleFile = async (file: File) => {
    setLoading(true);
    try {
      const buf = await file.arrayBuffer();
      await processBuffer(buf, file.name);
    } catch (e: any) { alert(e.message); setLoading(false); }
  };

  const playFromHistory = async (gameId: string) => {
    setLoading(true);
    try {
      const game = await loadFromHistory(gameId);
      const sysInfo = SYSTEMS.find(s => s.core === game.core);
      setGameName(game.name);
      setActiveSys(sysInfo?.id || 'snes');
      // Marca para auto-carregar save quando o jogo iniciar
      autoLoadOnReady.current = true;
      setScreen('play');
    } catch (e: any) { alert("Erro: " + e.message); }
    setLoading(false);
  };

  const removeFromHistory = async (gameId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await deleteFromHistory(gameId);
    setHistory(await getHistory());
  };

  // ── TELA DE JOGO ──
  if (screen === 'play') {
    return (
      <div className="fixed inset-0 bg-black flex flex-col overflow-hidden select-none">
        <div className="h-10 flex items-center px-3 gap-2 border-b border-pink-500/20 shrink-0 relative" style={{ background: 'linear-gradient(180deg, #0a001a 0%, #1a0033 100%)' }}>
          <button onClick={() => setScreen('home')} className="text-cyan-400 px-2 text-lg font-bold" style={{ textShadow: '0 0 8px #00ffff' }}>←</button>
          <span className="flex-1 text-white text-[10px] font-black truncate opacity-80 uppercase tracking-widest text-center" style={{ textShadow: '0 0 6px #ff00ff' }}>{gameName}</span>

          {/* Botão Salvar */}
          <button onClick={handleSave} className="text-[9px] text-white px-3 py-1 rounded-full font-black uppercase flex items-center gap-1" style={{ background: 'linear-gradient(135deg, #ff00ff, #ff006e)', boxShadow: '0 0 10px rgba(255,0,255,0.5)' }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
              <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
            </svg>
            Salvar
          </button>

          {/* Botão Carregar — pisca quando há save disponível */}
          <button
            onClick={handleLoad}
            className="text-[9px] text-white px-3 py-1 rounded-full font-black uppercase flex items-center gap-1 relative"
            style={{
              background: hasSave ? 'linear-gradient(135deg, #00d4ff, #00ffff)' : 'linear-gradient(135deg, #1a1a2e, #2a2a4e)',
              boxShadow: hasSave ? '0 0 10px rgba(0,212,255,0.5)' : 'none',
              opacity: hasSave ? 1 : 0.4
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
              <path d="M22 12v7a2 2 0 01-2 2H4a2 2 0 01-2-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>
            </svg>
            Carregar
            {hasSave && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full" style={{
                background: '#00ff9f',
                boxShadow: '0 0 6px #00ff9f',
                animation: 'pulse 1.5s ease-in-out infinite'
              }} />
            )}
          </button>

          <button onClick={() => post({ t: 'rs' })} className="text-pink-400 px-2 font-bold" style={{ textShadow: '0 0 8px #ff00ff' }}>↺</button>

          {/* TOAST de confirmação */}
          {toast && (
            <div
              className="absolute left-1/2 -translate-x-1/2 top-12 px-5 py-2.5 rounded-2xl font-black text-xs uppercase tracking-widest pointer-events-none z-50"
              style={{
                background: 'linear-gradient(135deg, rgba(0,0,0,0.95), rgba(20,0,40,0.95))',
                border: `2px solid ${toast.color}`,
                color: toast.color,
                boxShadow: `0 0 25px ${toast.color}80, inset 0 0 15px ${toast.color}30`,
                textShadow: `0 0 8px ${toast.color}`,
                animation: 'toastIn 0.3s ease-out',
              }}
            >
              {toast.msg}
            </div>
          )}

          <style>{`
            @keyframes pulse {
              0%, 100% { opacity: 1; transform: scale(1); }
              50% { opacity: 0.5; transform: scale(1.2); }
            }
            @keyframes toastIn {
              from { opacity: 0; transform: translate(-50%, -10px) scale(0.9); }
              to { opacity: 1; transform: translate(-50%, 0) scale(1); }
            }
          `}</style>
        </div>
        <div className="flex-1 relative">
          <iframe ref={iframeRef} srcDoc={EJS_HTML} className="w-full h-full border-0" allow="autoplay;gamepad" />
        </div>
        {/* Controles dinâmicos */}
        {activeSys === 'snes' && <PadSNES post={post} />}
        {activeSys === 'gba' && <PadGBA post={post} />}
        {activeSys === 'gb' && <PadGB post={post} />}
        {activeSys === 'nes' && <PadNES post={post} />}
        {activeSys === 'md' && <PadGenesis post={post} />}
        {(activeSys === 'sms' || activeSys === 'gg' || activeSys === 'coleco' || activeSys === 'pce') && <Pad2Btn post={post} />}
        {(activeSys === 'a2600' || activeSys === 'a7800' || activeSys === 'lynx' || activeSys === 'vb' || activeSys === 'ngp' || activeSys === 'ws') && <PadGeneric post={post} />}
      </div>
    );
  }

  // ── TELA INICIAL (SYNTHWAVE) ──
  return (
    <div className="min-h-screen flex flex-col items-center font-sans overflow-y-auto relative" style={{
      background: 'radial-gradient(ellipse at top, #2d0061 0%, #0a0014 50%, #000 100%)',
      backgroundAttachment: 'fixed'
    }}>
      
      {/* Grid de fundo Synthwave */}
      <div className="fixed inset-0 pointer-events-none opacity-30" style={{
        backgroundImage: `
          linear-gradient(rgba(255, 0, 255, 0.15) 1px, transparent 1px),
          linear-gradient(90deg, rgba(0, 255, 255, 0.15) 1px, transparent 1px)
        `,
        backgroundSize: '40px 40px',
        maskImage: 'linear-gradient(180deg, transparent 0%, black 30%, black 70%, transparent 100%)',
        WebkitMaskImage: 'linear-gradient(180deg, transparent 0%, black 30%, black 70%, transparent 100%)',
      }} />
      
      {/* Sol/horizonte synthwave no fundo */}
      <div className="fixed top-1/4 left-1/2 -translate-x-1/2 pointer-events-none" style={{
        width: 300, height: 300, borderRadius: '50%',
        background: 'radial-gradient(circle, #ff006e 0%, #ff00ff 30%, transparent 70%)',
        opacity: 0.15, filter: 'blur(40px)'
      }} />

      {/* Topo PWA */}
      {installPrompt && (
        <div className="w-full text-xs font-bold py-3 px-4 flex justify-between items-center relative z-10" style={{
          background: 'linear-gradient(90deg, rgba(255,0,255,0.1), rgba(0,255,255,0.1))',
          borderBottom: '1px solid rgba(255,0,255,0.3)',
          color: '#ff00ff',
          textShadow: '0 0 8px #ff00ff'
        }}>
          <span>▶ INSTALAR APP</span>
          <button onClick={handleInstallClick} className="text-white px-3 py-1.5 rounded-full uppercase tracking-wider text-[10px] font-black"
            style={{ background: 'linear-gradient(135deg, #ff00ff, #00ffff)', boxShadow: '0 0 15px rgba(255,0,255,0.5)' }}>
            Install
          </button>
        </div>
      )}

      <div className="w-full max-w-md flex flex-col items-center px-6 py-10 relative z-10">
        
        {/* Logo Synthwave */}
        <div className="text-center mb-10">
          <h1 className="text-6xl font-black tracking-tighter italic mb-2" style={{
            background: 'linear-gradient(180deg, #00ffff 0%, #ff00ff 50%, #ff006e 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            filter: 'drop-shadow(0 0 20px rgba(255,0,255,0.6))',
            fontFamily: 'system-ui, sans-serif'
          }}>
            RETROX
          </h1>
          <div className="flex items-center justify-center gap-2">
            <div className="h-px w-8" style={{ background: 'linear-gradient(90deg, transparent, #00ffff)' }} />
            <p className="text-[10px] font-black uppercase tracking-[0.4em]" style={{
              color: '#00ffff',
              textShadow: '0 0 10px #00ffff'
            }}>By ConkerClan</p>
            <div className="h-px w-8" style={{ background: 'linear-gradient(90deg, #00ffff, transparent)' }} />
          </div>
        </div>

        {/* Upload Synthwave */}
        <label className={`w-full p-8 border-2 rounded-3xl cursor-pointer flex flex-col items-center justify-center transition-all mb-8 relative overflow-hidden ${loading ? 'opacity-30 pointer-events-none' : 'hover:scale-[1.02]'}`}
          style={{
            borderColor: '#ff00ff',
            background: 'linear-gradient(135deg, rgba(255,0,255,0.05), rgba(0,255,255,0.05))',
            boxShadow: '0 0 30px rgba(255,0,255,0.2), inset 0 0 20px rgba(0,255,255,0.05)'
          }}>
          {loading ? (
            <div style={{
              width: 32, height: 32,
              border: '3px solid rgba(255,0,255,0.2)',
              borderTopColor: '#ff00ff',
              borderRadius: '50%',
              animation: 'spin .6s linear infinite',
              filter: 'drop-shadow(0 0 8px #ff00ff)'
            }} />
          ) : (
            <>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#00ffff" strokeWidth={2.5} className="mb-3" style={{ filter: 'drop-shadow(0 0 6px #00ffff)' }}>
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" />
              </svg>
              <span className="text-white text-sm font-black uppercase tracking-widest" style={{ textShadow: '0 0 10px #ff00ff' }}>
                Inserir Cartucho
              </span>
              <p className="text-[9px] mt-2 font-bold uppercase tracking-widest text-center" style={{ color: '#00ffff', opacity: 0.7 }}>
                .ZIP / ROM
              </p>
            </>
          )}
          <input type="file" className="hidden" accept={ALL_EXTS.join(',')}
            onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} />
        </label>

        {/* Continuar Jogando */}
        {history.length > 0 && (
          <div className="w-full mb-8">
            <div className="flex items-center justify-center gap-2 mb-4">
              <div className="h-px flex-1" style={{ background: 'linear-gradient(90deg, transparent, #ff00ff)' }} />
              <p className="text-[10px] font-black uppercase tracking-[0.2em]" style={{ color: '#ff00ff', textShadow: '0 0 8px #ff00ff' }}>
                ▶ Continue
              </p>
              <div className="h-px flex-1" style={{ background: 'linear-gradient(90deg, #ff00ff, transparent)' }} />
            </div>
            <div className="flex flex-col gap-2">
              {history.map((game) => {
                const sys = SYSTEMS.find(s => s.core === game.core);
                return (
                  <button key={game.id} onClick={() => playFromHistory(game.id)}
                    className="w-full p-3 rounded-2xl flex items-center justify-between active:scale-[0.98] transition-all"
                    style={{
                      background: 'linear-gradient(90deg, rgba(255,0,255,0.05), rgba(0,255,255,0.03))',
                      border: '1px solid rgba(255,0,255,0.2)',
                      boxShadow: '0 0 15px rgba(255,0,255,0.1)'
                    }}>
                    <div className="flex items-center gap-3 truncate">
                      <div className="w-10 h-10 rounded-xl flex items-center justify-center text-[9px] font-black text-black shrink-0 relative"
                        style={{
                          background: sys?.color || '#ff00ff',
                          boxShadow: `0 0 12px ${sys?.color}80`
                        }}>
                        {sys?.short || 'GAME'}
                        {/* Indicador verde se há save */}
                        {game.hasSave && (
                          <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full border-2 border-black" style={{
                            background: '#00ff9f',
                            boxShadow: '0 0 8px #00ff9f'
                          }} />
                        )}
                      </div>
                      <div className="flex flex-col text-left truncate">
                        <span className="text-white text-sm font-bold truncate">{game.name}</span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: sys?.color || '#00ffff' }}>
                            {sys?.name}
                          </span>
                          {game.hasSave && (
                            <span className="text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded" style={{
                              color: '#00ff9f',
                              background: 'rgba(0,255,159,0.1)',
                              border: '1px solid rgba(0,255,159,0.3)'
                            }}>
                              ◉ SAVE
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={(e) => removeFromHistory(game.id, e)}
                        className="w-7 h-7 rounded-full flex items-center justify-center text-xs"
                        style={{ color: 'rgba(255,255,255,0.3)' }}>✕</button>
                      <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-black text-black"
                        style={{
                          background: 'linear-gradient(135deg, #00ffff, #ff00ff)',
                          boxShadow: '0 0 12px rgba(255,0,255,0.6)'
                        }}>▶</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Consoles em Grid Neon */}
        <div className="w-full">
          <div className="flex items-center justify-center gap-2 mb-4">
            <div className="h-px flex-1" style={{ background: 'linear-gradient(90deg, transparent, #00ffff)' }} />
            <p className="text-[10px] font-black uppercase tracking-[0.2em]" style={{ color: '#00ffff', textShadow: '0 0 8px #00ffff' }}>
              ◆ Sistemas ({SYSTEMS.length})
            </p>
            <div className="h-px flex-1" style={{ background: 'linear-gradient(90deg, #00ffff, transparent)' }} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            {SYSTEMS.map(s => (
              <div key={s.id} className="rounded-xl py-3 px-2 flex flex-col items-center justify-center transition-all hover:scale-105"
                style={{
                  background: 'linear-gradient(135deg, rgba(0,0,0,0.6), rgba(45,0,97,0.3))',
                  border: `1px solid ${s.color}40`,
                  boxShadow: `0 0 10px ${s.color}30, inset 0 0 10px ${s.color}10`
                }}>
                <span className="text-[11px] font-black mb-0.5"
                  style={{ color: s.color, textShadow: `0 0 6px ${s.color}` }}>
                  {s.short}
                </span>
                <span className="text-[7px] font-bold uppercase truncate w-full text-center" style={{ color: 'rgba(255,255,255,0.4)' }}>
                  {s.name.split(' ')[0]}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Aviso */}
        <p className="text-[9px] text-center mt-10 leading-relaxed font-bold uppercase tracking-wider" style={{ color: 'rgba(255,0,255,0.4)' }}>
          ▲ Retrox não distribui jogos ▲<br />
          Use ROMs de backups legais
        </p>

        {/* Linhas synthwave decorativas no rodapé */}
        <div className="w-full mt-8 flex flex-col gap-1 opacity-40">
          <div className="h-px" style={{ background: 'linear-gradient(90deg, transparent, #ff00ff, transparent)' }} />
          <div className="h-px" style={{ background: 'linear-gradient(90deg, transparent, #00ffff, transparent)' }} />
          <div className="h-px" style={{ background: 'linear-gradient(90deg, transparent, #ff00ff, transparent)' }} />
        </div>
      </div>

      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ─── COMPONENTE BASE: Botão (Synthwave Style) ───
const Btn = ({ p, id, ch, bg, sz = 44, fs = 14, cl = 'white', rounded = 'full', h, glow }: any) => {
  const glowColor = glow || bg;
  return (
    <button
      onTouchStart={e => { e.preventDefault(); p({ t: 'b', i: BTN[id], v: 1 }) }}
      onTouchEnd={e => { e.preventDefault(); p({ t: 'b', i: BTN[id], v: 0 }) }}
      onTouchCancel={e => { e.preventDefault(); p({ t: 'b', i: BTN[id], v: 0 }) }}
      onMouseDown={() => p({ t: 'b', i: BTN[id], v: 1 })}
      onMouseUp={() => p({ t: 'b', i: BTN[id], v: 0 })}
      onMouseLeave={() => p({ t: 'b', i: BTN[id], v: 0 })}
      className="select-none font-black flex items-center justify-center active:scale-90 transition-transform"
      style={{
        width: sz,
        height: h || sz,
        background: bg,
        color: cl,
        fontSize: fs,
        WebkitTapHighlightColor: 'transparent',
        borderRadius: rounded === 'full' ? '50%' : '12px',
        border: `1px solid ${glowColor}80`,
        boxShadow: `0 0 8px ${glowColor}80, inset 0 -3px 6px rgba(0,0,0,0.4)`,
        textShadow: `0 0 4px ${glowColor}`,
      }}
    >{ch}</button>
  );
};

// ─── D-Pad Synthwave ───
const DPad = ({ post, scale = 1.25 }: any) => (
  <div className="grid grid-cols-3 gap-1" style={{ transform: `scale(${scale})` }}>
    <div /><Btn p={post} id="du" ch="▲" bg="#0a0014" sz={32} fs={14} glow="#00ffff" /><div />
    <Btn p={post} id="dl" ch="◀" bg="#0a0014" sz={32} fs={14} glow="#00ffff" />
    <div className="w-8 h-8 rounded" style={{ background: 'rgba(0,255,255,0.05)', border: '1px solid rgba(0,255,255,0.2)' }} />
    <Btn p={post} id="dr" ch="▶" bg="#0a0014" sz={32} fs={14} glow="#00ffff" />
    <div /><Btn p={post} id="dd" ch="▼" bg="#0a0014" sz={32} fs={14} glow="#00ffff" /><div />
  </div>
);

// Container synthwave para gamepads
const PadContainer = ({ children }: any) => (
  <div className="shrink-0 p-4 pb-10 touch-none relative" style={{
    background: 'linear-gradient(180deg, #0a0014 0%, #1a0033 100%)',
    borderTop: '1px solid rgba(255,0,255,0.3)',
    boxShadow: 'inset 0 1px 0 rgba(255,0,255,0.4), 0 -10px 30px rgba(255,0,255,0.1)'
  }}>
    {/* Linha de neon decorativa */}
    <div className="absolute top-0 left-0 right-0 h-px" style={{
      background: 'linear-gradient(90deg, transparent, #ff00ff, #00ffff, #ff00ff, transparent)'
    }} />
    {children}
  </div>
);

// ─── 1. Super Nintendo ───
function PadSNES({ post }: any) {
  return (
    <PadContainer>
      <div className="flex justify-between items-center mb-6 px-2">
        <Btn p={post} id="l" ch="L" bg="#0a0014" sz={56} h={26} fs={12} rounded="lg" glow="#00ffff" />
        <Btn p={post} id="r" ch="R" bg="#0a0014" sz={56} h={26} fs={12} rounded="lg" glow="#00ffff" />
      </div>
      <div className="flex justify-between items-end px-3">
        <DPad post={post} />
        <div className="flex gap-3 pb-2">
          <div className="flex flex-col items-center gap-1 -rotate-[15deg]">
            <Btn p={post} id="sl" ch="" bg="#0a0014" sz={34} h={12} rounded="lg" glow="#ff00ff" />
            <span className="text-[8px] font-bold uppercase" style={{ color: '#ff00ff' }}>Select</span>
          </div>
          <div className="flex flex-col items-center gap-1 -rotate-[15deg]">
            <Btn p={post} id="st" ch="" bg="#0a0014" sz={34} h={12} rounded="lg" glow="#ff00ff" />
            <span className="text-[8px] font-bold uppercase" style={{ color: '#ff00ff' }}>Start</span>
          </div>
        </div>
        <div className="relative w-[120px] h-[120px]">
          <div className="absolute top-0 left-1/2 -translate-x-1/2"><Btn p={post} id="x" ch="X" bg="#0a0014" sz={42} glow="#00d4ff" /></div>
          <div className="absolute left-0 top-1/2 -translate-y-1/2"><Btn p={post} id="y" ch="Y" bg="#0a0014" sz={42} glow="#00ff9f" /></div>
          <div className="absolute right-0 top-1/2 -translate-y-1/2"><Btn p={post} id="a" ch="A" bg="#0a0014" sz={42} glow="#ff006e" /></div>
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2"><Btn p={post} id="b" ch="B" bg="#0a0014" sz={42} glow="#fbbf24" /></div>
        </div>
      </div>
    </PadContainer>
  );
}

// ─── 2. Game Boy Advance ───
function PadGBA({ post }: any) {
  return (
    <PadContainer>
      <div className="flex justify-between items-center mb-6 px-2">
        <Btn p={post} id="l" ch="L" bg="#0a0014" sz={60} h={26} fs={12} rounded="lg" glow="#00ffff" />
        <Btn p={post} id="r" ch="R" bg="#0a0014" sz={60} h={26} fs={12} rounded="lg" glow="#00ffff" />
      </div>
      <div className="flex justify-between items-end px-3">
        <DPad post={post} />
        <div className="flex flex-col gap-2 pb-2">
          <Btn p={post} id="sl" ch="SEL" bg="#0a0014" sz={42} h={16} fs={8} rounded="lg" glow="#ff00ff" />
          <Btn p={post} id="st" ch="STA" bg="#0a0014" sz={42} h={16} fs={8} rounded="lg" glow="#ff00ff" />
        </div>
        <div className="flex items-end gap-2 pb-2">
          <Btn p={post} id="b" ch="B" bg="#0a0014" sz={50} fs={16} glow="#ff006e" />
          <div className="mb-4"><Btn p={post} id="a" ch="A" bg="#0a0014" sz={50} fs={16} glow="#ff006e" /></div>
        </div>
      </div>
    </PadContainer>
  );
}

// ─── 3. Game Boy / Color ───
function PadGB({ post }: any) {
  return (
    <PadContainer>
      <div className="flex justify-between items-end px-3 mt-4">
        <DPad post={post} />
        <div className="flex items-end gap-3 pb-4">
          <Btn p={post} id="b" ch="B" bg="#0a0014" sz={52} fs={16} glow="#ff00ff" />
          <div className="mb-6"><Btn p={post} id="a" ch="A" bg="#0a0014" sz={52} fs={16} glow="#ff00ff" /></div>
        </div>
      </div>
      <div className="flex justify-center gap-6 mt-6">
        <div className="flex flex-col items-center gap-1 -rotate-[25deg]">
          <Btn p={post} id="sl" ch="" bg="#0a0014" sz={40} h={14} rounded="lg" glow="#00ffff" />
          <span className="text-[8px] font-bold uppercase" style={{ color: '#00ffff' }}>Select</span>
        </div>
        <div className="flex flex-col items-center gap-1 -rotate-[25deg]">
          <Btn p={post} id="st" ch="" bg="#0a0014" sz={40} h={14} rounded="lg" glow="#00ffff" />
          <span className="text-[8px] font-bold uppercase" style={{ color: '#00ffff' }}>Start</span>
        </div>
      </div>
    </PadContainer>
  );
}

// ─── 4. NES ───
function PadNES({ post }: any) {
  return (
    <PadContainer>
      <div className="flex justify-between items-end px-3">
        <DPad post={post} scale={1.1} />
        <div className="flex gap-3 pb-3">
          <div className="flex flex-col items-center gap-1">
            <Btn p={post} id="sl" ch="" bg="#0a0014" sz={36} h={14} rounded="lg" glow="#ff00ff" />
            <span className="text-[8px] font-black uppercase" style={{ color: '#ff00ff' }}>Select</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <Btn p={post} id="st" ch="" bg="#0a0014" sz={36} h={14} rounded="lg" glow="#ff00ff" />
            <span className="text-[8px] font-black uppercase" style={{ color: '#ff00ff' }}>Start</span>
          </div>
        </div>
        <div className="flex items-end gap-3 p-3 rounded-xl" style={{
          background: 'rgba(255,0,255,0.05)',
          border: '1px solid rgba(255,0,255,0.2)'
        }}>
          <div className="flex flex-col items-center gap-1">
            <Btn p={post} id="b" ch="B" bg="#0a0014" sz={46} fs={16} glow="#ff3864" />
            <span className="text-[10px] font-black" style={{ color: '#ff3864' }}>B</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <Btn p={post} id="a" ch="A" bg="#0a0014" sz={46} fs={16} glow="#ff3864" />
            <span className="text-[10px] font-black" style={{ color: '#ff3864' }}>A</span>
          </div>
        </div>
      </div>
    </PadContainer>
  );
}

// ─── 5. Sega Genesis / Mega Drive ───
function PadGenesis({ post }: any) {
  return (
    <PadContainer>
      <div className="flex justify-center mb-4">
        <Btn p={post} id="st" ch="START" bg="#0a0014" cl="#fff" sz={60} h={22} fs={9} rounded="lg" glow="#00d4ff" />
      </div>
      <div className="flex justify-between items-end px-4">
        <DPad post={post} />
        <div className="flex items-end gap-2 pb-2">
          <div className="mb-2"><Btn p={post} id="genA" ch="A" bg="#0a0014" sz={46} fs={16} glow="#00d4ff" /></div>
          <div className="mb-4"><Btn p={post} id="genB" ch="B" bg="#0a0014" sz={46} fs={16} glow="#ff00ff" /></div>
          <div className="mb-6"><Btn p={post} id="genC" ch="C" bg="#0a0014" sz={46} fs={16} glow="#00ff9f" /></div>
        </div>
      </div>
    </PadContainer>
  );
}

// ─── 6. Master System / Game Gear / ColecoVision / PC Engine (2 botões) ───
function Pad2Btn({ post }: any) {
  return (
    <PadContainer>
      <div className="flex justify-center mb-4">
        <Btn p={post} id="st" ch="START / PAUSE" bg="#0a0014" sz={130} h={26} fs={10} rounded="lg" glow="#ff00ff" />
      </div>
      <div className="flex justify-between items-end px-3">
        <DPad post={post} />
        <div className="flex items-end gap-3 pb-2">
          <Btn p={post} id="b" ch="1" bg="#0a0014" sz={52} fs={18} glow="#ff006e" />
          <div className="mb-4"><Btn p={post} id="a" ch="2" bg="#0a0014" sz={52} fs={18} glow="#00ffff" /></div>
        </div>
      </div>
    </PadContainer>
  );
}

// ─── 7. Genérico (Atari, Lynx, Virtual Boy, Neo Geo Pocket, WonderSwan) ───
function PadGeneric({ post }: any) {
  return (
    <PadContainer>
      <div className="flex justify-center gap-4 mb-4">
        <Btn p={post} id="sl" ch="SELECT" bg="#0a0014" sz={70} h={20} fs={9} rounded="lg" glow="#00ffff" />
        <Btn p={post} id="st" ch="START" bg="#0a0014" sz={70} h={20} fs={9} rounded="lg" glow="#ff00ff" />
      </div>
      <div className="flex justify-between items-end px-3">
        <DPad post={post} />
        <div className="flex items-end gap-3 pb-2">
          <Btn p={post} id="b" ch="B" bg="#0a0014" sz={50} fs={16} glow="#ff006e" />
          <div className="mb-3"><Btn p={post} id="a" ch="A" bg="#0a0014" sz={50} fs={16} glow="#00ffff" /></div>
        </div>
      </div>
    </PadContainer>
  );
}
