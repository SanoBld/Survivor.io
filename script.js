// ============================================================
//  SURVIVOR.IO — v3 Pro
//  ── Architecture ──────────────────────────────────────────
//    • Logic / Rendering strictly separated (no draw calls in update)
//    • Object Pools: particles ×600, dmgNums ×100 — zero GC in hot path
//    • Obstacle Spatial Grid (static AABB map, rebuilt on obs death)
//    • Enemy Spatial Grid (dynamic, rebuilt each frame) — O(1) collisions
//    • Frustum Culling — offscreen entities skip physics & render
//    • Swap-and-pop deletion everywhere — never Array.splice
//    • Segment–AABB ray-cast for anti-tunneling projectiles
//  ── V3-Pro NEW ────────────────────────────────────────────
//    • Destructible Gas Barrels: HP, bullet damage, AOE death,
//      obsGrid hotswap (dead flag → grid rebuild deferred to next frame)
//    • Bushes 🌿: traversable (no collision), visual ground cover,
//      apply 20% speed slow while entity overlaps — bitmask flag avoids
//      per-frame string comparison
//    • Trees 🌳: trunk-only circle collision (trunkR field), foliage
//      rendered behind entities as semi-transparent overlay
//    • Organic compound structures: L-shapes, T-shapes added to the
//      deterministic seed generator (seed-preserving: shapes appended
//      after all random picks, position derived from same RNG sequence)
//    • Structure proximity deduplication: before push, O(1) AABB overlap
//      check against last 8 placed obstacles — avoids Z-fighting clusters
//    • Multiplayer aura + drone sync: player payload now includes
//      auraColor (ac), droneAngle (da), droneCount (dn) — visual only,
//      never authoritative; clients generate local animations
//    • Remote player drones rendered in drawDrones()
//    • Remote player aura colour applied in drawPlayerSprite()
//  ── Biomes (v3) ───────────────────────────────────────────
//    • 5 zones: Prairies / Cristal / Toundra / Marécage / Nécropole
//    • Each biome has unique ground gradient, ambient overlay, grid tint
//    • Performance mode: flat fill, no gradients, no ambient overlay
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
    JOYSTICK_DEADZONE: 0.12,  // Minimum displacement ratio before movement registers
    JOYSTICK_MAX_RADIUS: 52,  // Max pixel radius of joystick knob travel
};

// ===== BIOME ZONES — defined by world-coordinate regions =====
// Each biome has a unique ground color, atmosphere, and grid tint.
// Biome is determined by the player's normalised position (0→1).
const BIOMES = [
    // Centre — Prairies de départ (safe zone feel)
    { name: 'Prairies',    cx: 0.5, cy: 0.5, r: 0.25, groundA: '#0d1a0d', groundB: '#1a2e1a', gridCol: 'rgba(100,200,100,0.03)', ambientCol: 'rgba(40,180,40,0.04)'  },
    // Nord-Ouest — Désert de Cristal
    { name: 'Cristal',     cx: 0.2, cy: 0.2, r: 0.22, groundA: '#1a1208', groundB: '#2e2416', gridCol: 'rgba(255,200,80,0.04)',  ambientCol: 'rgba(200,160,60,0.06)' },
    // Nord-Est — Toundra Glaciaire
    { name: 'Toundra',     cx: 0.8, cy: 0.2, r: 0.22, groundA: '#0a0f1a', groundB: '#0e1828', gridCol: 'rgba(100,160,255,0.05)', ambientCol: 'rgba(60,120,220,0.07)' },
    // Sud-Ouest — Marécage Toxique
    { name: 'Marécage',    cx: 0.2, cy: 0.8, r: 0.22, groundA: '#0a1208', groundB: '#14200e', gridCol: 'rgba(80,200,60,0.04)',   ambientCol: 'rgba(60,200,80,0.07)'  },
    // Sud-Est — Nécropole Volcanique
    { name: 'Nécropole',   cx: 0.8, cy: 0.8, r: 0.22, groundA: '#1a0808', groundB: '#2e1010', gridCol: 'rgba(255,60,30,0.04)',  ambientCol: 'rgba(220,40,20,0.07)'  },
];

// Mutable world seed (assigned at game creation for determinism)
let STRUCTURE_SEED = 42;

// ===================================================================
//  OBSTACLE TYPE BITMASKS
//  Using integer flags avoids per-frame string comparisons in hot paths.
//  Assigned once at buildStructures time; stored as obs.flags.
// ===================================================================
const OBS_F = {
    SOLID   : 0b0001,  // Blocks entity movement
    BLOCKER : 0b0010,  // Blocks projectiles
    BUSH    : 0b0100,  // Traversable, applies slow
    CIRCULAR: 0b1000,  // Collision uses radius, not AABB (trees)
};
// Bitmask by type — looked up once during obstacle creation
const OBS_TYPE_FLAGS = {
    wall:     OBS_F.SOLID | OBS_F.BLOCKER,
    box:      OBS_F.SOLID | OBS_F.BLOCKER,
    house:    OBS_F.SOLID | OBS_F.BLOCKER,
    building: OBS_F.SOLID | OBS_F.BLOCKER,
    tree:     OBS_F.SOLID | OBS_F.BLOCKER | OBS_F.CIRCULAR,
    bush:     OBS_F.BUSH,
    gas:      0,          // Traversable hazard (was passthrough in v2 too)
    tnt:      0,          // Passthrough; explodes on proximity
    acid:     0,          // Passthrough; DoT hazard
    arena:    0,          // Decorative circle
};

// Dirty flag: set to true when an obstacle is destroyed at runtime.
// buildObsGrid checks this at the start of each frame and rebuilds if needed.
// Rebuild is O(obstacles.length) ≈ ~600 items — acceptable for rare events.
let obsGridDirty = false;

// ===== ENEMY TYPES =====
// minWave : first wave at which this type can spawn
// weight  : relative spawn probability once unlocked (higher = more common)
const ET = {
    // ── Vague 1 — starter horde ─────────────────────────────────────────────────────────────────
    zombie:   { emoji:'🧟', hp:30,  spd:1.4, dmg:16,  sz:16, xp:15,  sc:10,  col:'#95e1d3', ghost:false, shooter:false, charger:false, toxic:false, spider:false, dragon:false, minWave:1,  weight:8 },
    // ── Vague 2 — zone de poison ─────────────────────────────────────────────────────────────────
    fungus:   { emoji:'🍄', hp:60,  spd:0.9, dmg:10,  sz:20, xp:30,  sc:25,  col:'#a5d6a7', ghost:false, shooter:false, charger:false, toxic:true,  spider:false, dragon:false, minWave:2,  weight:5 },
    // ── Vague 3 — araignée rapide ────────────────────────────────────────────────────────────────
    spider:   { emoji:'🕷️', hp:45,  spd:3.0, dmg:22,  sz:18, xp:25,  sc:20,  col:'#bcaaa4', ghost:false, shooter:false, charger:false, toxic:false, spider:true,  dragon:false, minWave:3,  weight:5 },
    // ── Vague 4 — tireur à distance ─────────────────────────────────────────────────────────────
    alien:    { emoji:'👾', hp:120, spd:1.0, dmg:45,  sz:26, xp:50,  sc:50,  col:'#f093fb', ghost:false, shooter:true,  charger:false, toxic:false, spider:false, dragon:false, minWave:4,  weight:3 },
    // ── Vague 5 — chargeur brutale ───────────────────────────────────────────────────────────────
    minotaur: { emoji:'🐂', hp:200, spd:2.4, dmg:65,  sz:30, xp:80,  sc:80,  col:'#ff7043', ghost:false, shooter:false, charger:true,  toxic:false, spider:false, dragon:false, minWave:5,  weight:2 },
    // ── Vague 7 — fantôme intangible ────────────────────────────────────────────────────────────
    ghost:    { emoji:'👻', hp:15,  spd:3.4, dmg:12,  sz:13, xp:12,  sc:15,  col:'#c9b8f5', ghost:true,  shooter:false, charger:false, toxic:false, spider:false, dragon:false, minWave:7,  weight:3 },
    // ── Vague 10 — DRAGON BOSS (vole + charge + souffle de feu) ─────────────────────────────────
    dragon:   { emoji:'🐉', hp:500, spd:2.0, dmg:90,  sz:34, xp:200, sc:200, col:'#ff1744', ghost:true,  shooter:true,  charger:true,  toxic:false, spider:false, dragon:true,  kamikaze:false, healer:false, sniper:false, minWave:10, weight:1 },
    // ── Vague 3 — Kamikaze : accélération brutale à portée de vue ───────────────────────────────
    kamikaze: { emoji:'💥', hp:25,  spd:1.5, dmg:50,  sz:14, xp:20,  sc:18,  col:'#ff6b35', ghost:false, shooter:false, charger:false, toxic:false, spider:false, dragon:false, kamikaze:true,  healer:false, sniper:false, minWave:3,  weight:4 },
    // ── Vague 6 — Soigneur : fuit, régénère les PV des alliés proches ───────────────────────────
    healer:   { emoji:'💚', hp:80,  spd:1.2, dmg:8,   sz:18, xp:40,  sc:35,  col:'#00e676', ghost:false, shooter:false, charger:false, toxic:false, spider:false, dragon:false, kamikaze:false, healer:true,  sniper:false, minWave:6,  weight:3 },
    // ── Vague 8 — Sniper : s'arrête à distance, tir chargé lent et puissant ────────────────────
    sniper:   { emoji:'🎯', hp:70,  spd:1.6, dmg:70,  sz:20, xp:55,  sc:55,  col:'#ff4081', ghost:false, shooter:false, charger:false, toxic:false, spider:false, dragon:false, kamikaze:false, healer:false, sniper:true,  minWave:8,  weight:2 },
};

// Pre-cache emoji font strings per type
const ET_FONT = {};
Object.keys(ET).forEach(k => { ET_FONT[k] = `${ET[k].sz * 2}px serif`; });

// Pre-allocated spawn pool — reused every spawn call, zero GC
const _spawnPool = [];

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
    if (perfMode || !showDmgNums) return;
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
    // Rebuild the static spatial grid for AABB obstacle queries.
    // Called once at game start and again whenever obsGridDirty is true
    // (i.e., a destructible obstacle — gas barrel — was destroyed).
    // Cost: O(obstacles.length) ≈ 600 — negligible compared to enemy grid.
    obsGridDirty = false;
    obsGrid.clear();
    for (const obs of obstacles) {
        if (obs.type === 'arena' || obs.dead) continue;
        // Bush and circular obstacles still register in the grid for query range checks,
        // but solid collision is gated by obs.flags in checkEntityObsCollision.
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
let showDmgNums     = true;   // Toggle: show/hide damage numbers
let showBonusPills  = true;   // Toggle: show/hide active bonus pills
let showAnimations  = true;   // Toggle: squash/stretch + rotation walk anim
let showDeathParticles = true; // Toggle: death debris particles
let playerAuraColor = '#667eea'; // Chosen aura color (persisted)

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
        acidSlowTimer: 0,  // ms remaining of acid pool slow effect
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
// Current biome — updated each frame in updateCamera, used in drawWorld
let currentBiome = BIOMES[0];

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
    showDmgNums        = localStorage.getItem('sio_showDmg')        !== '0';
    showBonusPills     = localStorage.getItem('sio_showBonus')       !== '0';
    showAnimations     = localStorage.getItem('sio_showAnim')        !== '0';
    showDeathParticles = localStorage.getItem('sio_showDeathPart')   !== '0';
    applyDisplayToggles();

    // === PROFILE PERSISTENCE: restore name, emoji, aura color ===
    const savedName = localStorage.getItem('sio_name');
    if (savedName) {
        document.getElementById('playerName').value = savedName;
        player.name = savedName;
    }
    const savedEmoji = localStorage.getItem('sio_emoji');
    if (savedEmoji) {
        document.querySelectorAll('.emoji-btn').forEach(b => {
            b.classList.remove('selected');
            if (b.dataset.emoji === savedEmoji) b.classList.add('selected');
        });
        player.emoji = savedEmoji;
    }
    const savedAura = localStorage.getItem('sio_aura');
    if (savedAura) {
        playerAuraColor = savedAura;
        document.querySelectorAll('.aura-dot').forEach(b => {
            b.classList.remove('selected');
            if (b.dataset.color === savedAura) b.classList.add('selected');
        });
    }
    refreshAchievementsTab();
}

function saveProfile() {
    localStorage.setItem('sio_name', player.name);
    localStorage.setItem('sio_emoji', player.emoji);
    localStorage.setItem('sio_aura', playerAuraColor);
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

function refreshAchievementsTab() {
    // Record stats
    const hs = parseInt(localStorage.getItem('sio_hs') || '0');
    const bw = parseInt(localStorage.getItem('sio_bestWave') || '0');
    const bt = parseInt(localStorage.getItem('sio_bestTime') || '0');
    const bm = Math.floor(bt / 60000), bs = Math.floor((bt % 60000) / 1000);

    const el = id => document.getElementById(id);
    if (el('achHighScore')) el('achHighScore').textContent = hs.toLocaleString();
    if (el('achBestWave')) el('achBestWave').textContent = bw;
    if (el('achBestTime')) el('achBestTime').textContent = bt > 0 ? `${bm}:${bs.toString().padStart(2,'0')}` : '0:00';

    // Cumulative stats
    const cumK  = parseInt(localStorage.getItem('sio_cumKills')  || '0');
    const cumD  = parseInt(localStorage.getItem('sio_cumDeaths') || '0');
    const cumXP = parseInt(localStorage.getItem('sio_cumXP')     || '0');
    const cumG  = parseInt(localStorage.getItem('sio_cumGames')  || '0');
    if (el('achTotalKills'))  el('achTotalKills').textContent  = cumK.toLocaleString();
    if (el('achTotalDeaths')) el('achTotalDeaths').textContent = cumD.toLocaleString();
    if (el('achTotalXP'))     el('achTotalXP').textContent     = cumXP.toLocaleString();
    if (el('achTotalGames'))  el('achTotalGames').textContent  = cumG.toLocaleString();

    // Trophy badge grid
    const grid = el('achBadgeGrid');
    if (!grid) return;
    grid.innerHTML = '';
    const unlocked = TROPHIES.filter(t => t.unlocked).length;
    if (el('achBadgeCount')) el('achBadgeCount').textContent = `${unlocked}/${TROPHIES.length}`;

    TROPHIES.forEach(t => {
        const div = document.createElement('div');
        div.className = 'ach-badge' + (t.unlocked ? ' ach-badge-unlocked' : ' ach-badge-locked');
        div.innerHTML = `<span class="ach-badge-icon">${t.icon}</span><span class="ach-badge-name">${t.name}</span>`;
        div.title = t.unlocked ? '✅ ' + t.name : '🔒 Non débloqué';
        grid.appendChild(div);
    });
}

function refreshTabSettings() {
    const el = id => document.getElementById(id);
    const syncBtn = (id, state) => {
        const btn = el(id);
        if (!btn) return;
        btn.textContent = state ? 'ON' : 'OFF';
        btn.className = 'toggle-btn ' + (state ? 'on' : 'off');
    };
    syncBtn('togglePerfModeTab',    perfMode);
    syncBtn('toggleShowDmg',        showDmgNums);
    syncBtn('toggleShowBonus',      showBonusPills);
    syncBtn('toggleShowAnim',       showAnimations);
    syncBtn('toggleShowDeathPart',  showDeathParticles);
    if (el('tabSettingsFPS')) el('tabSettingsFPS').textContent = currentFPS;
    if (el('tabSettingsEnemies')) el('tabSettingsEnemies').textContent = enemies.length;
    let ap = 0; for (let i = 0; i < PP_SIZE; i++) { if (particlePool[i].active) ap++; }
    if (el('tabSettingsParticles')) el('tabSettingsParticles').textContent = `${ap}/${PP_SIZE}`;
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
    document.getElementById('playerName').oninput = e => {
        player.name = e.target.value.trim() || 'Joueur';
        saveProfile();
    };

    // === EMOJI SAVE on change ===
    document.querySelectorAll('.emoji-btn').forEach(b => {
        const orig = b.onclick;
        b.onclick = () => {
            document.querySelectorAll('.emoji-btn').forEach(x => x.classList.remove('selected'));
            b.classList.add('selected');
            player.emoji = b.dataset.emoji;
            saveProfile();
        };
    });

    // === AURA COLOR PICKER ===
    document.querySelectorAll('.aura-dot').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('.aura-dot').forEach(x => x.classList.remove('selected'));
            btn.classList.add('selected');
            playerAuraColor = btn.dataset.color;
            saveProfile();
        };
    });

    // === TAB SWITCHING ===
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            const tabId = 'tab-' + btn.dataset.tab;
            const panel = document.getElementById(tabId);
            if (panel) panel.classList.add('active');
            if (btn.dataset.tab === 'succes') refreshAchievementsTab();
            if (btn.dataset.tab === 'params') {
                refreshTabSettings();
                // Reveal quit button only when a game is in progress
                const qb = document.getElementById('btnQuitTab');
                if (qb) qb.classList.toggle('hidden', GS !== 'playing' && GS !== 'upgrade');
            }
        };
    });

    // === PARAMS TAB: perf toggle mirror ===
    const perfTabBtn = document.getElementById('togglePerfModeTab');
    if (perfTabBtn) {
        perfTabBtn.onclick = () => {
            perfMode = !perfMode;
            localStorage.setItem('sio_perf', perfMode ? '1' : '0');
            applyPerfMode();
            perfSuggestShown = false;
            updateSettingsDisplay();
            refreshTabSettings();
        };
    }

    // === PARAMS TAB: show/hide damage numbers ===
    const dmgTabBtn = document.getElementById('toggleShowDmg');
    if (dmgTabBtn) {
        dmgTabBtn.onclick = () => {
            showDmgNums = !showDmgNums;
            localStorage.setItem('sio_showDmg', showDmgNums ? '1' : '0');
            applyDisplayToggles();
        };
    }

    // === PARAMS TAB: show/hide bonus pills ===
    const bonusTabBtn = document.getElementById('toggleShowBonus');
    if (bonusTabBtn) {
        bonusTabBtn.onclick = () => {
            showBonusPills = !showBonusPills;
            localStorage.setItem('sio_showBonus', showBonusPills ? '1' : '0');
            applyDisplayToggles();
        };
    }

    // === PARAMS TAB: animations toggle ===
    const animTabBtn = document.getElementById('toggleShowAnim');
    if (animTabBtn) {
        animTabBtn.onclick = () => {
            showAnimations = !showAnimations;
            localStorage.setItem('sio_showAnim', showAnimations ? '1' : '0');
            applyDisplayToggles();
        };
    }

    // === PARAMS TAB: death particles toggle ===
    const deathPartTabBtn = document.getElementById('toggleShowDeathPart');
    if (deathPartTabBtn) {
        deathPartTabBtn.onclick = () => {
            showDeathParticles = !showDeathParticles;
            localStorage.setItem('sio_showDeathPart', showDeathParticles ? '1' : '0');
            applyDisplayToggles();
        };
    }

    // === PARAMS TAB: Quit button ===
    const quitTabBtn = document.getElementById('btnQuitTab');
    if (quitTabBtn) {
        quitTabBtn.onclick = () => {
            if (peer) { peer.destroy(); peer = null; }
            connections = []; remotePlayers = {}; hostConn = null;
            isHost = false; gameMode = 'solo'; GS = 'menu';
            spectatorMode = false;
            document.getElementById('gameOverScreen').classList.add('hidden');
            document.getElementById('gameUI').classList.add('hidden');
            document.getElementById('joystickZone').classList.add('hidden');
            document.getElementById('upgradeMenu').classList.add('hidden');
            document.getElementById('settingsPanel').classList.add('hidden');
            showMainMenuControls();
            document.getElementById('menuScreen').classList.add('active');
            showToast('🚪 Partie quittée');
        };
    }
} // end setupMenu

function setupSettings() {
    const openSettings = () => {
        document.getElementById('settingsPanel').classList.remove('hidden');
        const inGame = GS === 'playing' || GS === 'upgrade';
        document.getElementById('btnQuitGame').classList.toggle('hidden', !inGame);
        // Also show/hide the params-tab quit button
        const qb = document.getElementById('btnQuitTab');
        if (qb) qb.classList.toggle('hidden', !inGame);
        updateSettingsDisplay();
    };
    const settingsMenuBtn = document.getElementById('btnSettingsMenu');
    if (settingsMenuBtn) settingsMenuBtn.onclick = openSettings;
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

    // In-game settings: show/hide damage numbers
    const dmgHUDBtn = document.getElementById('toggleShowDmgHUD');
    if (dmgHUDBtn) {
        dmgHUDBtn.onclick = () => {
            showDmgNums = !showDmgNums;
            localStorage.setItem('sio_showDmg', showDmgNums ? '1' : '0');
            applyDisplayToggles();
        };
    }

    // In-game settings: show/hide bonus pills
    const bonusHUDBtn = document.getElementById('toggleShowBonusHUD');
    if (bonusHUDBtn) {
        bonusHUDBtn.onclick = () => {
            showBonusPills = !showBonusPills;
            localStorage.setItem('sio_showBonus', showBonusPills ? '1' : '0');
            applyDisplayToggles();
        };
    }

    // In-game settings: animations toggle
    const animHUDBtn = document.getElementById('toggleShowAnimHUD');
    if (animHUDBtn) {
        animHUDBtn.onclick = () => {
            showAnimations = !showAnimations;
            localStorage.setItem('sio_showAnim', showAnimations ? '1' : '0');
            applyDisplayToggles();
        };
    }

    // In-game settings: death particles toggle
    const deathPartHUDBtn = document.getElementById('toggleShowDeathPartHUD');
    if (deathPartHUDBtn) {
        deathPartHUDBtn.onclick = () => {
            showDeathParticles = !showDeathParticles;
            localStorage.setItem('sio_showDeathPart', showDeathParticles ? '1' : '0');
            applyDisplayToggles();
        };
    }
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

// ===================================================================
//  DISPLAY TOGGLES — showDmgNums / showBonusPills
// ===================================================================
function applyDisplayToggles() {
    // Sync all toggle buttons (params tab + in-game settings)
    const syncBtn = (id, state) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.textContent = state ? 'ON' : 'OFF';
        btn.className = 'toggle-btn ' + (state ? 'on' : 'off');
    };
    syncBtn('toggleShowDmg',         showDmgNums);
    syncBtn('toggleShowDmgHUD',      showDmgNums);
    syncBtn('toggleShowBonus',       showBonusPills);
    syncBtn('toggleShowBonusHUD',    showBonusPills);
    syncBtn('toggleShowAnim',        showAnimations);
    syncBtn('toggleShowAnimHUD',     showAnimations);
    syncBtn('toggleShowDeathPart',   showDeathParticles);
    syncBtn('toggleShowDeathPartHUD',showDeathParticles);
    // Show/hide the bonus pills zone
    const ab = document.getElementById('activeBonus');
    if (ab) ab.style.display = showBonusPills ? '' : 'none';
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
    const cb = document.getElementById('customizationBlock');
    const mb = document.getElementById('mainButtons');
    if (cb) cb.style.display = 'none';
    if (mb) mb.style.display = 'none';
    document.getElementById('joinSection').classList.add('hidden');
    document.getElementById('hostSection').classList.add('hidden');
    document.getElementById('waitSection').classList.add('hidden');
}
function showMainMenuControls() {
    const cb = document.getElementById('customizationBlock');
    const mb = document.getElementById('mainButtons');
    if (cb) cb.style.display = '';
    if (mb) mb.style.display = '';
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
    } else if (d.t === 'fx') {
        // Relay FX to nearby connections and spawn locally on host
        broadcastFXToNearby(d.k, d.x, d.y, conn);
        spawnFX(d.k, d.x, d.y);
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
    } else if (d.t === 'fx') {
        // Received FX event from another player via host relay
        spawnFX(d.k, d.x, d.y);
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
    // Only remove enemies within the cull radius — those outside might just be absent from this packet
    for (let i = enemies.length - 1; i >= 0; i--) {
        if (!ids.has(enemies[i].id)) {
            const dx = enemies[i].x - player.x, dy = enemies[i].y - player.y;
            if (dx * dx + dy * dy < NET_CULL_R2) swapPop(enemies, i);
        }
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
    // Only remove gems within cull radius — those outside are just not in this packet
    for (let i = gems.length - 1; i >= 0; i--) {
        if (!ids.has(gems[i].id)) {
            const dx = gems[i].x - player.x, dy = gems[i].y - player.y;
            if (dx * dx + dy * dy < NET_CULL_R2) swapPop(gems, i);
        }
    }
}

function updateRemotePlayers(pd) {
    if (!pd) return;
    Object.keys(pd).forEach(id => {
        if (id === myPeerId) return;
        const pp = pd[id];
        if (!remotePlayers[id]) {
            remotePlayers[id] = {
                ...pp, id,
                tx: pp.x, ty: pp.y, x: pp.x, y: pp.y,
                alive: pp.al !== false,
                // Visual sync fields (never authoritative — local animation only)
                ac: pp.ac || '#667eea',
                dn: pp.dn || 0,
                da: pp.da || 0,
            };
        } else {
            const rp = remotePlayers[id];
            rp.tx = pp.x; rp.ty = pp.y;
            rp.n = pp.n; rp.e = pp.e; rp.h = pp.h; rp.sc = pp.sc;
            rp.alive = pp.al !== false;
            // Lerp drone angle locally — only adopt network value if delta < π
            // to avoid sudden 360° flips from quantisation jitter
            if (pp.ac !== undefined) rp.ac = pp.ac;
            if (pp.dn !== undefined) rp.dn = pp.dn;
            if (pp.da !== undefined) {
                const delta = pp.da - (rp.da || 0);
                rp.da = Math.abs(delta) < Math.PI ? pp.da : (rp.da || 0) + 0.02;
            }
        }
    });
}

function sendPlayerInfo() {
    if (!hostConn || !hostConn.open) return;
    // Transmit position, status, and lightweight visual data (aura + drones).
    // Visuals are never authoritative — clients use them only for rendering.
    // Drone angle is a single float; clients animate smoothly from it locally.
    hostConn.send({
        t: 'pi',
        p: {
            x:  Math.round(player.x),
            y:  Math.round(player.y),
            n:  player.name,
            e:  player.emoji,
            h:  Math.round(player.health),
            sc: player.score,
            alive: player.alive,
            ac: playerAuraColor,             // aura hex colour (6B string)
            dn: player.bonuses.drones,       // drone count (0–3)
            da: +player.droneAngle.toFixed(3), // drone orbit angle (radians)
        },
    });
}

// ===================================================================
//  NETWORK CULLING — Host sends only entities within 1100px per client
// ===================================================================
const NET_CULL_R  = 1100;          // World-units visibility radius per client
const NET_CULL_R2 = NET_CULL_R * NET_CULL_R;

function broadcastState() {
    if (!isHost) return;
    const playersPay = buildPlayersPayload();

    connections.forEach(c => {
        if (!c.open) return;
        const rp = remotePlayers[c.peer];
        // Use known remote-player position for culling centre; fall back to world centre
        const cx = rp ? (rp.x || CFG.WORLD / 2) : CFG.WORLD / 2;
        const cy = rp ? (rp.y || CFG.WORLD / 2) : CFG.WORLD / 2;

        // --- Cull enemies ---
        const ce = [];
        for (let i = 0; i < enemies.length; i++) {
            const e = enemies[i];
            const dx = e.x - cx, dy = e.y - cy;
            if (dx * dx + dy * dy < NET_CULL_R2) ce.push(e);
        }
        // --- Cull gems ---
        const cg = [];
        for (let i = 0; i < gems.length; i++) {
            const g = gems[i];
            const dx = g.x - cx, dy = g.y - cy;
            if (dx * dx + dy * dy < NET_CULL_R2) cg.push(g);
        }

        c.send({
            t: 'st', w: currentWave,
            e: ce.map(e => ({ i: e.id, x: Math.round(e.x), y: Math.round(e.y), hp: Math.round(e.health), mhp: e.maxHealth, ty: e.type, s: e.speed, d: e.damage, sz: e.size })),
            g: cg.map(g => ({ i: g.id, x: Math.round(g.x), y: Math.round(g.y), xp: g.xp })),
            p: playersPay,
        });
    });
}

// --- Broadcast a lightweight FX event to nearby connections ---
function broadcastFXToNearby(kind, x, y, srcConn) {
    if (!isHost) return;
    const FX_R2 = 1300 * 1300;
    const msg = { t: 'fx', k: kind, x: Math.round(x), y: Math.round(y) };
    connections.forEach(c => {
        if (c === srcConn || !c.open) return;
        const rp = remotePlayers[c.peer];
        if (!rp) return;
        const dx = rp.x - x, dy = rp.y - y;
        if (dx * dx + dy * dy < FX_R2) c.send(msg);
    });
}

// --- Spawn FX locally from a received fx message ---
function spawnFX(kind, x, y) {
    if (!onScreen(x, y, 250)) return;
    if (kind === 'blast') {
        shakeCamera(10);
        for (let i = 0; i < 20; i++) spawnParticle(x, y, '#f5576c', 3 + Math.random() * 5);
    } else if (kind === 'mine') {
        shakeCamera(7);
        for (let p = 0; p < 16; p++) spawnParticle(x, y, '#ff9800', 4 + Math.random() * 4);
        for (let p = 0; p < 8;  p++) spawnParticle(x, y, '#ffcc00', 5 + Math.random() * 3, 1.4);
    }
}

function serializeEnemies() {
    return enemies.map(e => ({ i: e.id, x: Math.round(e.x), y: Math.round(e.y), hp: Math.round(e.health), mhp: e.maxHealth, ty: e.type, s: e.speed, d: e.damage, sz: e.size }));
}
function serializeGems() {
    return gems.map(g => ({ i: g.id, x: Math.round(g.x), y: Math.round(g.y), xp: g.xp }));
}
function buildPlayersPayload() {
    const obj = {};
    // Include our own visual state so remote players can render our aura + drones
    obj[myPeerId] = {
        x:  Math.round(player.x),  y:  Math.round(player.y),
        n:  player.name,           e:  player.emoji,
        h:  Math.round(player.health), sc: player.score,
        al: player.alive,
        ac: playerAuraColor,
        dn: player.bonuses.drones,
        da: +player.droneAngle.toFixed(3),
    };
    Object.keys(remotePlayers).forEach(id => {
        const rp = remotePlayers[id];
        obj[id] = {
            x: Math.round(rp.x || 0), y: Math.round(rp.y || 0),
            n: rp.n, e: rp.e, h: rp.h || 100, sc: rp.sc || 0,
            al: rp.alive !== false,
            ac: rp.ac || '#667eea',
            dn: rp.dn || 0,
            da: rp.da || 0,
        };
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
    // Restore saved aura color
    const savedAuraInit = localStorage.getItem('sio_aura');
    if (savedAuraInit) playerAuraColor = savedAuraInit;
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
//  V3-Pro additions:
//    • Organic L / T compound shapes
//    • Proximity deduplication: each new obstacle checked against a
//      sliding window of the last 8 placed — prevents overlapping clusters
//      while preserving seed determinism (no re-rolls needed)
//    • Bushes 🌿: no collision, apply slow bitmask (OBS_F.BUSH)
//    • Trees 🌳: trunk-only circle collision (trunkR), foliage radius (r)
//    • Gas barrels with HP — destructible, AOE on death
//    • TNT, acid pools, compound structures (U-walls, corridors, arenas)
// ===================================================================
function buildStructures(seed) {
    obstacles.length = 0;
    const rng  = new Rng(seed);
    const W    = CFG.WORLD;
    const half = W / 2;

    // ── Helper: AABB overlap test between new obs and last N placed ─────────────────────
    // This O(8) check prevents visible Z-fighting clusters without re-rolling the RNG,
    // preserving full seed determinism (failed placements still advance the RNG state).
    const DEDUP_WIN = 8;
    function overlapsRecent(nx, ny, nw, nh) {
        const start = Math.max(0, obstacles.length - DEDUP_WIN);
        for (let i = start; i < obstacles.length; i++) {
            const o = obstacles[i];
            if (!o.w || !o.h) continue;
            const sep = 20; // minimum clearance in pixels
            if (Math.abs(nx - o.x) < (nw + o.w) / 2 + sep &&
                Math.abs(ny - o.y) < (nh + o.h) / 2 + sep) return true;
        }
        return false;
    }

    // ── Helper: push obstacle with pre-computed flags ────────────────────────────────────
    function pushObs(obj) {
        obj.flags = OBS_TYPE_FLAGS[obj.type] || 0;
        obstacles.push(obj);
    }

    // ──────────────────────────────────────────────────────────────────────────────────────
    //  1. UNIT OBSTACLES
    // ──────────────────────────────────────────────────────────────────────────────────────
    const unitTypes = [
        { w: 200, h: 20,  emoji: '🧱', type: 'wall',     es: 1.0 },
        { w: 20,  h: 200, emoji: '🧱', type: 'wall',     es: 1.0 },
        { w: 40,  h: 40,  emoji: '📦', type: 'box',      es: 1.2 },
        { w: 80,  h: 80,  emoji: '🏠', type: 'house',    es: 1.8 },
        { w: 120, h: 120, emoji: '🏢', type: 'building', es: 2.5 },
    ];
    for (let i = 0; i < 200; i++) {
        const st = rng.pick(unitTypes);
        const x  = rng.range(100, W - 100);
        const y  = rng.range(100, W - 100);
        if (Math.hypot(x - half, y - half) < 200) continue;
        if (overlapsRecent(x, y, st.w, st.h)) continue;
        pushObs({ x, y, w: st.w, h: st.h, emoji: st.emoji, type: st.type, es: st.es });
    }

    // ──────────────────────────────────────────────────────────────────────────────────────
    //  2. TREES — trunk-only collision, visual foliage
    //     trunkR: collision radius (circle, not AABB)
    //     r     : foliage rendering radius (decorative)
    // ──────────────────────────────────────────────────────────────────────────────────────
    for (let i = 0; i < 120; i++) {
        const big  = rng.next() > 0.5;
        const r    = big ? rng.range(28, 42) | 0 : rng.range(18, 28) | 0;
        const trR  = big ? 12 : 8; // small solid trunk
        const x    = rng.range(100, W - 100);
        const y    = rng.range(100, W - 100);
        if (Math.hypot(x - half, y - half) < 200) continue;
        // Register in grid with AABB equal to foliage bounding box
        pushObs({ x, y, w: r * 2, h: r * 2, emoji: big ? '🌳' : '🌲', type: 'tree', es: 1.2,
                  trunkR: trR, foliageR: r });
    }

    // ──────────────────────────────────────────────────────────────────────────────────────
    //  3. BUSHES — traversable, apply slow on entry (OBS_F.BUSH)
    //     Registered in obsGrid so queryNearbyObs finds them for slow check,
    //     but flagged as non-solid so checkEntityObsCollision skips them.
    // ──────────────────────────────────────────────────────────────────────────────────────
    for (let i = 0; i < 80; i++) {
        const r = rng.range(22, 50) | 0;
        const x = rng.range(80, W - 80);
        const y = rng.range(80, W - 80);
        if (Math.hypot(x - half, y - half) < 160) continue;
        pushObs({ x, y, w: r * 2, h: r * 2, emoji: '🌿', type: 'bush', es: 0.8, radius: r });
    }

    // ──────────────────────────────────────────────────────────────────────────────────────
    //  4. CENTRAL WALL CLUSTER
    // ──────────────────────────────────────────────────────────────────────────────────────
    for (let i = 0; i < 8; i++) {
        const vert = rng.next() > 0.5;
        pushObs({ x: half + rng.range(-600, 600), y: half + rng.range(-600, 600),
                  w: vert ? 20 : 180, h: vert ? 180 : 20, emoji: '🧱', type: 'wall', es: 1 });
    }

    // ──────────────────────────────────────────────────────────────────────────────────────
    //  5. U-SHAPES (3-sided traps)
    // ──────────────────────────────────────────────────────────────────────────────────────
    for (let i = 0; i < 14; i++) {
        const cx   = rng.range(300, W - 300);
        const cy   = rng.range(300, W - 300);
        if (Math.hypot(cx - half, cy - half) < 250) { i--; continue; }
        const len  = rng.range(120, 240) | 0;
        const open = rng.int(0, 4);
        const sides = [
            { dx: 0,      dy: -len/2, w: len + 20, h: 20 },
            { dx: 0,      dy:  len/2, w: len + 20, h: 20 },
            { dx: -len/2, dy: 0,      w: 20, h: len },
            { dx:  len/2, dy: 0,      w: 20, h: len },
        ];
        for (let s = 0; s < 4; s++) {
            if (s === open) continue;
            const sd = sides[s];
            pushObs({ x: cx + sd.dx, y: cy + sd.dy, w: sd.w, h: sd.h, emoji: '🧱', type: 'wall', es: 1 });
        }
    }

    // ──────────────────────────────────────────────────────────────────────────────────────
    //  6. L-SHAPES — two perpendicular wall segments sharing a corner
    //     The corner is always at (cx,cy); arm lengths are independent random values.
    // ──────────────────────────────────────────────────────────────────────────────────────
    for (let i = 0; i < 10; i++) {
        const cx   = rng.range(350, W - 350);
        const cy   = rng.range(350, W - 350);
        if (Math.hypot(cx - half, cy - half) < 280) { i--; continue; }
        const arm1 = rng.range(100, 220) | 0;  // horizontal arm length
        const arm2 = rng.range(100, 220) | 0;  // vertical arm length
        const flipH = rng.next() > 0.5 ? 1 : -1;
        const flipV = rng.next() > 0.5 ? 1 : -1;
        // Horizontal arm
        pushObs({ x: cx + flipH * arm1 / 2, y: cy, w: arm1, h: 20, emoji: '🧱', type: 'wall', es: 1 });
        // Vertical arm (originates from same corner)
        pushObs({ x: cx, y: cy + flipV * arm2 / 2, w: 20, h: arm2, emoji: '🧱', type: 'wall', es: 1 });
    }

    // ──────────────────────────────────────────────────────────────────────────────────────
    //  7. T-SHAPES — one long crossbar + one perpendicular spine from its centre
    // ──────────────────────────────────────────────────────────────────────────────────────
    for (let i = 0; i < 8; i++) {
        const cx  = rng.range(400, W - 400);
        const cy  = rng.range(400, W - 400);
        if (Math.hypot(cx - half, cy - half) < 300) { i--; continue; }
        const bar  = rng.range(180, 320) | 0;
        const stem = rng.range(100, 200) | 0;
        const horiz = rng.next() > 0.5; // crossbar orientation
        const flip  = rng.next() > 0.5 ? 1 : -1;
        if (horiz) {
            pushObs({ x: cx, y: cy, w: bar, h: 20, emoji: '🧱', type: 'wall', es: 1 });
            pushObs({ x: cx, y: cy + flip * stem / 2, w: 20, h: stem, emoji: '🧱', type: 'wall', es: 1 });
        } else {
            pushObs({ x: cx, y: cy, w: 20, h: bar, emoji: '🧱', type: 'wall', es: 1 });
            pushObs({ x: cx + flip * stem / 2, y: cy, w: stem, h: 20, emoji: '🧱', type: 'wall', es: 1 });
        }
    }

    // ──────────────────────────────────────────────────────────────────────────────────────
    //  8. CORRIDORS — two parallel walls forming a passage
    // ──────────────────────────────────────────────────────────────────────────────────────
    for (let i = 0; i < 8; i++) {
        const cx   = rng.range(400, W - 400);
        const cy   = rng.range(400, W - 400);
        if (Math.hypot(cx - half, cy - half) < 300) { i--; continue; }
        const horiz  = rng.next() > 0.5;
        const gap    = rng.range(80, 140) | 0;
        const length = rng.range(200, 380) | 0;
        if (horiz) {
            pushObs({ x: cx, y: cy - gap/2, w: length, h: 20, emoji: '🧱', type: 'wall', es: 1 });
            pushObs({ x: cx, y: cy + gap/2, w: length, h: 20, emoji: '🧱', type: 'wall', es: 1 });
        } else {
            pushObs({ x: cx - gap/2, y: cy, w: 20, h: length, emoji: '🧱', type: 'wall', es: 1 });
            pushObs({ x: cx + gap/2, y: cy, w: 20, h: length, emoji: '🧱', type: 'wall', es: 1 });
        }
    }

    // ──────────────────────────────────────────────────────────────────────────────────────
    //  9. CLOSED ARENAS — 4 walls with one entrance gap
    // ──────────────────────────────────────────────────────────────────────────────────────
    for (let i = 0; i < 4; i++) {
        const cx  = rng.range(500, W - 500);
        const cy  = rng.range(500, W - 500);
        if (Math.hypot(cx - half, cy - half) < 400) { i--; continue; }
        const sz  = rng.range(160, 280) | 0;
        const t   = 20; const gap = 60;
        pushObs({ x: cx - gap/2 - (sz-gap)/4, y: cy - sz/2, w: (sz-gap)/2, h: t, emoji: '🧱', type: 'wall', es: 1 });
        pushObs({ x: cx + gap/2 + (sz-gap)/4, y: cy - sz/2, w: (sz-gap)/2, h: t, emoji: '🧱', type: 'wall', es: 1 });
        pushObs({ x: cx, y: cy + sz/2, w: sz, h: t, emoji: '🧱', type: 'wall', es: 1 });
        pushObs({ x: cx - sz/2, y: cy, w: t, h: sz, emoji: '🧱', type: 'wall', es: 1 });
        pushObs({ x: cx + sz/2, y: cy, w: t, h: sz, emoji: '🧱', type: 'wall', es: 1 });
    }

    // ──────────────────────────────────────────────────────────────────────────────────────
    //  10. DECORATIVE ARENAS (circles)
    // ──────────────────────────────────────────────────────────────────────────────────────
    obstacles.push({ x: W*0.2, y: W*0.2, w:5, h:5, emoji:'🏟️', type:'arena', radius:200, es:3, flags:0 });
    obstacles.push({ x: W*0.8, y: W*0.8, w:5, h:5, emoji:'🏟️', type:'arena', radius:180, es:3, flags:0 });

    // ──────────────────────────────────────────────────────────────────────────────────────
    //  11. GAS BARRELS — destructible (hp: 40), AOE explosion on death
    //      Flagged 0 = passthrough for entity movement, but bullets deal damage
    // ──────────────────────────────────────────────────────────────────────────────────────
    for (let i = 0; i < 18; i++) {
        const x = rng.range(200, W - 200), y = rng.range(200, W - 200);
        if (Math.hypot(x - half, y - half) < 200) { i--; continue; }
        obstacles.push({ x, y, w:60, h:60, emoji:'⛽', type:'gas', es:1.6,
                          hp:40, maxHp:40, dead:false, flags:0 });
    }

    // ──────────────────────────────────────────────────────────────────────────────────────
    //  12. TNT BARRELS — enemy proximity detonation
    // ──────────────────────────────────────────────────────────────────────────────────────
    for (let i = 0; i < 12; i++) {
        const x = rng.range(200, W - 200), y = rng.range(200, W - 200);
        if (Math.hypot(x - half, y - half) < 180) { i--; continue; }
        obstacles.push({ x, y, w:28, h:28, emoji:'🧨', type:'tnt', es:1.0,
                          active:true, flags:0 });
    }

    // ──────────────────────────────────────────────────────────────────────────────────────
    //  13. ACID POOLS — slow + DoT
    // ──────────────────────────────────────────────────────────────────────────────────────
    for (let i = 0; i < 10; i++) {
        const x = rng.range(200, W - 200), y = rng.range(200, W - 200);
        if (Math.hypot(x - half, y - half) < 180) { i--; continue; }
        const r = rng.range(40, 80) | 0;
        obstacles.push({ x, y, w:r*2, h:r*2, emoji:'☣️', type:'acid', es:1.0,
                          radius:r, flags:0 });
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
            // ── Joystick : moitié DROITE de l'écran ─────────────────────────────────────
            //    L'ability (explosion) est déclenchée depuis la moitié GAUCHE.
            //    Cette inversion libère la main droite pour la visibilité mini-map.
            if (t.clientX >= innerWidth / 2 && !joystick.active) {
                joystick.active = true; joystick.touchId = t.identifier;
                joystick.baseX = t.clientX; joystick.baseY = t.clientY;
                joystick.dx = 0; joystick.dy = 0;
                base.style.left = (t.clientX - 65) + 'px';
                base.style.top  = (t.clientY - 65) + 'px';
                base.style.position = 'absolute';
                base.style.display = 'block';
                knob.style.transform = 'translate(-50%,-50%)';
            } else if (t.clientX < innerWidth / 2 && GS === 'playing') {
                // Tap gauche → ability
                useAbility();
            }
        });
    }, { passive: false });

    canvas.addEventListener('touchmove', e => {
        e.preventDefault();
        Array.from(e.changedTouches).forEach(t => {
            if (t.identifier === joystick.touchId) {
                const rawDx = t.clientX - joystick.baseX;
                const rawDy = t.clientY - joystick.baseY;
                const rawDist = Math.sqrt(rawDx * rawDx + rawDy * rawDy);
                const clampedDist = Math.min(CFG.JOYSTICK_MAX_RADIUS, rawDist);
                const ang = Math.atan2(rawDy, rawDx);

                // ── DEADZONE: ignore micro-movements, avoid drift ────────────────────────
                const normalised = clampedDist / CFG.JOYSTICK_MAX_RADIUS;
                if (normalised < CFG.JOYSTICK_DEADZONE) {
                    joystick.dx = 0; joystick.dy = 0;
                    knob.style.transform = 'translate(-50%,-50%)';
                    return;
                }
                // ── Proportional acceleration: response scales with displacement ─────────
                const response = (normalised - CFG.JOYSTICK_DEADZONE) / (1 - CFG.JOYSTICK_DEADZONE);
                joystick.dx = Math.cos(ang) * response;
                joystick.dy = Math.sin(ang) * response;
                knob.style.transform = `translate(calc(-50% + ${Math.cos(ang) * clampedDist}px), calc(-50% + ${Math.sin(ang) * clampedDist}px))`;
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
    // Broadcast explosion FX to nearby players
    if (gameMode === 'client' && hostConn?.open) {
        hostConn.send({ t: 'fx', k: 'blast', x: Math.round(player.x), y: Math.round(player.y) });
    } else if (isHost) {
        broadcastFXToNearby('blast', player.x, player.y, null);
    }
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

    // Deferred obsGrid rebuild: triggered when a destructible obstacle dies.
    // Checked here (once per frame) rather than inline at destruction site
    // to batch-coalesce multiple simultaneous destructions.
    if (obsGridDirty) buildObsGrid();

    // Difficulty scaling — 15% per wave
    if (gameMode !== 'client' && Date.now() - stats.lastDiff > CFG.DIFF_INTERVAL) {
        stats.diffLevel += CFG.DIFF_RATE;
        maxEnemies = Math.min(CFG.MAX_ENEMY_CAP, Math.floor(20 * stats.diffLevel));
        spawnRate = Math.max(300, 2000 / stats.diffLevel);
        stats.lastDiff = Date.now();
        currentWave++;
        stats.wave = currentWave;
        document.getElementById('waveDisplay').textContent = 'VAGUE ' + currentWave;

        // === WAVE CREATURE UNLOCK ANNOUNCE ===
        for (const k in ET) {
            if (ET[k].minWave === currentWave) {
                showToast(`🚨 Vague ${currentWave} : ${ET[k].emoji} ${k.charAt(0).toUpperCase() + k.slice(1)} débarque !`);
                break; // Show one toast per wave
            }
        }

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
    // Acid pool slow: 40% speed reduction for 500ms after touching acid
    const acidMult = (player.acidSlowTimer > 0) ? 0.6 : 1.0;
    if (player.acidSlowTimer > 0) player.acidSlowTimer -= dt;
    // Bush slow: 20% reduction while inside a bush (set by checkEntityObsCollision)
    const bushMult = player.inBush ? 0.8 : 1.0;
    const spd = (player.speed + player.bonuses.speed) * bootsSpeedMult * acidMult * bushMult;
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

    // ── Acid pool hazard: slow + damage over time ──────────────────────────────────────────────
    for (const obs of obstacles) {
        if (obs.type !== 'acid') continue;
        if (Math.hypot(player.x - obs.x, player.y - obs.y) < obs.radius + player.size) {
            // Slow: reduce speed multiplier by 40% (applied next frame via acidSlowTimer)
            player.acidSlowTimer = 500; // ms of slow remaining
            player.health -= 0.04 * dt / 16; // 0.04 HP/frame ≈ 2.4 HP/s
            if (Math.random() < 0.04 && onScreen(obs.x, obs.y, obs.radius + 10))
                spawnParticle(player.x, player.y, '#00e676', 3, 0.5);
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

    // Detect current biome from normalised player position
    const nx = player.x / CFG.WORLD;
    const ny = player.y / CFG.WORLD;
    let nearest = BIOMES[0], nearestD = Infinity;
    for (const b of BIOMES) {
        const d = Math.hypot(nx - b.cx, ny - b.cy);
        if (d < nearestD) { nearestD = d; nearest = b; }
    }
    currentBiome = nearest;
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
                // Broadcast mine FX to nearby players
                if (gameMode === 'client' && hostConn?.open) {
                    hostConn.send({ t: 'fx', k: 'mine', x: Math.round(mine.x), y: Math.round(mine.y) });
                } else if (isHost) {
                    broadcastFXToNearby('mine', mine.x, mine.y, null);
                }
                mine.active = false;
                break;
            }
        }
    }
}

// ===================================================================
//  PROJECTILES (swap-and-pop)
// ===================================================================

// explodeGasBarrel — centralised gas barrel detonation.
// Marks dead, triggers particle burst via pool, sets obsGridDirty for
// deferred grid rebuild next frame (avoids mid-frame pointer invalidation).
function explodeGasBarrel(obs) {
    obs.dead = true;
    obsGridDirty = true; // schedule grid rebuild for next frame
    const ex = obs.x, ey = obs.y;
    // AOE damage — all enemies within 160px
    for (let ei = enemies.length - 1; ei >= 0; ei--) {
        if (Math.hypot(enemies[ei].x - ex, enemies[ei].y - ey) < 160)
            damageEnemy(enemies[ei], 55, 'me');
    }
    // Player friendly-fire (barrels are environment, not player weapons)
    if (player.alive && Math.hypot(player.x - ex, player.y - ey) < 160) {
        player.health -= 15 * (1 + 0.1 * player.bonuses.boots);
    }
    if (onScreen(ex, ey, 180)) {
        for (let p = 0; p < 24; p++) spawnParticle(ex, ey, '#ff9800', 4 + Math.random() * 6);
        for (let p = 0; p < 12; p++) spawnParticle(ex, ey, '#ffff00', 3 + Math.random() * 4, 1.2);
        shakeCamera(14);
    }
    if (isHost)   broadcastFXToNearby('blast', ex, ey, null);
    if (gameMode === 'client' && hostConn?.open)
        hostConn.send({ t: 'fx', k: 'blast', x: Math.round(ex), y: Math.round(ey) });
}
function spawnProj(x, y, angle, damage, size = 5, ricochet = 0, owner = 'me') {
    projectiles.push({
        x, y, prevX: x, prevY: y, angle,
        vx: Math.cos(angle) * 10, vy: Math.sin(angle) * 10,
        damage, size, owner, ricochet, bounces: 0,
    });
}

// Segment–AABB intersection test used for anti-tunneling.
// Returns true if the segment (x0,y0)→(x1,y1) intersects the AABB (l,r,t,b).
function _segAABB(x0, y0, x1, y1, l, r, t, b) {
    // Early accept: either endpoint inside
    if (x0 >= l && x0 <= r && y0 >= t && y0 <= b) return true;
    if (x1 >= l && x1 <= r && y1 >= t && y1 <= b) return true;
    // Slab method — check each axis interval overlap
    let tMin = 0, tMax = 1;
    const dx = x1 - x0, dy = y1 - y0;
    if (Math.abs(dx) > 1e-6) {
        const tx1 = (l - x0) / dx, tx2 = (r - x0) / dx;
        tMin = Math.max(tMin, Math.min(tx1, tx2));
        tMax = Math.min(tMax, Math.max(tx1, tx2));
    } else if (x0 < l || x0 > r) return false;
    if (Math.abs(dy) > 1e-6) {
        const ty1 = (t - y0) / dy, ty2 = (b - y0) / dy;
        tMin = Math.max(tMin, Math.min(ty1, ty2));
        tMax = Math.min(tMax, Math.max(ty1, ty2));
    } else if (y0 < t || y0 > b) return false;
    return tMin <= tMax;
}

function updateProjectiles(dt) {
    for (let i = projectiles.length - 1; i >= 0; i--) {
        const p = projectiles[i];
        // Store previous position for ray-cast tunneling fix
        p.prevX = p.x; p.prevY = p.y;
        p.x += p.vx; p.y += p.vy;

        if (p.x < 0 || p.x > CFG.WORLD) { if (p.bounces < p.ricochet) { p.vx *= -1; p.bounces++; } else { swapPop(projectiles, i); continue; } }
        if (p.y < 0 || p.y > CFG.WORLD) { if (p.bounces < p.ricochet) { p.vy *= -1; p.bounces++; } else { swapPop(projectiles, i); continue; } }
        if (p.x < -100 || p.x > CFG.WORLD + 100 || p.y < -100 || p.y > CFG.WORLD + 100) { swapPop(projectiles, i); continue; }

        queryNearbyObs(p.x, p.y);
        let hitObs = false;
        for (let j = 0; j < _obsQueryLen; j++) {
            const obs = _obsQueryBuf[j];
            if (obs.dead) continue;

            // ── Gas barrel: bullet deals damage, detonates on hp ≤ 0 ──────────────────
            if (obs.type === 'gas' && !obs.dead) {
                const ol = obs.x - obs.w/2 - 6, or_ = obs.x + obs.w/2 + 6;
                const ot = obs.y - obs.h/2 - 6, ob_ = obs.y + obs.h/2 + 6;
                if (_segAABB(p.prevX, p.prevY, p.x, p.y, ol, or_, ot, ob_)) {
                    obs.hp -= p.damage;
                    if (obs.hp <= 0) explodeGasBarrel(obs);
                    swapPop(projectiles, i);
                    hitObs = true;
                    break;
                }
                continue; // gas doesn't block non-damaging pass if hp still > 0 here
            }

            if (obs.type === 'acid' || obs.type === 'arena' || obs.type === 'bush') continue;
            // Skip non-blocker flags (tnt handled below, gas handled above)
            if (!(obs.flags & OBS_F.BLOCKER)) continue;

            const ol = obs.x - obs.w / 2 - 4, or_ = obs.x + obs.w / 2 + 4;
            const ot = obs.y - obs.h / 2 - 4, ob_ = obs.y + obs.h / 2 + 4;
            // Ray-cast from prevPos to curPos — catches tunneling on lag spikes
            if (_segAABB(p.prevX, p.prevY, p.x, p.y, ol, or_, ot, ob_)) {
                if (obs.type === 'tnt' && obs.active) {
                    // Bullet hitting TNT detonates it
                    obs.active = false;
                    const ex = obs.x, ey = obs.y;
                    for (let ei2 = enemies.length - 1; ei2 >= 0; ei2--) {
                        if (Math.hypot(enemies[ei2].x - ex, enemies[ei2].y - ey) < 120)
                            damageEnemy(enemies[ei2], 80, 'me');
                    }
                    if (onScreen(ex, ey, 130)) {
                        for (let pp2 = 0; pp2 < 20; pp2++) spawnParticle(ex, ey, '#ff6600', 5 + Math.random() * 5);
                        shakeCamera(12);
                    }
                }
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

    // ── Build wave-filtered weighted pool (Zero GC: reuse _spawnPool array) ──────────────
    _spawnPool.length = 0;
    let totalWeight = 0;
    for (const k in ET) {
        if (currentWave >= ET[k].minWave) {
            _spawnPool.push(k);
            totalWeight += ET[k].weight;
        }
    }
    // Weighted random pick without any object allocation
    let rnd = Math.random() * totalWeight;
    let type = _spawnPool[0]; // safe fallback: zombie always present
    for (let pi = 0; pi < _spawnPool.length; pi++) {
        rnd -= ET[_spawnPool[pi]].weight;
        if (rnd <= 0) { type = _spawnPool[pi]; break; }
    }

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
        ghost: td.ghost, shooter: td.shooter, charger: td.charger, toxic: td.toxic,
        spider: td.spider, dragon: td.dragon,
        kamikaze: td.kamikaze || false, healer: td.healer || false, sniper: td.sniper || false,
        angle2: 0, moveAngle: 0,
        charging: false, chargeDir: 0, chargeTimer: 0, lastShot: 0, slowTimer: 0,
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

        // ── Capture pre-movement position to compute moveAngle (Zero GC) ──────────────────
        const prevX = e.x, prevY = e.y;

        // ============================================================
        //  RAYCAST WALL DETECTION
        //  Cast a ray forward (in move direction). If it hits an obs,
        //  calculate a lateral steer force to slide around it.
        // ============================================================
        let wallForceX = 0, wallForceY = 0;
        if (!e.ghost) {
            const rayLen = e.size * 2.5 + 20;
            const ndx = dx / dist, ndy = dy / dist;
            const rayX = e.x + ndx * rayLen;
            const rayY = e.y + ndy * rayLen;
            queryNearbyObs(rayX, rayY);
            for (let oi = 0; oi < _obsQueryLen; oi++) {
                const obs = _obsQueryBuf[oi];
                // Only solid+blocker obstacles matter for wall avoidance steering
                if (!(obs.flags & OBS_F.SOLID) || obs.dead) continue;
                const ol = obs.x - obs.w / 2, or_ = obs.x + obs.w / 2;
                const ot = obs.y - obs.h / 2, ob_ = obs.y + obs.h / 2;
                if (rayX > ol && rayX < or_ && rayY > ot && rayY < ob_) {
                    // Wall ahead! Compute perpendicular lateral force.
                    // Pick and remember a side-preference to avoid oscillation.
                    if (e._lateralSign === undefined) e._lateralSign = (Math.random() < 0.5) ? 1 : -1;
                    // Perpendicular to movement direction (rotated 90°)
                    wallForceX = -ndy * e._lateralSign;
                    wallForceY =  ndx * e._lateralSign;
                    break;
                }
            }
        }

        // ============================================================
        //  MOVEMENT — with per-type Smart Steering
        // ============================================================
        if (e.dragon) {
            // ── DRAGON: vole (ghost=true, ignore murs) + charge + souffle de feu ────────
            // Move aggressively toward player at full speed
            e.x += (dx / dist) * spd;
            e.y += (dy / dist) * spd;
            // Charge dash when close
            if (!e.charging && dist < 400) {
                e.charging = true; e.chargeDir = Math.atan2(dy, dx); e.chargeTimer = 500;
            }
            if (e.charging) {
                e.x += Math.cos(e.chargeDir) * spd * 4.0;
                e.y += Math.sin(e.chargeDir) * spd * 4.0;
                e.chargeTimer -= dt;
                if (e.chargeTimer <= 0) e.charging = false;
            }
            // Fire breath: spread of 3 projectiles every 1.2s
            if (now - e.lastShot > 1200 && dist < 480) {
                const baseAng = Math.atan2(dy, dx);
                spawnProj(e.x, e.y, baseAng,        e.damage,       7, 0, e.id);
                spawnProj(e.x, e.y, baseAng + 0.22, e.damage * 0.6, 5, 0, e.id);
                spawnProj(e.x, e.y, baseAng - 0.22, e.damage * 0.6, 5, 0, e.id);
                e.lastShot = now;
                if (onScreen(e.x, e.y, 60) && showDeathParticles) {
                    for (let fp = 0; fp < 4; fp++)
                        spawnParticle(e.x + Math.cos(baseAng) * 20, e.y + Math.sin(baseAng) * 20, '#ff4400', 4 + Math.random() * 3, 0.4);
                }
            }
        } else if (e.kamikaze) {
            // ── KAMIKAZE: marche normalement, puis accélération brutale à portée ──────────
            // Phase 1 — Approche lente tant que loin
            // Phase 2 — Dash frénétique à < 350px
            if (!e._kamiDash && dist < 350) {
                // Activer le dash : mémoriser direction + timer
                e._kamiDash = true;
                e._kamiDir  = Math.atan2(dy, dx);
                e._kamiTimer = 800; // ms
            }
            if (e._kamiDash) {
                e._kamiTimer -= dt;
                if (e._kamiTimer <= 0) e._kamiDash = false; // reset si raté
                e.x += Math.cos(e._kamiDir) * spd * 4.5 + wallForceX * spd;
                e.y += Math.sin(e._kamiDir) * spd * 4.5 + wallForceY * spd;
            } else {
                e.x += (dx / dist) * spd * 0.85 + wallForceX * spd;
                e.y += (dy / dist) * spd * 0.85 + wallForceY * spd;
            }
        } else if (e.healer) {
            // ── SOIGNEUR: fuit le joueur, reste à distance, soigne les alliés proches ─────
            //   Fuir si le joueur est trop proche (< 250px), sinon stationner
            if (dist < 280) {
                // Recule à l'opposé du joueur
                e.x -= (dx / dist) * spd * 1.1 + wallForceX * spd;
                e.y -= (dy / dist) * spd * 1.1 + wallForceY * spd;
            } else if (dist > 450) {
                // S'approche doucement si trop loin des alliés
                e.x += (dx / dist) * spd * 0.4;
                e.y += (dy / dist) * spd * 0.4;
            }
            // Soigner les alliés proches via la grille ennemie (O(1)) toutes les 1.5s
            if (now - (e.lastShot || 0) > 1500) {
                e.lastShot = now;
                queryEnemiesNear(e.x, e.y);
                for (let k2 = 0; k2 < _egBufLen; k2++) {
                    const ally = enemies[_egBuf[k2]];
                    if (!ally || ally === e) continue;
                    const healDist = Math.hypot(ally.x - e.x, ally.y - e.y);
                    if (healDist < CFG.EGRID_CELL * 1.5) {
                        ally.health = Math.min(ally.maxHealth, ally.health + 12);
                        // Particule de soin verte sur l'allié soigné
                        if (onScreen(ally.x, ally.y, ally.size + 10) && showDeathParticles)
                            spawnParticle(ally.x, ally.y, '#00e676', 3, 0.6);
                    }
                }
            }
        } else if (e.sniper) {
            // ── SNIPER: s'approche jusqu'à sa position de tir, puis STOP + vise + tire ────
            //   Zone de confort : 260–360px. Dans cette zone, il s'immobilise et charge son tir.
            const sniperMin = 260, sniperMax = 380;
            if (dist > sniperMax) {
                // Approche à vitesse normale
                e.x += (dx / dist) * spd + wallForceX * spd;
                e.y += (dy / dist) * spd + wallForceY * spd;
                e._sniperCharging = false;
            } else if (dist < sniperMin) {
                // Trop proche : recule
                e.x -= (dx / dist) * spd * 0.8;
                e.y -= (dy / dist) * spd * 0.8;
                e._sniperCharging = false;
            } else {
                // Dans la zone : chargement du tir (2.5s de charge)
                e._sniperCharging = true;
                e._sniperCharge = (e._sniperCharge || 0) + dt;
                if (e._sniperCharge >= 2500 && now - e.lastShot > 500) {
                    // Tir chargé : 1 projectile lent mais énorme
                    const sniperAng = Math.atan2(dy, dx);
                    // Le projectile sniper est lent (spd 4) mais grand (sz 10) et très puissant
                    projectiles.push({
                        x: e.x, y: e.y, angle: sniperAng,
                        vx: Math.cos(sniperAng) * 4, vy: Math.sin(sniperAng) * 4,
                        damage: e.damage * 1.5, size: 10, owner: e.id, ricochet: 0, bounces: 0,
                        prevX: e.x, prevY: e.y, // track previous pos for tunneling correction
                    });
                    e.lastShot = now;
                    e._sniperCharge = 0;
                    // Visual flash
                    if (onScreen(e.x, e.y, 40)) shakeCamera(3);
                }
            }
        } else if (e.charger) {
            if (!e.charging && dist < 500) {
                e.charging = true; e.chargeDir = Math.atan2(dy, dx); e.chargeTimer = 700;
            }
            if (e.charging) {
                e.x += Math.cos(e.chargeDir) * spd * 3.5;
                e.y += Math.sin(e.chargeDir) * spd * 3.5;
                e.chargeTimer -= dt;
                if (e.chargeTimer <= 0) e.charging = false;
            } else {
                e.x += (dx / dist) * spd * 0.6 + wallForceX * spd;
                e.y += (dy / dist) * spd * 0.6 + wallForceY * spd;
            }
        } else if (e.shooter) {
            if (dist > 180) {
                e.x += (dx / dist) * spd + wallForceX * spd;
                e.y += (dy / dist) * spd + wallForceY * spd;
            } else {
                e.x -= (dx / dist) * spd * 0.15 + wallForceX * spd * 0.15;
                e.y -= (dy / dist) * spd * 0.15 + wallForceY * spd * 0.15;
            }
            if (now - e.lastShot > 1800 && dist < 320) {
                spawnProj(e.x, e.y, Math.atan2(dy, dx), e.damage, 6, 0, e.id);
                e.lastShot = now;
            }
        } else {
            // Regular enemies: blend move-toward-player with wall-avoidance lateral
            const wallBlend = wallForceX !== 0 ? 1.8 : 0; // amplify lateral when wall is close
            e.x += (dx / dist) * spd + wallForceX * spd * wallBlend;
            e.y += (dy / dist) * spd + wallForceY * spd * wallBlend;
        }

        if (!e.ghost) checkEntityObsCollision(e);
        // Bush slow: 20% speed penalty when inside a bush overlay area.
        // inBush is set by checkEntityObsCollision using OBS_F.BUSH bitmask.
        if (e.inBush) spd *= 0.8;

        // ── Compute actual movement angle from pre/post positions (Zero GC, no new obj) ──
        const mdx = e.x - prevX, mdy = e.y - prevY;
        const mlen = mdx * mdx + mdy * mdy; // squared, compare to threshold squared
        if (mlen > 0.04) e.moveAngle = Math.atan2(mdy, mdx); // update only when actually moving

        // ============================================================
        //  STUCK DETECTION — if barely moved, give random lateral kick
        // ============================================================
        if (e._lastX !== undefined) {
            const movedD = Math.hypot(e.x - e._lastX, e.y - e._lastY);
            if (movedD < 0.4) {
                e._stuckTimer = (e._stuckTimer || 0) + dt;
                if (e._stuckTimer > 700) {
                    // Kick sideways and flip side preference
                    const kick = 14 + Math.random() * 10;
                    e._lateralSign = (e._lateralSign === undefined ? 1 : -e._lateralSign);
                    const perpX = -(dy / dist), perpY = (dx / dist);
                    e.x += perpX * kick * e._lateralSign;
                    e.y += perpY * kick * e._lateralSign;
                    e._stuckTimer = 0;
                }
            } else {
                e._stuckTimer = 0;
                // Once moving freely, let it re-pick lateral side
                if (wallForceX === 0) e._lateralSign = undefined;
            }
        }
        e._lastX = e.x; e._lastY = e.y;

        // ============================================================
        //  SEPARATION FORCE — via EGRID spatial grid (O(1) neighbour
        //  lookup vs old O(n·W) windowed scan). Keeps formations loose
        //  while still steering the horde toward the player.
        // ============================================================
        if (onScreen(e.x, e.y, 200)) {
            queryEnemiesNear(e.x, e.y);
            for (let k = 0; k < _egBufLen; k++) {
                const j = _egBuf[k];
                if (j === i) continue;
                const oth = enemies[j];
                if (!oth) continue;
                const sdx = e.x - oth.x, sdy = e.y - oth.y;
                const sd2 = sdx * sdx + sdy * sdy;
                const minD = (e.size + oth.size) * 0.7;
                if (sd2 < minD * minD && sd2 > 0.0001) {
                    const sd = Math.sqrt(sd2);
                    // Separation force — slightly dampened to keep horde cohesion
                    const force = (minD - sd) / minD * CFG.SEP_FORCE * 0.85;
                    e.x += (sdx / sd) * force;
                    e.y += (sdy / sd) * force;
                }
            }
        }

        e.x = Math.max(0, Math.min(CFG.WORLD, e.x));
        e.y = Math.max(0, Math.min(CFG.WORLD, e.y));

        // ── TNT barrel proximity: explode if enemy steps within trigger radius ────────────────
        for (let oi = 0; oi < obstacles.length; oi++) {
            const obs = obstacles[oi];
            if (obs.type !== 'tnt' || !obs.active) continue;
            if (Math.hypot(e.x - obs.x, e.y - obs.y) < 32 + e.size) {
                // Explode: AOE 120px, high damage
                obs.active = false;
                const ex = obs.x, ey = obs.y;
                for (let ei2 = enemies.length - 1; ei2 >= 0; ei2--) {
                    if (Math.hypot(enemies[ei2].x - ex, enemies[ei2].y - ey) < 120)
                        damageEnemy(enemies[ei2], 80, 'me');
                }
                if (Math.hypot(player.x - ex, player.y - ey) < 120 && player.alive) {
                    const bootsMult = 1 + 0.1 * player.bonuses.boots;
                    player.health -= 20 * bootsMult;
                }
                if (onScreen(ex, ey, 130)) {
                    for (let p = 0; p < 20; p++) spawnParticle(ex, ey, '#ff6600', 5 + Math.random() * 5);
                    for (let p = 0; p < 10; p++) spawnParticle(ex, ey, '#ffdd00', 4 + Math.random() * 4, 1.4);
                    shakeCamera(12);
                }
                if (isHost) broadcastFXToNearby('blast', ex, ey, null);
                if (gameMode === 'client' && hostConn?.open) hostConn.send({ t: 'fx', k: 'blast', x: Math.round(ex), y: Math.round(ey) });
                break;
            }
        }

        // Walk animation clock (used for squash/stretch in draw)
        e.angle2 = (e.angle2 || 0) + spd * 0.08;
        // Decay impact flash
        if (e.flashTimer > 0) e.flashTimer -= dt / 1000;

        // Toxic cloud
        if (e.toxic && dist < 120 && player.alive && !spectatorMode) {
            player.health -= 0.02 * dt / 16;
            if (Math.random() < 0.03 && onScreen(e.x, e.y, 30))
                spawnParticle(e.x + (Math.random() - 0.5) * 30, e.y + (Math.random() - 0.5) * 30, '#a5d6a7', 4, 0.6);
        }
    }
}

// ===================================================================
//  COLLISION HELPERS — Logic layer (no rendering, no allocs)
// ===================================================================

// checkEntityObsCollision — resolves solid obstacle penetration for any entity.
// Uses obs.flags bitmask to classify behaviour in O(1) instead of string comparison.
//   OBS_F.SOLID   → AABB push-out (standard walls, boxes, buildings)
//   OBS_F.CIRCULAR → circle-vs-circle trunk collision (trees)
//   OBS_F.BUSH    → no push-out, but sets entity.inBush flag for slow check
// Entities must have {x, y, size, inBush?}.
function checkEntityObsCollision(entity) {
    entity.inBush = false; // reset per-frame; set true if inside any bush
    queryNearbyObs(entity.x, entity.y);
    for (let i = 0; i < _obsQueryLen; i++) {
        const obs = _obsQueryBuf[i];
        if (obs.dead) continue;

        // ── Bush: no push-out, just flag the entity ───────────────────
        if (obs.flags & OBS_F.BUSH) {
            if (Math.hypot(entity.x - obs.x, entity.y - obs.y) < obs.radius + entity.size)
                entity.inBush = true;
            continue;
        }

        // ── Non-solid passthrough obstacles ───────────────────────────
        if (!(obs.flags & OBS_F.SOLID)) continue;

        if (obs.flags & OBS_F.CIRCULAR) {
            // ── Tree trunk: circle–circle push-out ────────────────────
            // Only the trunk (trunkR) creates solid collision;
            // the foliage (foliageR) is purely decorative.
            const tR = (obs.trunkR || 8) + entity.size;
            const dx = entity.x - obs.x, dy = entity.y - obs.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < tR * tR && d2 > 0.0001) {
                const d = Math.sqrt(d2);
                const pen = tR - d;
                entity.x += (dx / d) * pen;
                entity.y += (dy / d) * pen;
            }
        } else {
            // ── AABB push-out ──────────────────────────────────────────
            const el = entity.x - entity.size, er = entity.x + entity.size;
            const et = entity.y - entity.size, eb = entity.y + entity.size;
            const ol = obs.x - obs.w / 2, or_ = obs.x + obs.w / 2;
            const ot = obs.y - obs.h / 2, ob_ = obs.y + obs.h / 2;
            if (er > ol && el < or_ && eb > ot && et < ob_) {
                const ox = Math.min(er - ol, or_ - el);
                const oy = Math.min(eb - ot, ob_ - et);
                if (ox < oy) entity.x += entity.x < obs.x ? -ox : ox;
                else         entity.y += entity.y < obs.y ? -oy : oy;
            }
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
                // === SCREEN SHAKE on player damage ===
                shakeCamera(10);
                // Spawn more intense hit particles
                for (let _hp = 0; _hp < 6; _hp++) spawnParticle(player.x, player.y, '#ff4444', 3 + Math.random() * 3);
            }
        }
        // Spider slow web
        if (en.spider && Math.hypot(en.x - player.x, en.y - player.y) < en.size * 2.5) {
            player.x += (player.x - en.x) * 0.001;
        }
        // Dragon terror aura: drains HP even without direct contact (aura radius 120px)
        if (en.dragon && Math.hypot(en.x - player.x, en.y - player.y) < 120 && now - player._lastHit > 600) {
            player.health -= en.damage * 0.08;
            player._lastHit = now;
            if (onScreen(en.x, en.y, 30)) spawnParticle(player.x, player.y, '#ff1744', 3, 0.6);
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
    // === IMPACT FLASH: enemy flashes white when hit ===
    en.flashTimer = 0.3;
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
    if (showDeathParticles && onScreen(en.x, en.y, en.size + 20)) {
        // Dragon and other bosses get dramatic death explosions
        const isBoss = en.type === 'alien' || en.type === 'minotaur' || en.type === 'dragon';
        const pCount = isBoss ? 25 : 5;
        for (let i = 0; i < pCount; i++) spawnParticle(en.x, en.y, en.color, 3 + Math.random() * 5);
        if (en.type === 'dragon') {
            // Extra fire burst on dragon death
            for (let i = 0; i < 12; i++) spawnParticle(en.x, en.y, '#ff6600', 5 + Math.random() * 4, 1.4);
        }
        if (isBoss) shakeCamera(en.type === 'dragon' ? 20 : 14);
    } else if (!showDeathParticles && onScreen(en.x, en.y, en.size + 20)) {
        const isBoss = en.type === 'alien' || en.type === 'minotaur' || en.type === 'dragon';
        if (isBoss) shakeCamera(en.type === 'dragon' ? 20 : 14);
    }
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
    // Restore saved aura color
    const savedAuraInit = localStorage.getItem('sio_aura');
    if (savedAuraInit) playerAuraColor = savedAuraInit;
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

    // Tint minimap background with current biome colour
    mctx.fillStyle = currentBiome.ambientCol || 'rgba(20,20,60,0.3)';
    mctx.fillRect(0, 0, S, S);

    mctx.fillStyle = 'rgba(255,255,255,0.12)';
    for (const obs of obstacles) {
        if (obs.dead) continue;
        if (obs.type === 'arena' || obs.type === 'acid' || obs.type === 'bush') continue;
        if (obs.type === 'tnt') {
            mctx.fillStyle = 'rgba(255,80,20,0.6)';
            mctx.fillRect(obs.x * scale - 1, obs.y * scale - 1, 2, 2);
            mctx.fillStyle = 'rgba(255,255,255,0.12)';
        } else {
            mctx.fillRect(obs.x * scale - 1, obs.y * scale - 1, 2, 2);
        }
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
    mctx.fillStyle = spectatorMode ? 'rgba(255,255,255,0.4)' : playerAuraColor;
    mctx.beginPath(); mctx.arc(player.x * scale, player.y * scale, 4, 0, Math.PI * 2); mctx.fill();

    mctx.strokeStyle = 'rgba(255,255,255,0.3)'; mctx.lineWidth = 1.5;
    mctx.strokeRect(0, 0, S, S);

    // Biome name label inside minimap
    mctx.fillStyle = 'rgba(255,255,255,0.55)';
    mctx.font = '8px sans-serif'; mctx.textAlign = 'center'; mctx.textBaseline = 'bottom';
    mctx.fillText(currentBiome.name, S / 2, S - 3);
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
    // ── Biome-aware ground gradient — colors from currentBiome ──────────────────────────────────
    const grad = ctx.createLinearGradient(0, 0, 0, W);
    grad.addColorStop(0, currentBiome.groundA);
    grad.addColorStop(0.5, currentBiome.groundB);
    grad.addColorStop(1, currentBiome.groundA);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, W);

    // ── Ambient glow overlay (biome atmosphere) ──────────────────────────────────────────────────
    if (!perfMode) {
        ctx.fillStyle = currentBiome.ambientCol;
        ctx.fillRect(0, 0, W, W);
    }

    // ── Grid lines tinted with biome colour ─────────────────────────────────────────────────────
    ctx.strokeStyle = currentBiome.gridCol || 'rgba(255,255,255,0.025)'; ctx.lineWidth = 1;
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

    // ──────────────────────────────────────────────────────────────────────────────────────
    //  OBSTACLE RENDERING — multi-pass to respect natural layering:
    //    Pass 1: Acid pools & bush ground cover (always behind everything)
    //    Pass 2: Tree foliage behind entities (drawn before player/enemies)
    //    Pass 3: Solid structures, gas barrels, TNT, decorative arenas
    //    Pass 4: Tree foliage overlay in front of trunk (see render() call order)
    //
    //  Dead obstacles (gas barrels destroyed at runtime) are skipped here;
    //  they remain in the array until next buildObsGrid but are invisible.
    // ──────────────────────────────────────────────────────────────────────────────────────
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

    // ── Pass 1: Ground-level effects (acid, bush) ─────────────────────────────────────────
    for (const obs of obstacles) {
        if (obs.dead) continue;
        if (!onScreen(obs.x, obs.y, Math.max(obs.w || 100, obs.h || 100))) continue;

        if (obs.type === 'acid') {
            const pulse = perfMode ? 0.25 : 0.18 + Math.sin(Date.now() * 0.003 + obs.x * 0.001) * 0.07;
            ctx.fillStyle = `rgba(60,200,60,${pulse})`;
            ctx.beginPath(); ctx.arc(obs.x, obs.y, obs.w / 2, 0, Math.PI * 2); ctx.fill();
            if (!perfMode) {
                ctx.shadowBlur = 18; ctx.shadowColor = '#00e676';
                ctx.strokeStyle = 'rgba(80,255,80,0.4)'; ctx.lineWidth = 2;
                ctx.stroke();
                ctx.shadowBlur = 0;
            }
            ctx.font = `${obs.w * 0.35}px serif`;
            ctx.fillStyle = 'rgba(255,255,255,0.8)';
            ctx.fillText(obs.emoji, obs.x, obs.y);
            continue;
        }

        if (obs.type === 'bush') {
            // Bushes: ground-level circles with leaf texture — no shadow in perf mode
            if (!perfMode) { ctx.shadowBlur = 6; ctx.shadowColor = '#1a5c1a'; }
            const r = obs.radius || obs.w / 2;
            ctx.fillStyle = perfMode ? 'rgba(30,100,30,0.55)' : 'rgba(30,90,30,0.45)';
            ctx.beginPath(); ctx.arc(obs.x, obs.y, r, 0, Math.PI * 2); ctx.fill();
            if (!perfMode) {
                ctx.fillStyle = 'rgba(50,140,50,0.3)';
                ctx.beginPath(); ctx.arc(obs.x - r * 0.25, obs.y - r * 0.3, r * 0.65, 0, Math.PI * 2); ctx.fill();
            }
            ctx.font = `${r * 0.9}px serif`;
            ctx.fillStyle = 'rgba(255,255,255,0.8)';
            ctx.fillText(obs.emoji, obs.x, obs.y - r * 0.15);
            if (!perfMode) ctx.shadowBlur = 0;
        }
    }

    // ── Pass 2: Tree foliage BEHIND entities (gives depth illusion) ───────────────────────
    for (const obs of obstacles) {
        if (obs.dead || obs.type !== 'tree') continue;
        if (!onScreen(obs.x, obs.y, obs.foliageR || obs.w / 2)) continue;
        const fR = obs.foliageR || obs.w / 2;
        // Foliage: three overlapping circles for a canopy silhouette
        if (!perfMode) {
            ctx.fillStyle = 'rgba(10,50,10,0.55)';
            ctx.beginPath(); ctx.arc(obs.x, obs.y, fR, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = 'rgba(20,80,20,0.4)';
            ctx.beginPath(); ctx.arc(obs.x - fR * 0.3, obs.y - fR * 0.25, fR * 0.7, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(obs.x + fR * 0.25, obs.y - fR * 0.2, fR * 0.6, 0, Math.PI * 2); ctx.fill();
        } else {
            ctx.fillStyle = 'rgba(15,60,15,0.5)';
            ctx.beginPath(); ctx.arc(obs.x, obs.y, fR, 0, Math.PI * 2); ctx.fill();
        }
        // Trunk
        const tR = obs.trunkR || 8;
        ctx.fillStyle = '#5c3d1e';
        ctx.beginPath(); ctx.arc(obs.x, obs.y + fR * 0.1, tR, 0, Math.PI * 2); ctx.fill();
        // Emoji label
        ctx.font = `${tR * 2.2}px serif`;
        ctx.fillText(obs.emoji, obs.x, obs.y - fR * 0.1);
    }

    // ── Pass 3: Solid structures, TNT, gas barrels, arenas ───────────────────────────────
    for (const obs of obstacles) {
        if (obs.dead) continue;
        if (!onScreen(obs.x, obs.y, Math.max(obs.w || 100, obs.h || 100))) continue;

        if (obs.type === 'arena') {
            ctx.strokeStyle = perfMode ? 'rgba(255,200,50,0.2)' : 'rgba(255,200,50,0.3)';
            ctx.lineWidth = perfMode ? 1 : 3;
            ctx.beginPath(); ctx.arc(obs.x, obs.y, obs.radius || 150, 0, Math.PI * 2); ctx.stroke();
            if (!perfMode) {
                ctx.font = `${(obs.radius || 150) * 0.18}px serif`;
                ctx.fillText(obs.emoji, obs.x, obs.y - (obs.radius || 150) * 0.7);
            }
            continue;
        }

        if (obs.type === 'tnt') {
            if (!obs.active) continue; // detonated TNT disappears
            if (!perfMode) {
                ctx.shadowBlur = 12; ctx.shadowColor = '#ff4400';
                ctx.fillStyle = 'rgba(255,80,0,0.15)';
                ctx.beginPath(); ctx.arc(obs.x, obs.y, 60, 0, Math.PI * 2); ctx.fill();
                ctx.shadowBlur = 0;
            }
            ctx.fillStyle = 'rgba(180,30,0,0.6)';
            ctx.fillRect(obs.x - obs.w / 2, obs.y - obs.h / 2, obs.w, obs.h);
            ctx.font = `${obs.w * 0.9}px serif`;
            ctx.fillStyle = 'rgba(255,255,255,0.9)';
            ctx.fillText(obs.emoji, obs.x, obs.y);
            continue;
        }

        // ── Gas barrel with HP bar ────────────────────────────────────────────────────────
        if (obs.type === 'gas') {
            const hpPct = (obs.maxHp > 0) ? Math.max(0, obs.hp / obs.maxHp) : 1;
            if (!perfMode) {
                // Glow intensity scales with damage taken
                const dmgPct = 1 - hpPct;
                ctx.shadowBlur = 8 + dmgPct * 16; ctx.shadowColor = `rgba(255,${150 - dmgPct * 120 | 0},0,0.8)`;
            }
            ctx.fillStyle = `rgba(255,${180 - (1 - hpPct) * 130 | 0},50,0.25)`;
            ctx.fillRect(obs.x - obs.w / 2, obs.y - obs.h / 2, obs.w, obs.h);
            if (!perfMode) ctx.shadowBlur = 0;
            const fs = Math.max(16, Math.min(40, obs.w * (obs.es || 1.0) * 0.55));
            ctx.font = fs + 'px serif';
            ctx.fillText(obs.emoji, obs.x, obs.y);
            // HP bar — only show when damaged
            if (hpPct < 1) {
                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                ctx.fillRect(obs.x - obs.w / 2, obs.y - obs.h / 2 - 8, obs.w, 5);
                ctx.fillStyle = hpPct > 0.5 ? '#2ecc71' : hpPct > 0.25 ? '#ffa500' : '#f5576c';
                ctx.fillRect(obs.x - obs.w / 2, obs.y - obs.h / 2 - 8, obs.w * hpPct, 5);
            }
            continue;
        }

        // Skip bush, acid, tree — already rendered above
        if (obs.type === 'bush' || obs.type === 'acid' || obs.type === 'tree') continue;

        // ── Generic solid obstacle (wall, box, house, building) ──────────────────────────
        if (!perfMode) {
            ctx.fillStyle = 'rgba(0,0,0,0.35)';
            ctx.fillRect(obs.x - obs.w / 2 + 4, obs.y - obs.h / 2 + 4, obs.w, obs.h);
        }
        ctx.fillStyle = obs.type === 'wall'     ? 'rgba(80,80,100,0.6)'  :
                        obs.type === 'building' ? 'rgba(40,40,80,0.7)'   : 'rgba(60,60,80,0.4)';
        ctx.fillRect(obs.x - obs.w / 2, obs.y - obs.h / 2, obs.w, obs.h);
        const fs2 = Math.max(12, Math.min(40, Math.min(obs.w, obs.h) * (obs.es || 1.0) * 0.6));
        ctx.font = fs2 + 'px serif';
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

// === BATCH ENEMY RENDERING — ctx.font set once per type, transforms only for visible onscreen ===
function drawEnemiesBatched() {
    if (enemies.length === 0) return;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

    // ── Phase 1: cull and group by type (batch font set) ──────────────────────────────────
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
            ctx.shadowBlur = td.dragon ? 18 : 8;   // dragon gets a fiery glow
            ctx.shadowColor = td.dragon ? '#ff6600' : td.col;
            ctx.font = ET_FONT[type]; // Set ONCE per batch — major perf win for 600 enemies

            for (const en of batch) {
                // ── Animations: only when showAnimations=true AND enemy is non-ghost ────
                const doAnim = showAnimations && !perfMode;

                if (doAnim) {
                    // ── Squash & Stretch ─────────────────────────────────────────────────
                    //    walkSin oscillates using en.angle2 as a walk-clock
                    const walkSin = Math.sin(en.angle2 * 6.0);
                    const scaleX  = 1.0 + walkSin * 0.08;
                    const scaleY  = 1.0 - walkSin * 0.08;

                    // ── Direction-aware lean rotation ────────────────────────────────────
                    //    Extract horizontal component of movement direction to create a
                    //    "leaning toward movement" effect (max ±15° = ±0.26 rad).
                    //    Ghostly enemies get a gentle drift rotation instead.
                    let rotAngle;
                    if (en.ghost && !en.dragon) {
                        // Ghosts: ethereal slow bob, no lean
                        rotAngle = Math.sin(en.angle2 * 2.0) * 0.1;
                    } else {
                        // Lean = horizontal component of moveAngle × max lean magnitude
                        const leanX = Math.cos(en.moveAngle || 0);
                        rotAngle = leanX * 0.22 + walkSin * 0.06; // lean + walk wobble
                    }

                    ctx.save();
                    ctx.translate(en.x, en.y);
                    ctx.rotate(rotAngle);
                    ctx.scale(scaleX, scaleY);
                    if (en.ghost && !en.dragon) ctx.globalAlpha = 0.75;
                    // Dragon pulse: alternating size boost on charge
                    if (en.dragon && en.charging) ctx.scale(1.08, 1.08);
                    ctx.fillText(td.emoji, 0, 0);
                    ctx.globalAlpha = 1;
                    ctx.restore();
                } else {
                    if (en.ghost && !en.dragon) ctx.globalAlpha = 0.7;
                    ctx.fillText(td.emoji, en.x, en.y);
                    ctx.globalAlpha = 1;
                }
            }
            ctx.shadowBlur = 0;

            // ── Toxic cloud ───────────────────────────────────────────────────────────────
            if (td.toxic) {
                for (const en of batch) {
                    ctx.fillStyle = 'rgba(165,214,167,0.15)';
                    ctx.beginPath(); ctx.arc(en.x, en.y, 70, 0, Math.PI * 2); ctx.fill();
                }
            }
            // ── Dragon fire aura ──────────────────────────────────────────────────────────
            if (td.dragon && !perfMode) {
                for (const en of batch) {
                    const pulseFire = 0.08 + Math.sin(en.angle2 * 4) * 0.04;
                    const fg = ctx.createRadialGradient(en.x, en.y, 0, en.x, en.y, en.size * 2.2);
                    fg.addColorStop(0, `rgba(255,100,0,${pulseFire * 2})`);
                    fg.addColorStop(1, 'rgba(255,50,0,0)');
                    ctx.fillStyle = fg;
                    ctx.beginPath(); ctx.arc(en.x, en.y, en.size * 2.2, 0, Math.PI * 2); ctx.fill();
                }
            }
        }
    } else {
        // ── Performance mode: circles only, zero transforms ──────────────────────────────
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

    // ── Phase 2: HP bars batched (dark bg pass → fill pass = fewer state switches) ──────
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

    // ── Phase 3: impact flash overlay (single white arc per hit enemy) ───────────────────
    for (const en of visible) {
        if (!en.flashTimer || en.flashTimer <= 0) continue;
        ctx.globalAlpha = Math.min(0.9, en.flashTimer / 0.3);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(en.x, en.y, en.size + 2, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
    }

    // ── Phase 4: Special visual overlays for new enemy types ─────────────────────────────
    if (!perfMode) {
        for (const en of visible) {
            const td = ET[en.type];
            if (!td) continue;

            // Sniper: pulsing red charge ring that fills up over 2.5s
            if (td.sniper && en._sniperCharging && en._sniperCharge > 0) {
                const chargePct = Math.min(1, en._sniperCharge / 2500);
                ctx.globalAlpha = 0.7 * chargePct;
                ctx.strokeStyle = `hsl(${350 - chargePct * 80}, 100%, 60%)`;
                ctx.lineWidth = 3;
                ctx.beginPath();
                // Arc from top clockwise proportional to charge
                ctx.arc(en.x, en.y, en.size + 10, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * chargePct);
                ctx.stroke();
                // Laser sight: thin red line toward player
                ctx.globalAlpha = 0.3 * chargePct;
                ctx.strokeStyle = '#ff4081';
                ctx.lineWidth = 1;
                ctx.setLineDash([6, 6]);
                ctx.beginPath();
                ctx.moveTo(en.x, en.y);
                ctx.lineTo(player.x, player.y);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.globalAlpha = 1;
            }

            // Healer: green healing aura pulse
            if (td.healer) {
                const pulse = 0.06 + Math.sin(en.angle2 * 3) * 0.03;
                ctx.fillStyle = `rgba(0,230,118,${pulse})`;
                ctx.beginPath(); ctx.arc(en.x, en.y, en.size * 3, 0, Math.PI * 2); ctx.fill();
            }

            // Kamikaze dash warning: orange glow when charging
            if (td.kamikaze && en._kamiDash) {
                const glow = 0.12 + Math.sin(Date.now() * 0.02) * 0.06;
                ctx.fillStyle = `rgba(255,107,53,${glow})`;
                ctx.beginPath(); ctx.arc(en.x, en.y, en.size * 2.5, 0, Math.PI * 2); ctx.fill();
            }
        }
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

    // Resolve this player's aura color:
    //   local player → playerAuraColor (updated from settings)
    //   remote player → p.ac synced from sendPlayerInfo
    const auraCol = isLocal ? playerAuraColor : (p.ac || '#2ecc71');

    // === DYNAMIC PULSING AURA ===
    if (!perfMode) {
        const t = Date.now();
        const pulse = 0.12 + Math.sin(t * 0.0035) * 0.05;
        const baseR = 38;
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, baseR);
        const hexToRgba = (hex, a) => {
            const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
            return `rgba(${r},${g},${b},${a})`;
        };
        grad.addColorStop(0, hexToRgba(auraCol, pulse * 2));
        grad.addColorStop(1, hexToRgba(auraCol, 0));
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(p.x, p.y, baseR, 0, Math.PI * 2); ctx.fill();
    }

    // Bonus fire aura (local player only — remotes don't sync aura bonus count)
    if (isLocal && player.bonuses.aura > 0 && !perfMode) {
        const aurR = 80 + player.bonuses.aura * 10;
        const grad2 = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, aurR);
        grad2.addColorStop(0, 'rgba(255,100,0,0.2)');
        grad2.addColorStop(1, 'rgba(255,50,0,0)');
        ctx.fillStyle = grad2;
        ctx.beginPath(); ctx.arc(p.x, p.y, aurR, 0, Math.PI * 2); ctx.fill();
    }

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(p.x, p.y + 28, 18, 6, 0, 0, Math.PI * 2); ctx.fill();

    const sz = (p.size || 24) * 2;
    ctx.font = `${sz}px serif`;
    if (!perfMode) {
        ctx.shadowBlur = isLocal ? 18 : 8;
        ctx.shadowColor = auraCol;
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

// drawDrones — renders both local and remote player drones.
// Local drones use the live player.droneAngle (updated 60fps).
// Remote drones advance locally at the same angular velocity (0.02 rad/frame)
// from the last synced da value — this avoids jitter from 30fps network ticks
// while remaining visually accurate.
function drawDrones() {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

    // ── Local player drones ────────────────────────────────────────────────────────────────
    if (player.bonuses.drones > 0) {
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

    // ── Remote player drones — rendered locally from synced da/dn/ac ─────────────────────
    Object.values(remotePlayers).forEach(rp => {
        if (!rp.alive || !(rp.dn > 0) || rp.x === undefined) return;
        // Advance angle locally each frame (0.02 rad = ~1.1°) from last known value
        rp.da = (rp.da || 0) + 0.02;
        ctx.font = '20px serif';
        for (let i = 0; i < rp.dn; i++) {
            const ang = rp.da + i * Math.PI * 2 / rp.dn;
            const dx = rp.x + Math.cos(ang) * 60;
            const dy = rp.y + Math.sin(ang) * 60;
            if (!onScreen(dx, dy, 20)) continue;
            if (!perfMode) {
                ctx.shadowBlur = 6;
                ctx.shadowColor = rp.ac || '#667eea';
            }
            ctx.fillText('🤖', dx, dy);
            if (!perfMode) ctx.shadowBlur = 0;
            ctx.strokeStyle = `rgba(102,126,234,0.2)`; ctx.lineWidth = 1;
            ctx.setLineDash([3, 5]);
            ctx.beginPath(); ctx.moveTo(rp.x, rp.y); ctx.lineTo(dx, dy); ctx.stroke();
            ctx.setLineDash([]);
        }
    });
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
    // === CUMULATIVE STATS ===
    const cumK = parseInt(localStorage.getItem('sio_cumKills')  || '0') + player.kills;
    const cumD = parseInt(localStorage.getItem('sio_cumDeaths') || '0') + 1;
    const cumXP = parseInt(localStorage.getItem('sio_cumXP')    || '0') + player.xp;
    const cumG = parseInt(localStorage.getItem('sio_cumGames')  || '0') + 1;
    localStorage.setItem('sio_cumKills',  cumK);
    localStorage.setItem('sio_cumDeaths', cumD);
    localStorage.setItem('sio_cumXP',     cumXP);
    localStorage.setItem('sio_cumGames',  cumG);
    if (cumK >= 1000) { const t = TROPHIES.find(t => t.id === 'butcher_1000'); if (t && !t.unlocked) { t.unlocked = true; saveTrophies(); } }

    // === BEST WAVE & BEST TIME ===
    const prevBW = parseInt(localStorage.getItem('sio_bestWave') || '0');
    if (currentWave > prevBW) localStorage.setItem('sio_bestWave', currentWave);
    const prevBT = parseInt(localStorage.getItem('sio_bestTime') || '0');
    if (stats.survivalTime > prevBT) localStorage.setItem('sio_bestTime', stats.survivalTime);

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
