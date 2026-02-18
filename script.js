// ============================================================
//  SURVIVOR.IO BETA — Full Refactor
//  Optimizations:
//    • Object Pools (particles ×600, dmgNums ×100) — zero GC
//    • Obstacle Spatial Grid (static, built once)
//    • Enemy Spatial Grid (dynamic, rebuilt each frame) — O(1) proj-enemy collisions
//    • Enemy separation with windowed scan — O(n·W) not O(n²)
//    • Frustum Culling — skip offscreen render & physics
//    • Batch Enemy Rendering — ctx.font set once per enemy type
//    • Swap-and-pop deletion — no splice in hot paths
//    • Performance Mode — toggle shadows + emoji→circle fallback
//    • FPS Monitor — rolling 60-frame average, auto-suggest perf
//  Network:
//    • Zero sync of particles/popups — local generation only
//    • STRUCTURE_SEED sent with 'gs' for deterministic worlds
//    • Full lobby broadcast on every player event
//    • Only positions/HP/kills transmitted
//  Gameplay:
//    • 15% scaling per wave (was 10%)
//    • Max 600 enemies
//    • Increased enemy damage & closer stop distance
//    • 4 new stackable bonuses: Wall, Mines, Boots, Recycle
// ============================================================

// ===== CONFIG =====
const CFG = {
    WORLD: 5000,
    MAX_PLAYERS: 10,
    SYNC_RATE: 33,
    LERP: 0.15,
    CAM_LERP: 0.1,
    ABILITY_CD: 10000,
    DIFF_INTERVAL: 30000,
    DIFF_RATE: 0.15,      // 15% HP/speed scaling per wave (was 0.10)
    RESPAWN_TIME: 30000,
    SHOOT_RANGE: 420,
    SEP_FORCE: 0.35,
    CULL_MARGIN: 120,
    OBS_GRID_CELL: 320,
    EGRID_CELL: 200,      // Dynamic enemy spatial grid cell size
    SEP_WINDOW: 20,
    FPS_TARGET: 45,
    MAX_ENEMY_CAP: 600,   // Absolute max enemies on screen
};

// Mutable world seed (assigned at game creation for determinism)
let STRUCTURE_SEED = 42;

// ===== ENEMY TYPES =====
const ET = {
    zombie:   { emoji:'🧟', hp:30,  spd:1.4, dmg:16, sz:16, xp:15, sc:10,  col:'#95e1d3', ghost:false, shooter:false, charger:false, toxic:false, spider:false },
    ghost:    { emoji:'👻', hp:15,  spd:3.4, dmg:12, sz:13, xp:12, sc:15,  col:'#c9b8f5', ghost:true,  shooter:false, charger:false, toxic:false, spider:false },
    alien:    { emoji:'👾', hp:120, spd:1.0, dmg:45, sz:26, xp:50, sc:50,  col:'#f093fb', ghost:false, shooter:true,  charger:false, toxic:false, spider:false },
    minotaur: { emoji:'🐂', hp:200, spd:2.4, dmg:65, sz:30, xp:80, sc:80,  col:'#ff7043', ghost:false, shooter:false, charger:true,  toxic:false, spider:false },
    fungus:   { emoji:'🍄', hp:60,  spd:0.9, dmg:10, sz:20, xp:30, sc:25,  col:'#a5d6a7', ghost:false, shooter:false, charger:false, toxic:true,  spider:false },
    spider:   { emoji:'🕷️', hp:45,  spd:3.0, dmg:22, sz:18, xp:25, sc:20,  col:'#bcaaa4', ghost:false, shooter:false, charger:false, toxic:false, spider:true  },
};

// Pre-cache emoji font strings per type
const ET_FONT = {};
Object.keys(ET).forEach(k => { ET_FONT[k] = `${ET[k].sz * 2}px serif`; });

// ===== BONUS DEFS =====
const BONUS_DEFS = [
    { id:'speed',     icon:'🏃', name:'Vitesse +',          desc:'+1 vitesse permanente',             stack:'Cumulable ∞', apply: p => p.bonuses.speed += 1 },
    { id:'damage',    icon:'⚔️', name:'Dégâts +',           desc:'+8 dégâts permanents',              stack:'Cumulable ∞', apply: p => p.bonuses.damage += 8 },
    { id:'firerate',  icon:'⚡', name:'Cadence +',          desc:'-60ms cooldown de tir',             stack:'Cumulable ∞', apply: p => p.bonuses.fireRate += 60 },
    { id:'health',    icon:'❤️', name:'HP Max +',           desc:'+25 HP max',                        stack:'Cumulable ∞', apply: p => { p.bonuses.maxHp += 25; p.maxHealth += 25; p.health = Math.min(p.health+25, p.maxHealth); } },
    { id:'aura',      icon:'🔥', name:'Aura de Feu',        desc:'Brûle les ennemis proches',         stack:'Cumulable ∞', apply: p => p.bonuses.aura += 1 },
    { id:'ricochet',  icon:'🎱', name:'Ricochet',           desc:'+1 rebond sur les balles',          stack:'Cumulable ∞', apply: p => p.bonuses.ricochet += 1 },
    { id:'drone',     icon:'🤖', name:'Drone Automatique',  desc:'Un drone tire pour vous',           stack:'Max 3',       apply: p => { if(p.bonuses.drones < 3) p.bonuses.drones += 1; } },
    { id:'vampire',   icon:'🧛', name:'Vampirisme',         desc:'+3 HP par kill',                    stack:'Cumulable ∞', apply: p => p.bonuses.vampire += 3 },
    { id:'magnet',    icon:'🧲', name:'Aimant XP',          desc:'+80 portée de ramassage',           stack:'Cumulable ∞', apply: p => p.bonuses.magnet += 80 },
    { id:'multishot', icon:'💫', name:'Multi-Tir',          desc:'+1 projectile en éventail',         stack:'Max 4',       apply: p => { if(p.bonuses.multishot < 4) p.bonuses.multishot += 1; } },
    // === 4 NOUVEAUX BONUS ===
    { id:'wall',      icon:'🔵', name:'Mur de Protection',  desc:'Orbes qui dégâts et repoussent',    stack:'Max 3',       apply: p => { if(p.bonuses.wall < 3) p.bonuses.wall += 1; } },
    { id:'mines',     icon:'💣', name:'Mines Automatiques', desc:'Pose une mine/3s (AOE 100px)',      stack:'Max 3',       apply: p => { if(p.bonuses.mines < 3) p.bonuses.mines += 1; } },
    { id:'boots',     icon:'👟', name:'Bottes de 7 Lieues', desc:'+30% vitesse, +10% dégâts subis',  stack:'Max 3',       apply: p => { if(p.bonuses.boots < 3) p.bonuses.boots += 1; } },
    { id:'recycle',   icon:'♻️', name:'Recyclage Vert',     desc:'5% chance de +1HP par gemme',      stack:'Cumulable ∞', apply: p => p.bonuses.recycle += 1 },
];

// ===== TROPHIES =====
const TROPHIES = [
    { id:'first_blood',    name:'Premier Sang',   icon:'🩸', check: (s,p) => p.kills >= 1 },
    { id:'survivor_5min',  name:'Survivant 5min', icon:'⏱️', check: (s,p) => s.survivalTime >= 300000 },
    { id:'butcher_100',    name:'Boucher',         icon:'🔪', check: (s,p) => p.kills >= 100 },
    { id:'butcher_1000',   name:'Massacreur',      icon:'⚔️', check: (s,p) => false },
    { id:'lvl_10',         name:'Niveau 10',       icon:'🔟', check: (s,p) => p.level >= 10 },
    { id:'score_10k',      name:'10K Points',      icon:'💯', check: (s,p) => p.score >= 10000 },
    { id:'wave_10',        name:'Vague 10',         icon:'🌊', check: (s,p) => s.wave >= 10 },
    { id:'perfect_health', name:'Santé Parfaite',  icon:'💚', check: (s,p) => p.health >= p.maxHealth },
];
TROPHIES.forEach(t => { t.unlocked = false; });

// ===== SEEDED RNG =====
class Rng {
    constructor(s) { this.s = s; }
    next() { this.s = (this.s * 9301 + 49297) % 233280; return this.s / 233280; }
    range(a, b) { return a + this.next() * (b - a); }
    int(a, b) { return Math.floor(this.range(a, b)); }
    pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
}

// ===================================================================
//  OBJECT POOLS — pre-allocated, zero GC in hot paths
// ===================================================================

// --- Particle Pool (600 slots) ---
const PP_SIZE = 600;
const particlePool = new Array(PP_SIZE);
for (let i = 0; i < PP_SIZE; i++) {
    particlePool[i] = { active: false, x: 0, y: 0, vx: 0, vy: 0, color: '#fff', size: 3, life: 0, maxLife: 1 };
}
let ppIdx = 0;
let ppActive = 0;

function spawnParticle(x, y, color, size, life = 1) {
    for (let attempt = 0; attempt < PP_SIZE; attempt++) {
        const idx = (ppIdx + attempt) % PP_SIZE;
        if (!particlePool[idx].active) {
            ppIdx = (idx + 1) % PP_SIZE;
            const p = particlePool[idx];
            const ang = Math.random() * Math.PI * 2;
            const spd = 0.5 + Math.random() * 3;
            p.active = true; p.x = x; p.y = y;
            p.vx = Math.cos(ang) * spd; p.vy = Math.sin(ang) * spd;
            p.color = color; p.size = size; p.life = life; p.maxLife = life;
            ppActive++;
            return p;
        }
    }
    const p = particlePool[ppIdx];
    ppIdx = (ppIdx + 1) % PP_SIZE;
    const ang = Math.random() * Math.PI * 2;
    const spd = 0.5 + Math.random() * 3;
    p.active = true; p.x = x; p.y = y;
    p.vx = Math.cos(ang) * spd; p.vy = Math.sin(ang) * spd;
    p.color = color; p.size = size; p.life = life; p.maxLife = life;
    return p;
}

// --- Damage Number Pool (100 slots) ---
const DP_SIZE = 100;
const dmgPool = new Array(DP_SIZE);
for (let i = 0; i < DP_SIZE; i++) {
    dmgPool[i] = { active: false, x: 0, y: 0, vy: -1.5, dmg: 0, life: 0 };
}
let dpIdx = 0;

function spawnDmgNum(x, y, dmg) {
    if (perfMode) return;
    for (let attempt = 0; attempt < DP_SIZE; attempt++) {
        const idx = (dpIdx + attempt) % DP_SIZE;
        if (!dmgPool[idx].active) {
            dpIdx = (idx + 1) % DP_SIZE;
            const d = dmgPool[idx];
            d.active = true; d.x = x; d.y = y; d.vy = -1.5; d.dmg = dmg; d.life = 1;
            return;
        }
    }
    const d = dmgPool[dpIdx];
    dpIdx = (dpIdx + 1) % DP_SIZE;
    d.active = true; d.x = x; d.y = y; d.vy = -1.5; d.dmg = dmg; d.life = 1;
}

// ===================================================================
//  OBSTACLE SPATIAL GRID — static, built once per game start
// ===================================================================
const obsGrid = new Map();
const _obsQueryBuf = new Array(64);
let _obsQueryLen = 0;

function buildObsGrid() {
    obsGrid.clear();
    for (const obs of obstacles) {
        if (obs.type === 'arena') continue;
        const x1 = Math.floor((obs.x - obs.w / 2) / CFG.OBS_GRID_CELL);
        const x2 = Math.floor((obs.x + obs.w / 2) / CFG.OBS_GRID_CELL);
        const y1 = Math.floor((obs.y - obs.h / 2) / CFG.OBS_GRID_CELL);
        const y2 = Math.floor((obs.y + obs.h / 2) / CFG.OBS_GRID_CELL);
        for (let gx = x1; gx <= x2; gx++) {
            for (let gy = y1; gy <= y2; gy++) {
                const key = (gx & 0xFFFF) << 16 | (gy & 0xFFFF);
                if (!obsGrid.has(key)) obsGrid.set(key, []);
                obsGrid.get(key).push(obs);
            }
        }
    }
}

function queryNearbyObs(x, y) {
    _obsQueryLen = 0;
    const gx = Math.floor(x / CFG.OBS_GRID_CELL);
    const gy = Math.floor(y / CFG.OBS_GRID_CELL);
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            const key = ((gx + dx) & 0xFFFF) << 16 | ((gy + dy) & 0xFFFF);
            const cell = obsGrid.get(key);
            if (!cell) continue;
            for (let i = 0; i < cell.length; i++) {
                if (_obsQueryLen < _obsQueryBuf.length) _obsQueryBuf[_obsQueryLen++] = cell[i];
            }
        }
    }
}

// ===================================================================
//  ENEMY SPATIAL GRID — dynamic, rebuilt every physics frame
//  Enables O(1) projectile-enemy collision (was O(n_enemies))
// ===================================================================
const EGRID_SIZE = Math.ceil(CFG.WORLD / CFG.EGRID_CELL) + 2;
const egridCells = new Array(EGRID_SIZE * EGRID_SIZE);
for (let i = 0; i < egridCells.length; i++) egridCells[i] = [];
const egridActive = [];
const _egBuf = new Int32Array(400);
let _egBufLen = 0;

function buildEnemyGrid() {
    // Clear only cells used last frame — zero-GC
    for (let a = 0; a < egridActive.length; a++) egridCells[egridActive[a]].length = 0;
    egridActive.length = 0;
    for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        const gx = Math.floor(e.x / CFG.EGRID_CELL);
        const gy = Math.floor(e.y / CFG.EGRID_CELL);
        if (gx < 0 || gx >= EGRID_SIZE || gy < 0 || gy >= EGRID_SIZE) continue;
        const key = gx * EGRID_SIZE + gy;
        if (egridCells[key].length === 0) egridActive.push(key);
        egridCells[key].push(i);
    }
}

function queryEnemiesNear(x, y) {
    _egBufLen = 0;
    const gx = Math.floor(x / CFG.EGRID_CELL);
    const gy = Math.floor(y / CFG.EGRID_CELL);
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            const cx = gx + dx, cy = gy + dy;
            if (cx < 0 || cx >= EGRID_SIZE || cy < 0 || cy >= EGRID_SIZE) continue;
            const cell = egridCells[cx * EGRID_SIZE + cy];
            for (let k = 0; k < cell.length; k++) {
                if (_egBufLen < 400) _egBuf[_egBufLen++] = cell[k];
            }
        }
    }
}

// ===================================================================
//  FPS MONITOR
// ===================================================================
const FPS_HIST = new Float32Array(60);
let fpsHistIdx = 0;
let currentFPS = 60;
let perfSuggestShown = false;

function updateFPS(dt) {
    FPS_HIST[fpsHistIdx++ % 60] = dt > 0 ? 1000 / dt : 60;
    if (fpsHistIdx % 30 === 0) {
        let sum = 0;
        for (let i = 0; i < 60; i++) sum += FPS_HIST[i];
        currentFPS = Math.round(sum / 60);
        document.getElementById('fpsHUD').textContent = currentFPS + 'fps';
        document.getElementById('settingsFPS').textContent = currentFPS;
        if (currentFPS < CFG.FPS_TARGET && !perfMode && !perfSuggestShown) {
            perfSuggestShown = true;
            showToast('⚠️ FPS bas ! Active le Mode Perf (⚙️)');
        }
    }
}

// ===================================================================
//  GLOBALS
// ===================================================================
let canvas, ctx;
let GS = 'menu';
let gameMode = 'solo';
let isHost = false;
let peer = null, connections = [], hostConn = null;
let myPeerId = '';
let roomPin = '';
let networkPing = 0;
let spectatorMode = false;
let perfMode = false;

// ===== PLAYER FACTORY =====
function mkPlayer() {
    return {
        x: CFG.WORLD / 2, y: CFG.WORLD / 2,
        vx: 0, vy: 0,
        speed: 3, health: 100, maxHealth: 100,
        damage: 12, fireRate: 500, lastShot: 0,
        xp: 0, level: 1, xpToLevel: 100,
        score: 0, kills: 0,
        name: 'Joueur', emoji: '😎', size: 24,
        alive: true,
        bonuses: {
            speed: 0, damage: 0, fireRate: 0, maxHp: 0,
            aura: 0, ricochet: 0, drones: 0, vampire: 0,
            magnet: 80, multishot: 0,
            // New bonuses
            wall: 0, mines: 0, boots: 0, recycle: 0,
        },
        droneAngle: 0,
        lastDroneFire: [0, 0, 0],
        _lastHit: 0,
    };
}
let player = mkPlayer();

let stats = {
    startTime: 0, survivalTime: 0,
    totalDamage: 0, killsByType: {},
    wave: 1, diffLevel: 1, lastDiff: 0,
};

let cam = { x: 0, y: 0, tx: 0, ty: 0, sx: 0, sy: 0, shake: 0 };
let ability = { lastUse: -CFG.ABILITY_CD };

// Entity arrays
let enemies = [];
let projectiles = [];
let gems = [];
let obstacles = [];
let remotePlayers = {};
let enemyIdCounter = 0;

// Mine system (new)
let playerMines = [];
let lastMineTime = 0;

// Frustum bounds
let scrL = 0, scrR = 0, scrT = 0, scrB = 0;

// Input
let keys = {};
let joystick = { active: false, dx: 0, dy: 0, touchId: null, baseX: 0, baseY: 0 };
let isMobile = /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent);

// Wave / spawn
let currentWave = 1;
let maxEnemies = 20;
let spawnRate = 2000;
let lastSpawnTime = 0;
let lastSyncTime = 0;
let lastTime = 0;
let respawnCountdown = 0;
let respawnInterval = null;

// ===================================================================
//  INIT
// ===================================================================
window.addEventListener('load', () => {
    canvas = document.getElementById('gameCanvas');
    ctx = canvas.getContext('2d');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    loadSaved();
    setupInput();
    setupMenu();
    setupSettings();
    registerSW();
    requestAnimationFrame(gameLoop);
});

function resizeCanvas() { canvas.width = innerWidth; canvas.height = innerHeight; }

// ===================================================================
//  SAVE / LOAD
// ===================================================================
function loadSaved() {
    document.getElementById('highScoreValue').textContent = localStorage.getItem('sio_hs') || '0';
    const tData = localStorage.getItem('sio_trophies');
    if (tData) {
        const ids = JSON.parse(tData);
        TROPHIES.forEach(t => { if (ids.includes(t.id)) t.unlocked = true; });
    }
    const cumK = parseInt(localStorage.getItem('sio_cumKills') || '0');
    if (cumK >= 1000) { const t = TROPHIES.find(t => t.id === 'butcher_1000'); if (t) t.unlocked = true; }
    refreshTrophyUI();
    perfMode = localStorage.getItem('sio_perf') === '1';
    applyPerfMode();
}

function saveTrophies() {
    localStorage.setItem('sio_trophies', JSON.stringify(TROPHIES.filter(t => t.unlocked).map(t => t.id)));
}

function saveHighScore(s) {
    const cur = parseInt(localStorage.getItem('sio_hs') || '0');
    if (s > cur) { localStorage.setItem('sio_hs', s); return true; }
    return false;
}

function refreshTrophyUI() {
    const unc = TROPHIES.filter(t => t.unlocked).length;
    document.getElementById('trophyCount').textContent = `${unc}/${TROPHIES.length}`;
    const prev = document.getElementById('trophiesPreview');
    prev.innerHTML = '';
    TROPHIES.forEach(t => {
        const s = document.createElement('span');
        s.className = 'trophy-mini' + (t.unlocked ? ' unlocked' : '');
        s.textContent = t.icon; s.title = t.name;
        prev.appendChild(s);
    });
}

// ===================================================================
//  MENU & SETTINGS SETUP
// ===================================================================
function setupMenu() {
    document.getElementById('btnCreateGame').onclick = createGame;
    document.getElementById('btnJoinGame').onclick = showJoin;
    document.getElementById('btnSoloGame').onclick = startSolo;
    document.getElementById('btnCancelJoin').onclick = hideJoin;
    document.getElementById('btnCancelHost').onclick = cancelHost;
    document.getElementById('btnCancelWait').onclick = cancelWait;
    document.getElementById('btnStartGame').onclick = () => { if (isHost) startMulti(); };
    document.getElementById('btnCopyPin').onclick = copyPin;
    document.getElementById('btnRestart').onclick = restartGame;
    document.getElementById('btnShareScore').onclick = shareScore;
    document.getElementById('btnConfirmJoin').onclick = () => {
        const v = document.getElementById('pinInput').value;
        if (v && v.toString().length === 6) joinGame(v.toString());
    };
    document.querySelectorAll('.emoji-btn').forEach(b => {
        b.onclick = () => {
            document.querySelectorAll('.emoji-btn').forEach(x => x.classList.remove('selected'));
            b.classList.add('selected');
            player.emoji = b.dataset.emoji;
        };
    });
    document.getElementById('playerName').oninput = e => { player.name = e.target.value.trim() || 'Joueur'; };
}

function setupSettings() {
    const openSettings = () => {
        document.getElementById('settingsPanel').classList.remove('hidden');
        const inGame = GS === 'playing' || GS === 'upgrade';
        document.getElementById('btnQuitGame').classList.toggle('hidden', !inGame);
        updateSettingsDisplay();
    };
    document.getElementById('btnSettingsMenu').onclick = openSettings;
    document.getElementById('btnSettingsHUD').onclick = openSettings;
    document.getElementById('btnCloseSettings').onclick = () => {
        document.getElementById('settingsPanel').classList.add('hidden');
    };
    document.getElementById('settingsPanel').onclick = e => {
        if (e.target === document.getElementById('settingsPanel'))
            document.getElementById('settingsPanel').classList.add('hidden');
    };
    document.getElementById('togglePerfMode').onclick = () => {
        perfMode = !perfMode;
        localStorage.setItem('sio_perf', perfMode ? '1' : '0');
        applyPerfMode();
        perfSuggestShown = false;
        updateSettingsDisplay();
    };
    document.getElementById('btnQuitGame').onclick = () => {
        document.getElementById('settingsPanel').classList.add('hidden');
        // Clean PeerJS disconnect then return to menu
        if (peer) { peer.destroy(); peer = null; }
        connections = []; remotePlayers = {}; hostConn = null;
        isHost = false; gameMode = 'solo'; GS = 'menu';
        spectatorMode = false;
        document.getElementById('gameOverScreen').classList.add('hidden');
        document.getElementById('gameUI').classList.add('hidden');
        document.getElementById('joystickZone').classList.add('hidden');
        document.getElementById('upgradeMenu').classList.add('hidden');
        showMainMenuControls();
        document.getElementById('menuScreen').classList.add('active');
        showToast('🚪 Partie quittée');
    };
}

function applyPerfMode() {
    const btn = document.getElementById('togglePerfMode');
    if (perfMode) {
        btn.textContent = 'ON'; btn.classList.add('on'); btn.classList.remove('off');
        document.getElementById('perfBadge').classList.remove('hidden');
    } else {
        btn.textContent = 'OFF'; btn.classList.remove('on'); btn.classList.add('off');
        document.getElementById('perfBadge').classList.add('hidden');
    }
}

function updateSettingsDisplay() {
    document.getElementById('settingsFPS').textContent = currentFPS;
    document.getElementById('settingsEnemies').textContent = enemies.length;
    let activeParticles = 0;
    for (let i = 0; i < PP_SIZE; i++) { if (particlePool[i].active) activeParticles++; }
    document.getElementById('settingsParticles').textContent = `${activeParticles}/${PP_SIZE}`;
}

function showJoin() {
    hideAllMenuSections();
    document.getElementById('joinSection').classList.remove('hidden');
    setTimeout(() => document.getElementById('pinInput').focus(), 100);
}
function hideJoin() {
    document.getElementById('joinSection').classList.add('hidden');
    showMainMenuControls();
}
function showHostUI(pin) {
    document.getElementById('hostPinCode').textContent = pin;
    hideAllMenuSections();
    document.getElementById('hostSection').classList.remove('hidden');
}
function showWaitUI() {
    hideAllMenuSections();
    document.getElementById('waitSection').classList.remove('hidden');
}
function cancelWait() {
    if (peer) peer.destroy(); peer = null;
    hostConn = null; remotePlayers = {};
    showMainMenuControls();
    document.getElementById('waitSection').classList.add('hidden');
}
function cancelHost() {
    if (peer) peer.destroy(); peer = null;
    connections = []; remotePlayers = {};
    document.getElementById('hostSection').classList.add('hidden');
    showMainMenuControls();
    isHost = false; gameMode = 'solo';
}
function hideAllMenuSections() {
    document.getElementById('customizationBlock').style.display = 'none';
    document.getElementById('mainButtons').style.display = 'none';
    document.getElementById('joinSection').classList.add('hidden');
    document.getElementById('hostSection').classList.add('hidden');
    document.getElementById('waitSection').classList.add('hidden');
}
function showMainMenuControls() {
    document.getElementById('customizationBlock').style.display = '';
    document.getElementById('mainButtons').style.display = '';
}
function copyPin() {
    navigator.clipboard.writeText(roomPin).then(() => showToast('📋 PIN copié !'));
}
function showToast(msg) {
    const old = document.querySelectorAll('.toast');
    old.forEach(d => d.remove());
    const d = document.createElement('div');
    d.className = 'toast'; d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 2400);
}

// ===================================================================
//  NETWORKING
// ===================================================================
function mkPIN() { return Math.floor(100000 + Math.random() * 900000).toString(); }

function createGame() {
    // Generate a random seed so all clients get the same deterministic world
    STRUCTURE_SEED = Math.floor(Math.random() * 99999) + 1;
    roomPin = mkPIN(); myPeerId = roomPin;
    peer = new Peer(myPeerId);
    peer.on('open', () => { isHost = true; gameMode = 'host'; showHostUI(roomPin); });
    peer.on('connection', conn => handleIncoming(conn));
    peer.on('error', err => { showToast('❌ Erreur: ' + err.type); cancelHost(); });
}

function handleIncoming(conn) {
    if (connections.length >= CFG.MAX_PLAYERS - 1) { conn.close(); return; }
    connections.push(conn);

    conn.on('open', () => {
        // === LOBBY HANDSHAKE: Send full existing player list to newcomer ===
        const lobbyData = buildLobbyPayload();
        conn.send(lobbyData);

        // If game already running: send world state for join-in-progress
        if (GS === 'playing' || GS === 'upgrade') {
            conn.send({
                t: 'join_state',
                seed: STRUCTURE_SEED,
                wave: currentWave,
                elapsed: Date.now() - stats.startTime,
                enemies: serializeEnemies(),
                gems: serializeGems(),
            });
        }
    });

    conn.on('data', d => handleHostMsg(d, conn));

    conn.on('close', () => {
        swapPop(connections, connections.indexOf(conn));
        delete remotePlayers[conn.peer];
        updateHostLobbyUI();
        broadcastLobby();
    });
}

function buildLobbyPayload() {
    return {
        t: 'lobby',
        host: { n: player.name, e: player.emoji, id: myPeerId },
        players: Object.keys(remotePlayers).reduce((acc, id) => {
            acc[id] = { n: remotePlayers[id].n, e: remotePlayers[id].e, id };
            return acc;
        }, {}),
    };
}

function broadcastLobby() {
    if (!isHost) return;
    const lb = buildLobbyPayload();
    connections.forEach(c => { if (c.open) c.send(lb); });
}

function handleHostMsg(d, conn) {
    if (d.t === 'pi') {
        const rp = remotePlayers[conn.peer];
        if (!rp) {
            remotePlayers[conn.peer] = {
                ...d.p, id: conn.peer,
                x: d.p.x, y: d.p.y, tx: d.p.x, ty: d.p.y,
                alive: true,
            };
            updateHostLobbyUI();
            // Broadcast full updated lobby to ALL clients including new one
            broadcastLobby();
        } else {
            rp.tx = d.p.x; rp.ty = d.p.y;
            rp.n = d.p.n; rp.e = d.p.e;
            rp.h = d.p.h; rp.sc = d.p.sc; rp.alive = d.p.alive;
        }
    } else if (d.t === 'sh') {
        if (GS === 'playing') {
            const rp = remotePlayers[conn.peer];
            if (rp && rp.alive) spawnProj(rp.x, rp.y, d.a, d.dm, 0, d.ri || 0, conn.peer);
        }
    } else if (d.t === 'ping') {
        conn.send({ t: 'pong', ts: d.ts });
    }
}

function joinGame(pin) {
    peer = new Peer();
    peer.on('open', () => {
        myPeerId = peer.id;
        hostConn = peer.connect(pin);
        hostConn.on('open', () => {
            gameMode = 'client';
            showWaitUI();
            sendPlayerInfo();
            startPing();
        });
        hostConn.on('data', d => handleClientMsg(d));
        hostConn.on('close', () => { if (GS === 'playing') endGame(); });
    });
    peer.on('error', () => { showToast('❌ Impossible de rejoindre'); hideJoin(); });
}

function handleClientMsg(d) {
    if (d.t === 'gs') {
        // === WORLD STATE SYNC: seed is first critical data ===
        if (d.seed) STRUCTURE_SEED = d.seed;
        startMultiClient();
    } else if (d.t === 'lobby') {
        updateClientWaitUI(d);
    } else if (d.t === 'join_state') {
        STRUCTURE_SEED = d.seed || STRUCTURE_SEED;
        buildStructures(STRUCTURE_SEED);
        stats.startTime = Date.now() - d.elapsed;
        currentWave = d.wave;
        updateEnemiesFromHost(d.enemies);
        updateGemsFromHost(d.gems);
        startGameUI();
    } else if (d.t === 'st') {
        updateEnemiesFromHost(d.e);
        updateGemsFromHost(d.g);
        updateRemotePlayers(d.p);
        if (d.w) currentWave = d.w;
    } else if (d.t === 'pong') {
        networkPing = Date.now() - d.ts;
    } else if (d.t === 'enemy_die') {
        removeEnemyById(d.ei);
        spawnGem(d.x, d.y, d.xp);
    } else if (d.t === 'wave') {
        currentWave = d.w;
        document.getElementById('waveDisplay').textContent = 'VAGUE ' + currentWave;
    }
}

function updateHostLobbyUI() {
    const list = document.getElementById('connectedPlayers');
    list.innerHTML = '';
    const all = [
        { n: player.name, e: player.emoji, id: 'hôte' },
        ...Object.values(remotePlayers).map(p => ({ n: p.n, e: p.e, id: p.id })),
    ];
    all.forEach(p => {
        const div = document.createElement('div');
        div.className = 'connected-player-item';
        div.innerHTML = `<span>${p.e}</span><span>${p.n}</span><span style="opacity:.4;font-size:.7rem">${String(p.id).slice(0, 8)}</span>`;
        list.appendChild(div);
    });
    const cnt = all.length;
    document.getElementById('playerCountBtn').textContent = `(${cnt}/10)`;
    document.getElementById('btnStartGame').textContent = `🚀 Démarrer (${cnt}/10)`;
}

function updateClientWaitUI(d) {
    const list = document.getElementById('waitPlayerList');
    list.innerHTML = '';
    const hostDiv = document.createElement('div');
    hostDiv.className = 'connected-player-item';
    hostDiv.innerHTML = `<span>${d.host.e}</span><span>${d.host.n}</span><span style="opacity:.4;font-size:.7rem">hôte</span>`;
    list.appendChild(hostDiv);
    Object.values(d.players).forEach(p => {
        if (p.id === myPeerId) return;
        const div = document.createElement('div');
        div.className = 'connected-player-item';
        div.innerHTML = `<span>${p.e}</span><span>${p.n}</span><span style="opacity:.4;font-size:.7rem">${String(p.id).slice(0, 8)}</span>`;
        list.appendChild(div);
    });
    document.getElementById('waitMsg').textContent = `${Object.keys(d.players).length + 1} joueur(s) dans le lobby`;
}

function updateEnemiesFromHost(he) {
    if (!he) return;
    he.forEach(h => {
        let e = enemies.find(e => e.id === h.i);
        if (!e) {
            const td = ET[h.ty] || ET.zombie;
            enemies.push({
                id: h.i, x: h.x, y: h.y, tx: h.x, ty: h.y,
                health: h.hp, maxHealth: h.mhp, type: h.ty,
                emoji: td.emoji, speed: h.s, damage: h.d, size: h.sz,
                color: td.color, ghost: td.ghost, shooter: td.shooter,
                charger: td.charger, toxic: td.toxic, spider: td.spider,
                angle2: 0, charging: false, chargeDir: 0, lastShot: 0, slowTimer: 0,
            });
        } else {
            e.tx = h.x; e.ty = h.y; e.health = h.hp;
        }
    });
    const ids = new Set(he.map(h => h.i));
    for (let i = enemies.length - 1; i >= 0; i--) {
        if (!ids.has(enemies[i].id)) swapPop(enemies, i);
    }
}

function updateGemsFromHost(hg) {
    if (!hg) return;
    hg.forEach(h => {
        const g = gems.find(g => g.id === h.i);
        if (!g) gems.push({ id: h.i, x: h.x, y: h.y, tx: h.x, ty: h.y, xp: h.xp, size: 8 });
        else { g.tx = h.x; g.ty = h.y; }
    });
    const ids = new Set(hg.map(h => h.i));
    for (let i = gems.length - 1; i >= 0; i--) {
        if (!ids.has(gems[i].id)) swapPop(gems, i);
    }
}

function updateRemotePlayers(pd) {
    if (!pd) return;
    Object.keys(pd).forEach(id => {
        if (id === myPeerId) return;
        const pp = pd[id];
        if (!remotePlayers[id]) {
            remotePlayers[id] = { ...pp, id, tx: pp.x, ty: pp.y, x: pp.x, y: pp.y, alive: pp.al !== false };
        } else {
            const rp = remotePlayers[id];
            rp.tx = pp.x; rp.ty = pp.y;
            rp.n = pp.n; rp.e = pp.e; rp.h = pp.h; rp.sc = pp.sc; rp.alive = pp.al !== false;
        }
    });
}

function sendPlayerInfo() {
    if (!hostConn || !hostConn.open) return;
    hostConn.send({
        t: 'pi',
        p: { x: Math.round(player.x), y: Math.round(player.y), n: player.name, e: player.emoji, h: Math.round(player.health), sc: player.score, alive: player.alive },
    });
}

function broadcastState() {
    if (!isHost) return;
    // === ZERO SYNC VISUELLE: Only positions, HP, kills — no particles/effects ===
    const state = { t: 'st', w: currentWave, e: serializeEnemies(), g: serializeGems(), p: buildPlayersPayload() };
    connections.forEach(c => { if (c.open) c.send(state); });
}

function serializeEnemies() {
    return enemies.map(e => ({ i: e.id, x: Math.round(e.x), y: Math.round(e.y), hp: Math.round(e.health), mhp: e.maxHealth, ty: e.type, s: e.speed, d: e.damage, sz: e.size }));
}
function serializeGems() {
    return gems.map(g => ({ i: g.id, x: Math.round(g.x), y: Math.round(g.y), xp: g.xp }));
}
function buildPlayersPayload() {
    const obj = {};
    obj[myPeerId] = { x: Math.round(player.x), y: Math.round(player.y), n: player.name, e: player.emoji, h: Math.round(player.health), sc: player.score, al: player.alive };
    Object.keys(remotePlayers).forEach(id => {
        const rp = remotePlayers[id];
        obj[id] = { x: Math.round(rp.x || 0), y: Math.round(rp.y || 0), n: rp.n, e: rp.e, h: rp.h || 100, sc: rp.sc || 0, al: rp.alive !== false };
    });
    return obj;
}

function startPing() {
    setInterval(() => { if (hostConn?.open) hostConn.send({ t: 'ping', ts: Date.now() }); }, 2000);
}

// ===================================================================
//  UTILITY
// ===================================================================
function swapPop(arr, idx) {
    if (idx < 0 || idx >= arr.length) return;
    arr[idx] = arr[arr.length - 1];
    arr.length--;
}

function removeEnemyById(id) {
    const idx = enemies.findIndex(e => e.id === id);
    if (idx !== -1) swapPop(enemies, idx);
}

function onScreen(x, y, sz) {
    return x + sz > scrL && x - sz < scrR && y + sz > scrT && y - sz < scrB;
}
function updateFrustum() {
    const m = CFG.CULL_MARGIN;
    scrL = cam.x - m; scrR = cam.x + canvas.width + m;
    scrT = cam.y - m; scrB = cam.y + canvas.height + m;
}

// ===================================================================
//  GAME START
// ===================================================================
function startSolo() { gameMode = 'solo'; isHost = false; STRUCTURE_SEED = Math.floor(Math.random() * 99999) + 1; initGame(); }
function startMulti() {
    if (!isHost) return;
    // === Send seed as FIRST data in 'gs' message for deterministic world ===
    connections.forEach(c => { if (c.open) c.send({ t: 'gs', seed: STRUCTURE_SEED }); });
    initGame();
}
function startMultiClient() { initGame(); }

function initGame() {
    player = mkPlayer();
    player.name = document.getElementById('playerName').value.trim() || 'Joueur';
    player.emoji = document.querySelector('.emoji-btn.selected')?.dataset.emoji || '😎';
    player.alive = true;
    spectatorMode = false;

    enemies.length = 0; projectiles.length = 0; gems.length = 0; obstacles.length = 0;
    playerMines.length = 0; lastMineTime = 0;

    for (let i = 0; i < PP_SIZE; i++) particlePool[i].active = false;
    for (let i = 0; i < DP_SIZE; i++) dmgPool[i].active = false;
    ppActive = 0;

    if (gameMode === 'solo') remotePlayers = {};

    currentWave = 1; maxEnemies = 20; spawnRate = 2000;
    lastSpawnTime = 0; enemyIdCounter = 0; lastSyncTime = 0;

    stats = { startTime: Date.now(), survivalTime: 0, totalDamage: 0, killsByType: {}, wave: 1, diffLevel: 1, lastDiff: Date.now() };

    buildStructures(STRUCTURE_SEED);
    buildObsGrid();

    GS = 'playing';
    startGameUI();
}

function startGameUI() {
    document.getElementById('menuScreen').classList.remove('active');
    document.getElementById('gameOverScreen').classList.add('hidden');
    document.getElementById('gameUI').classList.remove('hidden');
    document.getElementById('waitSection').classList.add('hidden');
    document.getElementById('hostSection').classList.add('hidden');
    if (isMobile || window.innerWidth < 900) document.getElementById('joystickZone').classList.remove('hidden');
    document.getElementById('spectatorBanner').classList.add('hidden');
    document.getElementById('playerEmoji').textContent = player.emoji;
    document.getElementById('playerNameDisplay').textContent = player.name;
}

// ===================================================================
//  WORLD GENERATION (deterministic — uses STRUCTURE_SEED)
// ===================================================================
function buildStructures(seed) {
    obstacles.length = 0;
    const rng = new Rng(seed);
    const W = CFG.WORLD;
    const structTypes = [
        { w: 200, h: 20,  emoji: '🧱', type: 'wall',     es: 1.0 },
        { w: 20,  h: 200, emoji: '🧱', type: 'wall',     es: 1.0 },
        { w: 40,  h: 40,  emoji: '📦', type: 'box',      es: 1.2 },
        { w: 80,  h: 80,  emoji: '🏠', type: 'house',    es: 1.8 },
        { w: 120, h: 120, emoji: '🏢', type: 'building', es: 2.5 },
        { w: 30,  h: 30,  emoji: '🌲', type: 'tree',     es: 1.2 },
        { w: 25,  h: 25,  emoji: '🌳', type: 'tree',     es: 1.2 },
    ];
    for (let i = 0; i < 350; i++) {
        const st = rng.pick(structTypes);
        const x = rng.range(100, W - 100);
        const y = rng.range(100, W - 100);
        if (Math.hypot(x - W / 2, y - W / 2) < 200) continue;
        obstacles.push({ x, y, w: st.w, h: st.h, emoji: st.emoji, type: st.type, es: st.es });
    }
    for (let i = 0; i < 8; i++) {
        const vert = rng.next() > 0.5;
        obstacles.push({ x: W / 2 + rng.range(-600, 600), y: W / 2 + rng.range(-600, 600), w: vert ? 20 : 180, h: vert ? 180 : 20, emoji: '🧱', type: 'wall', es: 1 });
    }
    obstacles.push({ x: W * 0.2, y: W * 0.2, w: 5, h: 5, emoji: '🏟️', type: 'arena', radius: 200, es: 3 });
    obstacles.push({ x: W * 0.8, y: W * 0.8, w: 5, h: 5, emoji: '🏟️', type: 'arena', radius: 180, es: 3 });
    for (let i = 0; i < 6; i++) {
        obstacles.push({ x: rng.range(200, W - 200), y: rng.range(200, W - 200), w: 60, h: 60, emoji: '⛽', type: 'gas', es: 1.6, explosive: true });
    }
}

// ===================================================================
//  INPUT
// ===================================================================
function setupInput() {
    addEventListener('keydown', e => {
        keys[e.key.toLowerCase()] = true;
        if (e.key === ' ' && (GS === 'playing')) { e.preventDefault(); useAbility(); }
    });
    addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

    const base = document.getElementById('joystickBase');
    const knob = document.getElementById('joystickKnob');

    canvas.addEventListener('touchstart', e => {
        e.preventDefault();
        Array.from(e.changedTouches).forEach(t => {
            if (t.clientX < innerWidth / 2 && !joystick.active) {
                joystick.active = true; joystick.touchId = t.identifier;
                joystick.baseX = t.clientX; joystick.baseY = t.clientY;
                joystick.dx = 0; joystick.dy = 0;
                base.style.left = (t.clientX - 65) + 'px';
                base.style.top  = (t.clientY - 65) + 'px';
                base.style.position = 'absolute';
                base.style.display = 'block';
                knob.style.transform = 'translate(-50%,-50%)';
            } else if (t.clientX >= innerWidth / 2 && GS === 'playing') {
                useAbility();
            }
        });
    }, { passive: false });

    canvas.addEventListener('touchmove', e => {
        e.preventDefault();
        Array.from(e.changedTouches).forEach(t => {
            if (t.identifier === joystick.touchId) {
                const dx = t.clientX - joystick.baseX;
                const dy = t.clientY - joystick.baseY;
                const dist = Math.min(52, Math.sqrt(dx * dx + dy * dy));
                const ang = Math.atan2(dy, dx);
                joystick.dx = Math.cos(ang) * dist / 52;
                joystick.dy = Math.sin(ang) * dist / 52;
                knob.style.transform = `translate(calc(-50% + ${Math.cos(ang) * dist}px), calc(-50% + ${Math.sin(ang) * dist}px))`;
            }
        });
    }, { passive: false });

    const endTouch = e => {
        e.preventDefault();
        Array.from(e.changedTouches).forEach(t => {
            if (t.identifier === joystick.touchId) {
                joystick.active = false; joystick.dx = 0; joystick.dy = 0; joystick.touchId = null;
                knob.style.transform = 'translate(-50%,-50%)';
            }
        });
    };
    canvas.addEventListener('touchend', endTouch, { passive: false });
    canvas.addEventListener('touchcancel', endTouch, { passive: false });
    document.getElementById('abilityBtn').onclick = useAbility;
}

// ===================================================================
//  ABILITY
// ===================================================================
function useAbility() {
    if (GS !== 'playing' || !player.alive) return;
    const now = Date.now();
    if (now - ability.lastUse < CFG.ABILITY_CD) return;
    ability.lastUse = now;
    // Use enemy grid for efficient blast radius check
    queryEnemiesNear(player.x, player.y);
    for (let k = 0; k < _egBufLen; k++) {
        const en = enemies[_egBuf[k]];
        if (!en) continue;
        if (Math.hypot(en.x - player.x, en.y - player.y) < 280) damageEnemy(en, 100, 'me');
    }
    shakeCamera(16);
    for (let i = 0; i < 35; i++) spawnParticle(player.x, player.y, '#f5576c', 3 + Math.random() * 5);
    showToast('💥 EXPLOSION !');
}

// ===================================================================
//  MAIN LOOP
// ===================================================================
function gameLoop(now) {
    const dt = Math.min(now - lastTime, 80);
    lastTime = now;

    if (GS === 'playing') {
        update(dt);
        render();
        updateFPS(dt);

        if (gameMode !== 'solo') {
            if (now - lastSyncTime > 100) { sendPlayerInfo(); lastSyncTime = now; }
            if (isHost && now - lastSyncTime > CFG.SYNC_RATE) { broadcastState(); lastSyncTime = now; }
        }
    } else if (GS === 'upgrade') {
        render();
    } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    requestAnimationFrame(gameLoop);
}

// ===================================================================
//  UPDATE
// ===================================================================
function update(dt) {
    stats.survivalTime = Date.now() - stats.startTime;

    // Difficulty scaling — 15% per wave
    if (gameMode !== 'client' && Date.now() - stats.lastDiff > CFG.DIFF_INTERVAL) {
        stats.diffLevel += CFG.DIFF_RATE;
        maxEnemies = Math.min(CFG.MAX_ENEMY_CAP, Math.floor(20 * stats.diffLevel));
        spawnRate = Math.max(300, 2000 / stats.diffLevel);
        stats.lastDiff = Date.now();
        currentWave++;
        stats.wave = currentWave;
        document.getElementById('waveDisplay').textContent = 'VAGUE ' + currentWave;
        if (isHost) connections.forEach(c => { if (c.open) c.send({ t: 'wave', w: currentWave }); });
        tryRespawn();
    }

    if (spectatorMode) updateSpectator(dt);
    else updatePlayer(dt);

    updateCamera(dt);
    updateAbilityUI();

    if (gameMode !== 'client') spawnEnemies();
    updateEnemies(dt);
    updateProjectiles(dt);
    updateGems(dt);
    updateParticlePool(dt);
    updateDmgPool(dt);
    lerpRemotePlayers();
    updateDrones(dt);
    updateMines(dt);

    // Build enemy grid before collision checks
    if (gameMode !== 'client') {
        buildEnemyGrid();
        checkProjEnemyCollisions();
        checkPlayerEnemyCollisions();
        checkGemCollection();
        updateWallOrbs(); // Wall orb damage uses enemy grid
    }

    updateHUD();
    checkTrophies();
}

// ===================================================================
//  PLAYER UPDATE
// ===================================================================
function updatePlayer(dt) {
    let mx = 0, my = 0;
    if (isMobile && joystick.active) { mx = joystick.dx; my = joystick.dy; }
    else {
        if (keys['z'] || keys['w'] || keys['arrowup'])    my -= 1;
        if (keys['s'] || keys['arrowdown'])                my += 1;
        if (keys['q'] || keys['a'] || keys['arrowleft'])  mx -= 1;
        if (keys['d'] || keys['arrowright'])               mx += 1;
    }
    const mag = Math.sqrt(mx * mx + my * my);
    if (mag > 0) { mx /= mag; my /= mag; }

    // Speed: base + bonus + boots (+30% per stack)
    const bootsSpeedMult = 1 + 0.3 * player.bonuses.boots;
    const spd = (player.speed + player.bonuses.speed) * bootsSpeedMult;
    player.x += mx * spd;
    player.y += my * spd;

    checkEntityObsCollision(player);

    player.x = Math.max(50, Math.min(CFG.WORLD - 50, player.x));
    player.y = Math.max(50, Math.min(CFG.WORLD - 50, player.y));

    if (player.health < player.maxHealth) player.health = Math.min(player.maxHealth, player.health + 0.02);

    // Aura damage
    if (player.bonuses.aura > 0) {
        const auraDmg = player.bonuses.aura * 0.5 * dt / 16;
        const auraR = 80 + player.bonuses.aura * 10;
        for (let i = enemies.length - 1; i >= 0; i--) {
            const en = enemies[i];
            if (Math.hypot(en.x - player.x, en.y - player.y) < auraR) damageEnemy(en, auraDmg, 'me');
        }
    }

    // Mine deposit
    if (player.bonuses.mines > 0) {
        const now = Date.now();
        if (now - lastMineTime > 3000) {
            lastMineTime = now;
            for (let m = 0; m < player.bonuses.mines; m++) {
                const offsetX = (m - Math.floor(player.bonuses.mines / 2)) * 30;
                playerMines.push({ x: player.x + offsetX, y: player.y, active: true });
            }
        }
    }

    autoShoot();
}

function updateSpectator(dt) {
    let mx = 0, my = 0;
    if (isMobile && joystick.active) { mx = joystick.dx; my = joystick.dy; }
    else {
        if (keys['z'] || keys['w'] || keys['arrowup'])    my -= 1;
        if (keys['s'] || keys['arrowdown'])                my += 1;
        if (keys['q'] || keys['a'] || keys['arrowleft'])  mx -= 1;
        if (keys['d'] || keys['arrowright'])               mx += 1;
    }
    const mag = Math.sqrt(mx * mx + my * my);
    if (mag > 0) { mx /= mag; my /= mag; }
    player.x = Math.max(0, Math.min(CFG.WORLD, player.x + mx * 4));
    player.y = Math.max(0, Math.min(CFG.WORLD, player.y + my * 4));
}

// ===================================================================
//  CAMERA
// ===================================================================
function updateCamera(dt) {
    cam.tx = player.x - canvas.width / 2;
    cam.ty = player.y - canvas.height / 2;
    cam.x += (cam.tx - cam.x) * CFG.CAM_LERP;
    cam.y += (cam.ty - cam.y) * CFG.CAM_LERP;
    if (cam.shake > 0) {
        cam.sx = (Math.random() - 0.5) * cam.shake;
        cam.sy = (Math.random() - 0.5) * cam.shake;
        cam.shake -= 1;
    } else { cam.sx = 0; cam.sy = 0; }
    updateFrustum();
}
function shakeCamera(amt) { cam.shake = Math.max(cam.shake, amt); }

// ===================================================================
//  AUTO SHOOT & DRONES
// ===================================================================
function autoShoot() {
    const fr = Math.max(100, player.fireRate - player.bonuses.fireRate);
    if (Date.now() - player.lastShot < fr) return;

    let nearest = null, nd = Infinity;
    for (const en of enemies) {
        const d = Math.hypot(en.x - player.x, en.y - player.y);
        if (d < nd && d < CFG.SHOOT_RANGE) { nearest = en; nd = d; }
    }
    if (!nearest) return;

    const ang = Math.atan2(nearest.y - player.y, nearest.x - player.x);
    const dmg = player.damage + player.bonuses.damage;
    spawnProj(player.x, player.y, ang, dmg, 5, player.bonuses.ricochet, 'me');

    for (let i = 1; i <= player.bonuses.multishot; i++) {
        const spread = i * 0.25 * (i % 2 === 0 ? 1 : -1);
        spawnProj(player.x, player.y, ang + spread, dmg, 5, player.bonuses.ricochet, 'me');
    }

    if (gameMode === 'client' && hostConn?.open) {
        hostConn.send({ t: 'sh', a: ang, dm: dmg, ri: player.bonuses.ricochet });
    }
    player.lastShot = Date.now();
}

function updateDrones(dt) {
    if (player.bonuses.drones <= 0) return;
    player.droneAngle += 0.02;
    for (let i = 0; i < player.bonuses.drones; i++) {
        if (Date.now() - player.lastDroneFire[i] < 1200) continue;
        const ang = player.droneAngle + i * Math.PI * 2 / player.bonuses.drones;
        const dx = player.x + Math.cos(ang) * 60;
        const dy = player.y + Math.sin(ang) * 60;
        let nearest = null, nd = Infinity;
        for (const en of enemies) {
            const d = Math.hypot(en.x - dx, en.y - dy);
            if (d < nd && d < 350) { nearest = en; nd = d; }
        }
        if (nearest) {
            const ta = Math.atan2(nearest.y - dy, nearest.x - dx);
            spawnProj(dx, dy, ta, player.damage + player.bonuses.damage, 4, 0, 'drone');
            player.lastDroneFire[i] = Date.now();
        }
    }
}

// ===================================================================
//  NEW BONUS SYSTEMS
// ===================================================================

// --- Wall Orbs: orbit player, damage + repel enemies on contact ---
function updateWallOrbs() {
    if (!player.alive || player.bonuses.wall <= 0) return;
    const orbCount = player.bonuses.wall;
    const orbRadius = 55;
    const now = Date.now();
    for (let i = 0; i < orbCount; i++) {
        const ang = (now * 0.0022) + i * (Math.PI * 2 / orbCount);
        const ox = player.x + Math.cos(ang) * orbRadius;
        const oy = player.y + Math.sin(ang) * orbRadius;
        // Check nearby enemies via enemy grid
        queryEnemiesNear(ox, oy);
        for (let k = 0; k < _egBufLen; k++) {
            const en = enemies[_egBuf[k]];
            if (!en) continue;
            const d = Math.hypot(en.x - ox, en.y - oy);
            if (d < 14 + en.size) {
                damageEnemy(en, 20, 'me');
                // Repulsion vector
                const ra = Math.atan2(en.y - oy, en.x - ox);
                en.x += Math.cos(ra) * 18;
                en.y += Math.sin(ra) * 18;
                en.x = Math.max(0, Math.min(CFG.WORLD, en.x));
                en.y = Math.max(0, Math.min(CFG.WORLD, en.y));
                if (onScreen(ox, oy, 20)) spawnParticle(en.x, en.y, '#4facfe', 3, 0.5);
            }
        }
    }
}

// --- Mines: auto-place every 3s, explode on enemy contact ---
function updateMines(dt) {
    if (playerMines.length === 0) return;
    for (let mi = playerMines.length - 1; mi >= 0; mi--) {
        const mine = playerMines[mi];
        if (!mine.active) { swapPop(playerMines, mi); continue; }
        // Check nearby enemies
        queryEnemiesNear(mine.x, mine.y);
        for (let k = 0; k < _egBufLen; k++) {
            const en = enemies[_egBuf[k]];
            if (!en) continue;
            if (Math.hypot(en.x - mine.x, en.y - mine.y) < 28 + en.size) {
                // EXPLODE — AOE 120px, 60 dmg
                for (let ei = enemies.length - 1; ei >= 0; ei--) {
                    if (Math.hypot(enemies[ei].x - mine.x, enemies[ei].y - mine.y) < 120) {
                        damageEnemy(enemies[ei], 60, 'me');
                    }
                }
                if (onScreen(mine.x, mine.y, 130)) {
                    for (let p = 0; p < 16; p++) spawnParticle(mine.x, mine.y, '#ff9800', 4 + Math.random() * 4);
                    for (let p = 0; p < 8; p++) spawnParticle(mine.x, mine.y, '#ffcc00', 5 + Math.random() * 3, 1.4);
                }
                shakeCamera(7);
                mine.active = false;
                break;
            }
        }
    }
}

// ===================================================================
//  PROJECTILES (swap-and-pop)
// ===================================================================
function spawnProj(x, y, angle, damage, size = 5, ricochet = 0, owner = 'me') {
    projectiles.push({
        x, y, angle,
        vx: Math.cos(angle) * 10, vy: Math.sin(angle) * 10,
        damage, size, owner, ricochet, bounces: 0,
    });
}

function updateProjectiles(dt) {
    for (let i = projectiles.length - 1; i >= 0; i--) {
        const p = projectiles[i];
        p.x += p.vx; p.y += p.vy;

        if (p.x < 0 || p.x > CFG.WORLD) { if (p.bounces < p.ricochet) { p.vx *= -1; p.bounces++; } else { swapPop(projectiles, i); continue; } }
        if (p.y < 0 || p.y > CFG.WORLD) { if (p.bounces < p.ricochet) { p.vy *= -1; p.bounces++; } else { swapPop(projectiles, i); continue; } }
        if (p.x < -100 || p.x > CFG.WORLD + 100 || p.y < -100 || p.y > CFG.WORLD + 100) { swapPop(projectiles, i); continue; }

        queryNearbyObs(p.x, p.y);
        let hitObs = false;
        for (let j = 0; j < _obsQueryLen; j++) {
            const obs = _obsQueryBuf[j];
            if (obs.type === 'gas' || obs.type === 'arena') continue;
            if (p.x >= obs.x - obs.w / 2 - 4 && p.x <= obs.x + obs.w / 2 + 4 &&
                p.y >= obs.y - obs.h / 2 - 4 && p.y <= obs.y + obs.h / 2 + 4) {
                if (p.bounces < p.ricochet) { p.vx *= -1; p.bounces++; }
                else hitObs = true;
                break;
            }
        }
        if (hitObs) { swapPop(projectiles, i); continue; }
    }
}

// ===================================================================
//  ENEMY SPAWN & UPDATE
// ===================================================================
function spawnEnemies() {
    if (Date.now() - lastSpawnTime < spawnRate) return;
    if (enemies.length >= maxEnemies) return;
    lastSpawnTime = Date.now();

    const typeList = ['zombie', 'zombie', 'zombie', 'ghost', 'ghost', 'alien', 'spider', 'fungus'];
    if (currentWave >= 3) typeList.push('minotaur');
    if (currentWave >= 5) typeList.push('minotaur', 'alien');

    const type = typeList[Math.floor(Math.random() * typeList.length)];
    const td = ET[type];
    const ang = Math.random() * Math.PI * 2;
    const dist = 600 + Math.random() * 200;
    const x = Math.max(50, Math.min(CFG.WORLD - 50, player.x + Math.cos(ang) * dist));
    const y = Math.max(50, Math.min(CFG.WORLD - 50, player.y + Math.sin(ang) * dist));
    // === AGGRESSIVE SCALING: 15% HP AND speed per diffLevel ===
    const hpScale = 1 + (stats.diffLevel - 1) * CFG.DIFF_RATE;
    const spdScale = 1 + (stats.diffLevel - 1) * 0.10;
    const hp = Math.round(td.hp * hpScale);

    enemies.push({
        id: 'e_' + (++enemyIdCounter),
        x, y, tx: x, ty: y,
        health: hp, maxHealth: hp,
        type, emoji: td.emoji, speed: td.spd * spdScale,
        damage: td.dmg, size: td.sz, color: td.color, xpValue: td.xp, scoreValue: td.sc,
        ghost: td.ghost, shooter: td.shooter, charger: td.charger, toxic: td.toxic, spider: td.spider,
        angle2: 0, charging: false, chargeDir: 0, chargeTimer: 0, lastShot: 0, slowTimer: 0,
    });
}

function updateEnemies(dt) {
    if (gameMode === 'client') {
        for (const e of enemies) {
            if (e.tx !== undefined) {
                e.x += (e.tx - e.x) * CFG.LERP;
                e.y += (e.ty - e.y) * CFG.LERP;
            }
            e.angle2 = (e.angle2 || 0) + 0.05;
        }
        return;
    }

    const now = Date.now();
    for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];

        const pdx = player.x - e.x, pdy = player.y - e.y;
        const pDist2 = pdx * pdx + pdy * pdy;
        if (pDist2 > 2200 * 2200) { e.angle2 = (e.angle2 || 0) + 0.02; continue; }

        let tx = player.x, ty = player.y;
        if (!player.alive || spectatorMode) {
            let bd = Infinity;
            Object.values(remotePlayers).forEach(rp => {
                if (rp.alive === false) return;
                const d2 = Math.hypot(rp.x - e.x, rp.y - e.y);
                if (d2 < bd) { bd = d2; tx = rp.x; ty = rp.y; }
            });
        }

        const dx = tx - e.x, dy = ty - e.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 0.01) continue;

        let spd = e.speed;
        if (e.slowTimer > 0) { spd *= 0.4; e.slowTimer -= dt; }

        if (e.charger) {
            // === STICK: reduced stop distance ===
            if (!e.charging && dist < 500) {
                e.charging = true; e.chargeDir = Math.atan2(dy, dx); e.chargeTimer = 700;
            }
            if (e.charging) {
                e.x += Math.cos(e.chargeDir) * spd * 3.5;
                e.y += Math.sin(e.chargeDir) * spd * 3.5;
                e.chargeTimer -= dt;
                if (e.chargeTimer <= 0) e.charging = false;
            } else {
                e.x += (dx / dist) * spd * 0.6;
                e.y += (dy / dist) * spd * 0.6;
            }
        } else if (e.shooter) {
            // === STICK: shooter stops at 180px (was 250), gets aggressive closer ===
            if (dist > 180) { e.x += (dx / dist) * spd; e.y += (dy / dist) * spd; }
            else { e.x -= (dx / dist) * spd * 0.15; e.y -= (dy / dist) * spd * 0.15; }
            if (now - e.lastShot > 1800 && dist < 320) {
                spawnProj(e.x, e.y, Math.atan2(dy, dx), e.damage, 6, 0, e.id);
                e.lastShot = now;
            }
        } else {
            // === Regular enemies always move toward player (no stop) ===
            e.x += (dx / dist) * spd;
            e.y += (dy / dist) * spd;
        }

        if (!e.ghost) checkEntityObsCollision(e);

        // Enemy separation — windowed scan
        if (onScreen(e.x, e.y, 200)) {
            const W = CFG.SEP_WINDOW;
            const start = Math.max(0, i - W);
            const end = Math.min(enemies.length - 1, i + W);
            for (let j = start; j <= end; j++) {
                if (j === i) continue;
                const oth = enemies[j];
                const sdx = e.x - oth.x, sdy = e.y - oth.y;
                const sd2 = sdx * sdx + sdy * sdy;
                const minD = (e.size + oth.size) * 0.7; // Reduced: enemies clump tighter
                if (sd2 < minD * minD && sd2 > 0.0001) {
                    const sd = Math.sqrt(sd2);
                    const force = (minD - sd) / minD * CFG.SEP_FORCE;
                    e.x += (sdx / sd) * force;
                    e.y += (sdy / sd) * force;
                }
            }
        }

        e.x = Math.max(0, Math.min(CFG.WORLD, e.x));
        e.y = Math.max(0, Math.min(CFG.WORLD, e.y));
        e.angle2 = (e.angle2 || 0) + 0.05;

        // Toxic cloud
        if (e.toxic && dist < 120 && player.alive && !spectatorMode) {
            player.health -= 0.02 * dt / 16; // increased toxic dmg
            if (Math.random() < 0.03 && onScreen(e.x, e.y, 30))
                spawnParticle(e.x + (Math.random() - 0.5) * 30, e.y + (Math.random() - 0.5) * 30, '#a5d6a7', 4, 0.6);
        }
    }
}

// ===================================================================
//  COLLISION HELPERS
// ===================================================================
function checkEntityObsCollision(entity) {
    queryNearbyObs(entity.x, entity.y);
    for (let i = 0; i < _obsQueryLen; i++) {
        const obs = _obsQueryBuf[i];
        if (obs.type === 'arena' || obs.type === 'gas') continue;
        const el = entity.x - entity.size, er = entity.x + entity.size;
        const et = entity.y - entity.size, eb = entity.y + entity.size;
        const ol = obs.x - obs.w / 2, or_ = obs.x + obs.w / 2;
        const ot = obs.y - obs.h / 2, ob_ = obs.y + obs.h / 2;
        if (er > ol && el < or_ && eb > ot && et < ob_) {
            const ox = Math.min(er - ol, or_ - el);
            const oy = Math.min(eb - ot, ob_ - et);
            if (ox < oy) { entity.x += entity.x < obs.x ? -ox : ox; }
            else { entity.y += entity.y < obs.y ? -oy : oy; }
        }
    }
}

// === OPTIMIZED: Uses enemy spatial grid instead of O(n_enemies) ===
function checkProjEnemyCollisions() {
    for (let pi = projectiles.length - 1; pi >= 0; pi--) {
        const proj = projectiles[pi];
        if (!onScreen(proj.x, proj.y, 80)) continue;

        queryEnemiesNear(proj.x, proj.y);
        let hit = false;
        for (let k = 0; k < _egBufLen; k++) {
            const ei = _egBuf[k];
            const en = enemies[ei];
            if (!en) continue;
            const dist = Math.hypot(proj.x - en.x, proj.y - en.y);
            if (dist < en.size + proj.size) {
                damageEnemy(en, proj.damage, proj.owner);
                if (proj.bounces < proj.ricochet) {
                    let nxt = null, nd = Infinity;
                    for (let j = 0; j < enemies.length; j++) {
                        if (j === ei) continue;
                        const d2 = Math.hypot(en.x - enemies[j].x, en.y - enemies[j].y);
                        if (d2 < nd) { nd = d2; nxt = enemies[j]; }
                    }
                    if (nxt) {
                        const ra = Math.atan2(nxt.y - en.y, nxt.x - en.x);
                        spawnProj(en.x, en.y, ra, proj.damage, proj.size, proj.ricochet, proj.owner);
                    }
                }
                swapPop(projectiles, pi);
                hit = true;
                break;
            }
        }
        if (hit) continue;
    }
}

function checkPlayerEnemyCollisions() {
    if (!player.alive || spectatorMode) return;
    const now = Date.now();
    // === STICK: reduced hit cooldown (300ms was 500ms), higher damage ===
    queryEnemiesNear(player.x, player.y);
    for (let k = 0; k < _egBufLen; k++) {
        const en = enemies[_egBuf[k]];
        if (!en) continue;
        if (!onScreen(en.x, en.y, en.size + player.size + 10)) continue;
        if (Math.hypot(en.x - player.x, en.y - player.y) < en.size + player.size) {
            if (now - player._lastHit > 300) {
                // Boots increase incoming damage
                const bootsMult = 1 + 0.1 * player.bonuses.boots;
                player.health -= en.damage * 0.5 * bootsMult;
                player._lastHit = now;
                shakeCamera(6);
                spawnParticle(player.x, player.y, '#ff4444', 3);
            }
        }
        // Spider slow web
        if (en.spider && Math.hypot(en.x - player.x, en.y - player.y) < en.size * 2.5) {
            player.x += (player.x - en.x) * 0.001;
        }
    }
    if (player.health <= 0) {
        player.health = 0;
        if (gameMode === 'solo') endGame();
        else enterSpectatorMode();
    }
}

function checkGemCollection() {
    if (!player.alive || spectatorMode) return;
    const magnetR = 80 + player.bonuses.magnet;
    for (let i = gems.length - 1; i >= 0; i--) {
        const g = gems[i];
        const dist = Math.hypot(g.x - player.x, g.y - player.y);
        if (dist < magnetR) {
            g.x += (player.x - g.x) * 0.12;
            g.y += (player.y - g.y) * 0.12;
        }
        if (dist < player.size + g.size) {
            addXP(g.xp);
            // === RECYCLAGE VERT: 5% * recycle count chance to heal 1 HP ===
            if (player.bonuses.recycle > 0 && Math.random() < 0.05 * player.bonuses.recycle) {
                player.health = Math.min(player.maxHealth, player.health + 1);
                if (onScreen(g.x, g.y, 20)) spawnParticle(g.x, g.y, '#2ecc71', 3, 0.8);
            }
            swapPop(gems, i);
        }
    }
}

function damageEnemy(en, dmg, attackerId) {
    en.health -= dmg;
    if (attackerId === 'me' || attackerId === myPeerId) stats.totalDamage += dmg;
    if (onScreen(en.x, en.y, en.size + 30)) spawnDmgNum(en.x, en.y - en.size, Math.round(dmg));
    shakeCamera(1);
    if (en.health <= 0) killEnemy(en, attackerId);
}

function killEnemy(en, killerId) {
    if (killerId === 'me' || killerId === myPeerId || gameMode === 'solo') {
        player.kills++;
        player.score += en.scoreValue;
        stats.killsByType[en.type] = (stats.killsByType[en.type] || 0) + 1;
        if (player.bonuses.vampire > 0) player.health = Math.min(player.maxHealth, player.health + player.bonuses.vampire);
    }
    if (isHost) {
        connections.forEach(c => { if (c.open) c.send({ t: 'enemy_die', ei: en.id, x: Math.round(en.x), y: Math.round(en.y), xp: en.xpValue }); });
    }
    spawnGem(en.x, en.y, en.xpValue);
    // === ZERO SYNC VISUELLE: Particles generated locally, never sent over network ===
    if (onScreen(en.x, en.y, en.size + 20))
        for (let i = 0; i < 8; i++) spawnParticle(en.x, en.y, en.color, 3 + Math.random() * 4);
    const idx = enemies.indexOf(en);
    if (idx !== -1) swapPop(enemies, idx);
}

function spawnGem(x, y, xp) {
    gems.push({ id: 'g_' + Date.now() + '_' + (Math.random() * 1000 | 0), x, y, tx: x, ty: y, xp, size: 8 });
}

function addXP(xp) {
    player.xp += xp;
    while (player.xp >= player.xpToLevel) {
        player.xp -= player.xpToLevel;
        player.xpToLevel = Math.floor(player.xpToLevel * 1.3);
        player.level++;
        showUpgradeMenu();
    }
}

// ===================================================================
//  GEMS & PARTICLE POOL UPDATE
// ===================================================================
function updateGems(dt) {
    for (const g of gems) {
        if (g.tx !== undefined) {
            g.x += (g.tx - g.x) * CFG.LERP;
            g.y += (g.ty - g.y) * CFG.LERP;
        }
    }
}

function updateParticlePool(dt) {
    ppActive = 0;
    for (let i = 0; i < PP_SIZE; i++) {
        const p = particlePool[i];
        if (!p.active) continue;
        p.x += p.vx; p.y += p.vy;
        p.vx *= 0.92; p.vy *= 0.92;
        p.life -= 0.025 * dt / 16;
        if (p.life <= 0) p.active = false;
        else ppActive++;
    }
}

function updateDmgPool(dt) {
    for (let i = 0; i < DP_SIZE; i++) {
        const d = dmgPool[i];
        if (!d.active) continue;
        d.y += d.vy;
        d.life -= 0.025 * dt / 16;
        if (d.life <= 0) d.active = false;
    }
}

function lerpRemotePlayers() {
    Object.values(remotePlayers).forEach(rp => {
        if (rp.x === undefined) { rp.x = rp.tx || 0; rp.y = rp.ty || 0; return; }
        rp.x += ((rp.tx || rp.x) - rp.x) * CFG.LERP;
        rp.y += ((rp.ty || rp.y) - rp.y) * CFG.LERP;
    });
}

// ===================================================================
//  SPECTATOR MODE
// ===================================================================
function enterSpectatorMode() {
    spectatorMode = true;
    player.alive = false;
    document.getElementById('spectatorBanner').classList.remove('hidden');
    respawnCountdown = CFG.RESPAWN_TIME;
    clearInterval(respawnInterval);
    respawnInterval = setInterval(() => {
        respawnCountdown -= 1000;
        const secs = Math.ceil(respawnCountdown / 1000);
        document.getElementById('respawnTimer').textContent = `Réapparition dans ${secs}s`;
        if (respawnCountdown <= 0) { clearInterval(respawnInterval); doRespawn(); }
    }, 1000);
    showToast('👻 Mode Spectateur activé');
}

function tryRespawn() {
    if (spectatorMode) { clearInterval(respawnInterval); doRespawn(); }
}

function doRespawn() {
    player = mkPlayer();
    player.name = document.getElementById('playerName').value.trim() || 'Joueur';
    player.emoji = document.querySelector('.emoji-btn.selected')?.dataset.emoji || '😎';
    player.alive = true;
    spectatorMode = false;
    player.x = CFG.WORLD / 2 + (Math.random() - 0.5) * 200;
    player.y = CFG.WORLD / 2 + (Math.random() - 0.5) * 200;
    document.getElementById('spectatorBanner').classList.add('hidden');
    showToast('✅ Réapparition ! Niveau 1 — bonne chance !');
}

// ===================================================================
//  UPGRADE MENU
// ===================================================================
function showUpgradeMenu() {
    GS = 'upgrade';
    const menu = document.getElementById('upgradeMenu');
    const opts = document.getElementById('upgradeOptions');
    menu.classList.remove('hidden');
    opts.innerHTML = '';
    const shuffled = [...BONUS_DEFS].sort(() => Math.random() - 0.5).slice(0, 3);
    shuffled.forEach(b => {
        const div = document.createElement('div');
        div.className = 'upgrade-option';
        const curVal = player.bonuses[b.id] || 0;
        div.innerHTML = `<span class="upgrade-icon">${b.icon}</span><div class="upgrade-text"><div class="upgrade-name">${b.name}</div><div class="upgrade-desc">${b.desc}</div><div class="upgrade-stack">${b.stack} · Actuel: ${curVal}</div></div>`;
        div.onclick = () => {
            b.apply(player);
            menu.classList.add('hidden');
            GS = 'playing';
            refreshActiveBonuses();
        };
        opts.appendChild(div);
    });
}

function refreshActiveBonuses() {
    const ab = document.getElementById('activeBonus');
    ab.innerHTML = '';
    const b = player.bonuses;
    const show = (icon, val, label) => {
        if (!val) return;
        const d = document.createElement('div');
        d.className = 'bonus-pill'; d.textContent = `${icon}×${val}`; d.title = label;
        ab.appendChild(d);
    };
    show('🏃', b.speed, 'Vitesse'); show('⚔️', b.damage, 'Dégâts'); show('⚡', b.fireRate, 'Cadence');
    show('❤️', b.maxHp, 'HP Max'); show('🔥', b.aura, 'Aura'); show('🎱', b.ricochet, 'Ricochet');
    show('🤖', b.drones, 'Drones'); show('🧛', b.vampire, 'Vampire'); show('🧲', b.magnet - 80, 'Magnét.');
    show('💫', b.multishot, 'Multi-tir');
    // New bonuses
    show('🔵', b.wall, 'Mur'); show('💣', b.mines, 'Mines'); show('👟', b.boots, 'Bottes'); show('♻️', b.recycle, 'Recyclage');
}

// ===================================================================
//  HUD UPDATE
// ===================================================================
function updateHUD() {
    document.getElementById('healthDisplay').textContent   = Math.max(0, Math.ceil(player.health));
    document.getElementById('damageDisplay').textContent   = player.damage + player.bonuses.damage;
    document.getElementById('killCount').textContent       = player.kills;
    document.getElementById('scoreDisplay').textContent    = player.score;
    document.getElementById('levelDisplay').textContent    = 'NIV.' + player.level;
    document.getElementById('xpDisplay').textContent       = `${player.xp}/${player.xpToLevel} XP`;
    document.getElementById('xpFill').style.width          = (player.xp / player.xpToLevel * 100) + '%';
    document.getElementById('playerCountDisplay').textContent = 1 + Object.keys(remotePlayers).length;
    document.getElementById('pingText').textContent        = networkPing + 'ms';
    document.getElementById('enemyCount').textContent      = enemies.length + ' ENNEMIS';
    updateLeaderboard();
    renderMinimap();
}

function updateAbilityUI() {
    const elapsed = Date.now() - ability.lastUse;
    const pct = Math.min(1, elapsed / CFG.ABILITY_CD);
    const circ = 2 * Math.PI * 44;
    document.getElementById('cooldownCircle').style.strokeDashoffset = circ * (1 - pct);
}

function updateLeaderboard() {
    const players = [
        { name: player.name, emoji: player.emoji, score: player.score, alive: player.alive, me: true },
        ...Object.values(remotePlayers).map(rp => ({ name: rp.n, emoji: rp.e, score: rp.sc || 0, alive: rp.alive !== false, me: false })),
    ].sort((a, b) => b.score - a.score).slice(0, 10);

    const lbc = document.getElementById('leaderboardContent');
    lbc.innerHTML = '';
    players.forEach((p, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1);
        const row = document.createElement('div');
        row.className = 'lb-row' + (p.me ? ' lb-me' : '') + (!p.alive ? ' lb-dead' : '');
        row.innerHTML = `<span class="lb-rank">${medal}</span><span class="lb-emoji">${p.emoji}</span><span class="lb-name">${p.name}</span><span class="lb-score">${p.score}</span>`;
        lbc.appendChild(row);
    });
}

function renderMinimap() {
    const mc = document.getElementById('minimapCanvas');
    const mctx = mc.getContext('2d');
    const S = 120, scale = S / CFG.WORLD;

    mctx.fillStyle = 'rgba(0,0,0,0.85)';
    mctx.fillRect(0, 0, S, S);

    mctx.fillStyle = 'rgba(30,60,30,0.3)';  mctx.fillRect(0, 0, S, S / 2);
    mctx.fillStyle = 'rgba(60,50,20,0.3)';  mctx.fillRect(0, S / 2, S, S / 2);
    mctx.fillStyle = 'rgba(20,20,60,0.3)';  mctx.fillRect(S / 3, S / 4, S / 3, S / 2);

    mctx.fillStyle = 'rgba(255,255,255,0.12)';
    for (const obs of obstacles) {
        if (obs.type === 'arena') continue;
        mctx.fillRect(obs.x * scale - 1, obs.y * scale - 1, 2, 2);
    }
    mctx.fillStyle = '#f5576c';
    for (const e of enemies) {
        mctx.beginPath(); mctx.arc(e.x * scale, e.y * scale, 1.5, 0, Math.PI * 2); mctx.fill();
    }
    Object.values(remotePlayers).forEach(rp => {
        if (rp.alive === false) return;
        mctx.fillStyle = '#2ecc71';
        mctx.beginPath(); mctx.arc((rp.x || 0) * scale, (rp.y || 0) * scale, 3, 0, Math.PI * 2); mctx.fill();
    });
    mctx.fillStyle = spectatorMode ? 'rgba(255,255,255,0.4)' : '#667eea';
    mctx.beginPath(); mctx.arc(player.x * scale, player.y * scale, 4, 0, Math.PI * 2); mctx.fill();

    mctx.strokeStyle = 'rgba(255,255,255,0.3)'; mctx.lineWidth = 1.5;
    mctx.strokeRect(0, 0, S, S);
}

// ===================================================================
//  TROPHIES
// ===================================================================
function checkTrophies() {
    TROPHIES.forEach(t => {
        if (t.unlocked) return;
        if (t.check(stats, player)) {
            t.unlocked = true;
            saveTrophies();
            showToast(`🏅 Trophée: ${t.icon} ${t.name}`);
        }
    });
}

// ===================================================================
//  RENDER — frustum culling + batch rendering
// ===================================================================
function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(-cam.x + (cam.sx || 0), -cam.y + (cam.sy || 0));

    drawWorld();
    drawMines();
    drawGems();
    drawEnemiesBatched();
    drawProjectiles();
    drawWallOrbs();
    drawPlayers();
    drawParticlePool();
    drawDmgPool();
    drawDrones();

    ctx.restore();
}

function drawWorld() {
    const W = CFG.WORLD;
    const grad = ctx.createLinearGradient(0, 0, 0, W);
    grad.addColorStop(0,   '#0d1a0d');
    grad.addColorStop(0.4, '#1a1a2e');
    grad.addColorStop(0.7, '#1a1a2e');
    grad.addColorStop(1,   '#2a2010');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, W);

    ctx.strokeStyle = 'rgba(255,255,255,0.025)'; ctx.lineWidth = 1;
    const gStep = 200;
    const startX = Math.floor(scrL / gStep) * gStep;
    const startY = Math.floor(scrT / gStep) * gStep;
    for (let x = startX; x < scrR; x += gStep) {
        ctx.beginPath(); ctx.moveTo(x, scrT); ctx.lineTo(x, scrB); ctx.stroke();
    }
    for (let y = startY; y < scrB; y += gStep) {
        ctx.beginPath(); ctx.moveTo(scrL, y); ctx.lineTo(scrR, y); ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255,60,60,0.6)'; ctx.lineWidth = 6;
    ctx.strokeRect(2, 2, W - 4, W - 4);

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const obs of obstacles) {
        if (!onScreen(obs.x, obs.y, Math.max(obs.w || 200, obs.h || 200))) continue;

        if (obs.type === 'arena') {
            if (!perfMode) { ctx.strokeStyle = 'rgba(255,200,50,0.3)'; ctx.lineWidth = 3; }
            else { ctx.strokeStyle = 'rgba(255,200,50,0.2)'; ctx.lineWidth = 1; }
            ctx.beginPath(); ctx.arc(obs.x, obs.y, obs.radius || 150, 0, Math.PI * 2); ctx.stroke();
            if (!perfMode) {
                ctx.font = `${(obs.radius || 150) * 0.18}px serif`;
                ctx.fillText(obs.emoji, obs.x, obs.y - (obs.radius || 150) * 0.7);
            }
            continue;
        }

        if (!perfMode) {
            ctx.fillStyle = 'rgba(0,0,0,0.35)';
            ctx.fillRect(obs.x - obs.w / 2 + 4, obs.y - obs.h / 2 + 4, obs.w, obs.h);
        }

        ctx.fillStyle = obs.type === 'wall' ? 'rgba(80,80,100,0.6)' :
                        obs.type === 'building' ? 'rgba(40,40,80,0.7)' :
                        obs.type === 'gas' ? 'rgba(255,200,50,0.2)' : 'rgba(60,60,80,0.4)';
        ctx.fillRect(obs.x - obs.w / 2, obs.y - obs.h / 2, obs.w, obs.h);

        const fs = Math.max(12, Math.min(40, Math.min(obs.w, obs.h) * (obs.es || 1.0) * 0.6));
        ctx.font = fs + 'px serif';
        ctx.fillText(obs.emoji, obs.x, obs.y);
    }
}

// === GREEN GEMS ===
function drawGems() {
    if (gems.length === 0) return;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const t = Date.now();
    for (const g of gems) {
        if (!onScreen(g.x, g.y, 20)) continue;
        if (!perfMode) {
            const pulse = 1 + Math.sin(t * 0.005 + g.x) * 0.15;
            ctx.shadowBlur = 14; ctx.shadowColor = '#2ecc71';
            ctx.fillStyle = '#2ecc71';
            ctx.beginPath();
            // Diamond shape
            const r = g.size * pulse;
            ctx.moveTo(g.x, g.y - r);
            ctx.lineTo(g.x + r * 0.7, g.y);
            ctx.lineTo(g.x, g.y + r);
            ctx.lineTo(g.x - r * 0.7, g.y);
            ctx.closePath(); ctx.fill();
            ctx.shadowBlur = 0;
        } else {
            ctx.fillStyle = '#2ecc71';
            ctx.beginPath(); ctx.arc(g.x, g.y, g.size, 0, Math.PI * 2); ctx.fill();
        }
    }
}

// === BATCH ENEMY RENDERING — ctx.font set once per type ===
function drawEnemiesBatched() {
    if (enemies.length === 0) return;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

    const groups = {};
    const visible = [];
    for (const en of enemies) {
        if (!onScreen(en.x, en.y, en.size + 20)) continue;
        visible.push(en);
        if (!groups[en.type]) groups[en.type] = [];
        groups[en.type].push(en);
    }

    if (!perfMode) {
        for (const [type, batch] of Object.entries(groups)) {
            const td = ET[type];
            ctx.shadowBlur = 8;
            ctx.shadowColor = td.col;
            ctx.font = ET_FONT[type]; // Set ONCE per batch — major perf win for 600 enemies
            for (const en of batch) {
                if (en.ghost) ctx.globalAlpha = 0.7;
                ctx.fillText(td.emoji, en.x, en.y);
                ctx.globalAlpha = 1;
            }
            ctx.shadowBlur = 0;

            if (td.toxic) {
                for (const en of batch) {
                    ctx.fillStyle = 'rgba(165,214,167,0.15)';
                    ctx.beginPath(); ctx.arc(en.x, en.y, 70, 0, Math.PI * 2); ctx.fill();
                }
            }
        }
    } else {
        for (const [type, batch] of Object.entries(groups)) {
            const td = ET[type];
            ctx.fillStyle = td.col;
            for (const en of batch) {
                if (en.ghost) ctx.globalAlpha = 0.6;
                ctx.beginPath(); ctx.arc(en.x, en.y, en.size, 0, Math.PI * 2); ctx.fill();
                ctx.globalAlpha = 1;
            }
        }
    }

    // HP bars — batched: dark bg first, fill second
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    for (const en of visible) {
        const bw = en.size * 2.5, bh = 5;
        ctx.fillRect(en.x - bw / 2, en.y - en.size - 12, bw, bh);
    }
    for (const en of visible) {
        const bw = en.size * 2.5, bh = 5;
        const hPct = en.health / en.maxHealth;
        ctx.fillStyle = hPct > 0.6 ? '#2ecc71' : hPct > 0.3 ? '#ffa500' : '#f5576c';
        ctx.fillRect(en.x - bw / 2, en.y - en.size - 12, bw * hPct, bh);
    }
}

function drawProjectiles() {
    if (projectiles.length === 0) return;
    for (const proj of projectiles) {
        if (!onScreen(proj.x, proj.y, proj.size + 10)) continue;
        if (!perfMode) {
            const grad = ctx.createRadialGradient(proj.x, proj.y, 0, proj.x, proj.y, proj.size * 3);
            grad.addColorStop(0, 'rgba(255,220,50,0.9)');
            grad.addColorStop(1, 'rgba(255,180,0,0)');
            ctx.fillStyle = grad;
            ctx.beginPath(); ctx.arc(proj.x, proj.y, proj.size * 3, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = '#ffe082';
        ctx.beginPath(); ctx.arc(proj.x, proj.y, proj.size, 0, Math.PI * 2); ctx.fill();
    }
}

// === Draw Wall Orbs (new) ===
function drawWallOrbs() {
    if (!player.alive || player.bonuses.wall <= 0) return;
    const orbCount = player.bonuses.wall;
    const orbRadius = 55;
    const now = Date.now();
    if (!perfMode) { ctx.shadowBlur = 16; ctx.shadowColor = '#4facfe'; }
    for (let i = 0; i < orbCount; i++) {
        const ang = (now * 0.0022) + i * (Math.PI * 2 / orbCount);
        const ox = player.x + Math.cos(ang) * orbRadius;
        const oy = player.y + Math.sin(ang) * orbRadius;
        if (!onScreen(ox, oy, 16)) continue;
        // Orbit trail
        if (!perfMode) {
            ctx.strokeStyle = 'rgba(79,172,254,0.25)'; ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 6]);
            ctx.beginPath(); ctx.arc(player.x, player.y, orbRadius, 0, Math.PI * 2); ctx.stroke();
            ctx.setLineDash([]);
        }
        // Orb
        ctx.fillStyle = '#4facfe';
        ctx.beginPath(); ctx.arc(ox, oy, 11, 0, Math.PI * 2); ctx.fill();
        if (!perfMode) {
            ctx.fillStyle = 'rgba(200,230,255,0.8)';
            ctx.beginPath(); ctx.arc(ox - 3, oy - 3, 4, 0, Math.PI * 2); ctx.fill();
        }
    }
    if (!perfMode) ctx.shadowBlur = 0;
}

// === Draw Mines (new) ===
function drawMines() {
    if (playerMines.length === 0) return;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const mine of playerMines) {
        if (!mine.active || !onScreen(mine.x, mine.y, 18)) continue;
        if (!perfMode) { ctx.shadowBlur = 8; ctx.shadowColor = '#ff9800'; }
        ctx.font = '20px serif';
        ctx.fillText('💣', mine.x, mine.y);
        if (!perfMode) ctx.shadowBlur = 0;
        // Danger radius indicator
        if (!perfMode) {
            ctx.strokeStyle = 'rgba(255,100,0,0.2)'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(mine.x, mine.y, 120, 0, Math.PI * 2); ctx.stroke();
        }
    }
}

function drawPlayers() {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    drawPlayerSprite(player, true);
    Object.values(remotePlayers).forEach(rp => {
        if (rp.x === undefined) return;
        if (!onScreen(rp.x, rp.y, 60)) return;
        drawPlayerSprite(rp, false);
    });
}

function drawPlayerSprite(p, isLocal) {
    const alive = p.alive !== false;
    if (!alive) ctx.globalAlpha = 0.3;

    if (isLocal && player.bonuses.aura > 0 && !perfMode) {
        const aurR = 80 + player.bonuses.aura * 10;
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, aurR);
        grad.addColorStop(0, 'rgba(255,100,0,0.2)');
        grad.addColorStop(1, 'rgba(255,50,0,0)');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(p.x, p.y, aurR, 0, Math.PI * 2); ctx.fill();
    }

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(p.x, p.y + 28, 18, 6, 0, 0, Math.PI * 2); ctx.fill();

    const sz = (p.size || 24) * 2;
    ctx.font = `${sz}px serif`;
    if (!perfMode) {
        ctx.shadowBlur = isLocal ? 16 : 8;
        ctx.shadowColor = isLocal ? '#667eea' : '#2ecc71';
    }
    ctx.fillText(p.emoji || p.e || '😎', p.x, p.y);
    if (!perfMode) ctx.shadowBlur = 0;

    ctx.font = 'bold 13px Arial';
    if (!perfMode) { ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 3; ctx.strokeText(p.name || p.n || '?', p.x, p.y - 38); }
    ctx.fillStyle = isLocal ? '#a78bfa' : '#fff';
    ctx.fillText(p.name || p.n || '?', p.x, p.y - 38);

    const hp = isLocal ? player.health : (p.h || p.health || 100);
    const maxHp = isLocal ? player.maxHealth : 100;
    const hPct = Math.max(0, hp / maxHp);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(p.x - 25, p.y + 32, 50, 6);
    ctx.fillStyle = hPct > 0.5 ? '#2ecc71' : hPct > 0.25 ? '#ffa500' : '#f5576c';
    ctx.fillRect(p.x - 25, p.y + 32, 50 * hPct, 6);

    ctx.globalAlpha = 1;
}

function drawDrones() {
    if (player.bonuses.drones <= 0) return;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '22px serif';
    for (let i = 0; i < player.bonuses.drones; i++) {
        const ang = player.droneAngle + i * Math.PI * 2 / player.bonuses.drones;
        const dx = player.x + Math.cos(ang) * 60;
        const dy = player.y + Math.sin(ang) * 60;
        if (!onScreen(dx, dy, 20)) continue;
        if (!perfMode) { ctx.shadowBlur = 8; ctx.shadowColor = '#667eea'; }
        ctx.fillText('🤖', dx, dy);
        if (!perfMode) { ctx.shadowBlur = 0; }
        ctx.strokeStyle = 'rgba(102,126,234,0.3)'; ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(player.x, player.y); ctx.lineTo(dx, dy); ctx.stroke();
        ctx.setLineDash([]);
    }
}

function drawParticlePool() {
    for (let i = 0; i < PP_SIZE; i++) {
        const p = particlePool[i];
        if (!p.active) continue;
        if (!onScreen(p.x, p.y, p.size)) continue;
        ctx.globalAlpha = p.life / p.maxLife;
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
}

function drawDmgPool() {
    if (perfMode) return;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < DP_SIZE; i++) {
        const d = dmgPool[i];
        if (!d.active) continue;
        if (!onScreen(d.x, d.y, 30)) continue;
        ctx.globalAlpha = d.life;
        ctx.font = 'bold 15px Arial';
        ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 3;
        ctx.strokeText('-' + d.dmg, d.x, d.y);
        ctx.fillStyle = '#ff6b6b';
        ctx.fillText('-' + d.dmg, d.x, d.y);
    }
    ctx.globalAlpha = 1;
}

// ===================================================================
//  GAME OVER
// ===================================================================
function endGame() {
    GS = 'gameover';
    const cumK = parseInt(localStorage.getItem('sio_cumKills') || '0') + player.kills;
    localStorage.setItem('sio_cumKills', cumK);
    if (cumK >= 1000) { const t = TROPHIES.find(t => t.id === 'butcher_1000'); if (t && !t.unlocked) { t.unlocked = true; saveTrophies(); } }
    const isNew = saveHighScore(player.score);

    document.getElementById('gameUI').classList.add('hidden');
    document.getElementById('joystickZone').classList.add('hidden');
    const go = document.getElementById('gameOverScreen');
    go.classList.remove('hidden');

    document.getElementById('finalScore').textContent = player.score;
    if (isNew) {
        document.getElementById('newHighScore').classList.remove('hidden');
        document.getElementById('highScoreValue').textContent = player.score;
    } else { document.getElementById('newHighScore').classList.add('hidden'); }

    const sm = stats.survivalTime;
    const mm = Math.floor(sm / 60000), ss = Math.floor((sm % 60000) / 1000);
    document.getElementById('timeSurvived').textContent = `${mm}:${ss.toString().padStart(2, '0')}`;
    document.getElementById('totalKills').textContent = player.kills;
    document.getElementById('totalDamage').textContent = stats.totalDamage.toFixed(0);
    document.getElementById('avgDPS').textContent = sm > 0 ? (stats.totalDamage / (sm / 1000)).toFixed(1) : 0;
    document.getElementById('waveReached').textContent = currentWave;
    document.getElementById('levelReached').textContent = player.level;

    const kbt = document.getElementById('killsByType');
    kbt.innerHTML = '';
    Object.keys(stats.killsByType).forEach(type => {
        const td = ET[type] || {};
        const item = document.createElement('div');
        item.className = 'kill-type-item';
        item.innerHTML = `<span>${td.emoji || '?'} ${type}</span><span style="color:#ffd700;font-weight:700">${stats.killsByType[type]}</span>`;
        kbt.appendChild(item);
    });

    const newT = TROPHIES.filter(t => t.unlocked && !localStorage.getItem('sio_trophy_shown_' + t.id));
    newT.forEach(t => localStorage.setItem('sio_trophy_shown_' + t.id, '1'));
    if (newT.length > 0) {
        document.getElementById('unlockedTrophies').classList.remove('hidden');
        const nl = document.getElementById('newTrophiesList');
        nl.innerHTML = '';
        newT.forEach(t => {
            const d = document.createElement('div'); d.className = 'new-trophy-item';
            d.innerHTML = `<span class="new-trophy-icon">${t.icon}</span><span>${t.name}</span>`;
            nl.appendChild(d);
        });
    } else { document.getElementById('unlockedTrophies').classList.add('hidden'); }

    const flc = document.getElementById('finalLeaderboardContent');
    flc.innerHTML = '';
    const allP = [
        { name: player.name, emoji: player.emoji, score: player.score, me: true },
        ...Object.values(remotePlayers).map(rp => ({ name: rp.n, emoji: rp.e, score: rp.sc || 0, me: false })),
    ].sort((a, b) => b.score - a.score);
    allP.forEach((p, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        const d = document.createElement('div'); d.className = 'fli' + (p.me ? ' fli-me' : '');
        d.innerHTML = `<span style="min-width:28px;font-size:1.2rem">${medal}</span><span style="font-size:1.1rem">${p.emoji}</span><span style="flex:1;font-weight:700">${p.name}</span><span style="color:#ffd700;font-weight:700">${p.score}</span>`;
        flc.appendChild(d);
    });

    refreshTrophyUI();
}

function restartGame() {
    if (peer) peer.destroy(); peer = null;
    connections = []; remotePlayers = {}; hostConn = null;
    isHost = false; gameMode = 'solo'; GS = 'menu';
    spectatorMode = false;
    document.getElementById('gameOverScreen').classList.add('hidden');
    document.getElementById('gameUI').classList.add('hidden');
    document.getElementById('joystickZone').classList.add('hidden');
    document.getElementById('settingsPanel').classList.add('hidden');
    showMainMenuControls();
    document.getElementById('menuScreen').classList.add('active');
}

function shareScore() {
    const sm = stats.survivalTime;
    const mm = Math.floor(sm / 60000), ss = Math.floor((sm % 60000) / 1000);
    const txt = `🧟 J'ai survécu ${mm}:${ss.toString().padStart(2, '0')} à Survivor.io BETA !\n🎯 Kills: ${player.kills}\n⭐ Score: ${player.score}\n🌊 Vague: ${currentWave}\n🏆 Peux-tu faire mieux ?`;
    if (navigator.share) navigator.share({ title: 'Survivor.io BETA', text: txt }).catch(() => copyText(txt));
    else copyText(txt);
}
function copyText(t) { navigator.clipboard.writeText(t).then(() => showToast('📋 Copié !')); }

// ===================================================================
//  SERVICE WORKER
// ===================================================================
function registerSW() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
