// ===== CONFIGURATION & CONSTANTES =====
const CONFIG = {
    WORLD_SIZE: 5000,
    CAMERA_SMOOTH: 0.1,
    ENEMY_SYNC_RATE: 33, // 30Hz
    INTERPOLATION_SPEED: 0.15, // Interpolation fluide
    MAX_PLAYERS: 10,
    ABILITY_COOLDOWN: 10000,
    STRUCTURE_SEED: 42,
    DIFFICULTY_INCREASE_INTERVAL: 30000, // 30 secondes
    DIFFICULTY_INCREASE_RATE: 0.1 // 10% d'augmentation
};

// Types de monstres avec emoji
const ENEMY_TYPES = {
    zombie: { emoji: '🧟', health: 30, speed: 1.5, damage: 10, size: 15, score: 10, color: '#95e1d3' },
    ghost: { emoji: '👻', health: 15, speed: 3, damage: 8, size: 12, score: 15, color: '#b2a4d4' },
    alien: { emoji: '👾', health: 100, speed: 1, damage: 25, size: 25, score: 50, color: '#f093fb', isBoss: true }
};

// ===== VARIABLES GLOBALES =====
let canvas, ctx;
let gameState = 'menu';
let gameMode = 'solo';
let isHost = false;
let peer = null;
let connections = [];
let hostConnection = null;
let myPeerId = '';
let roomPin = '';
let networkPing = 0;

// Joueur local
let player = {
    x: CONFIG.WORLD_SIZE / 2,
    y: CONFIG.WORLD_SIZE / 2,
    vx: 0, vy: 0,
    speed: 3,
    health: 100,
    maxHealth: 100,
    damage: 10,
    fireRate: 500,
    lastShot: 0,
    xp: 0,
    level: 1,
    xpToLevel: 100,
    score: 0,
    kills: 0,
    name: 'Joueur',
    emoji: '😎',
    size: 25,
    // BONUS CUMULABLES
    bonuses: {
        speedBonus: 0,
        damageBonus: 0,
        fireRateBonus: 0,
        healthBonus: 0
    }
};

let gameStats = {
    startTime: 0,
    survivalTime: 0,
    totalDamage: 0,
    killsByType: {},
    difficultyLevel: 1,
    lastDifficultyIncrease: 0
};

let specialAbility = { ready: true, cooldown: 0, lastUse: 0 };
let camera = { x: 0, y: 0, shake: 0, shakeX: 0, shakeY: 0 };

// Entities
let enemies = [];
let projectiles = [];
let gems = [];
let particles = [];
let damageNumbers = [];
let obstacles = [];
let remotePlayers = {};

// Input
let keys = {};
let joystick = { active: false, x: 0, y: 0, startX: 0, startY: 0 };
let isMobile = /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent);

// Wave system
let currentWave = 1;
let maxEnemies = 20;
let spawnRate = 2000;

// Trophées
const TROPHIES = [
    { id: 'first_blood', name: 'Premier Sang', desc: 'Tue ton premier zombie', icon: '🩸', unlocked: false },
    { id: 'survivor_5min', name: 'Survivant 5min', desc: 'Survis 5 minutes', icon: '⏱️', unlocked: false },
    { id: 'butcher_100', name: 'Boucher', desc: 'Tue 100 zombies', icon: '🔪', unlocked: false },
    { id: 'butcher_1000', name: 'Massacreur', desc: 'Tue 1000 zombies (cumulé)', icon: '⚔️', unlocked: false },
    { id: 'lvl_10', name: 'Niveau 10', desc: 'Atteins le niveau 10', icon: '🔟', unlocked: false },
    { id: 'score_10k', name: '10K Points', desc: 'Atteins 10000 points', icon: '💯', unlocked: false },
    { id: 'wave_10', name: 'Vague 10', desc: 'Atteins la vague 10', icon: '🌊', unlocked: false },
    { id: 'perfect_health', name: 'Santé Parfaite', desc: 'Termine avec 100% HP', icon: '💚', unlocked: false }
];

// ===== SEEDED RANDOM =====
class SeededRandom {
    constructor(seed) { this.seed = seed; }
    next() {
        this.seed = (this.seed * 9301 + 49297) % 233280;
        return this.seed / 233280;
    }
}

// ===== INITIALISATION =====
window.onload = () => {
    canvas = document.getElementById('gameCanvas');
    ctx = canvas.getContext('2d');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    loadHighScore();
    loadTrophies();
    displayTrophies();
    setupInput();
    setupMenuButtons();
    requestAnimationFrame(gameLoop);
    registerServiceWorker();
};

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

function loadHighScore() {
    const saved = localStorage.getItem('survivorHighScore');
    if (saved) document.getElementById('highScoreValue').textContent = saved;
}

function saveHighScore(score) {
    const current = parseInt(localStorage.getItem('survivorHighScore') || '0');
    if (score > current) {
        localStorage.setItem('survivorHighScore', score.toString());
        return true;
    }
    return false;
}

function loadTrophies() {
    const saved = localStorage.getItem('survivorTrophies');
    if (saved) {
        const unlocked = JSON.parse(saved);
        TROPHIES.forEach(trophy => {
            if (unlocked.includes(trophy.id)) trophy.unlocked = true;
        });
    }
    const cumulativeKills = parseInt(localStorage.getItem('cumulativeKills') || '0');
    if (cumulativeKills >= 1000) unlockTrophy('butcher_1000');
}

function saveTrophies() {
    const unlocked = TROPHIES.filter(t => t.unlocked).map(t => t.id);
    localStorage.setItem('survivorTrophies', JSON.stringify(unlocked));
}

function displayTrophies() {
    const unlockedCount = TROPHIES.filter(t => t.unlocked).length;
    document.getElementById('trophyCount').textContent = `${unlockedCount}/${TROPHIES.length}`;
    const preview = document.getElementById('trophiesPreview');
    preview.innerHTML = '';
    TROPHIES.forEach(trophy => {
        const mini = document.createElement('span');
        mini.className = `trophy-mini ${trophy.unlocked ? 'unlocked' : ''}`;
        mini.textContent = trophy.icon;
        mini.title = trophy.name;
        preview.appendChild(mini);
    });
}

function unlockTrophy(id) {
    const trophy = TROPHIES.find(t => t.id === id);
    if (trophy && !trophy.unlocked) {
        trophy.unlocked = true;
        saveTrophies();
        return trophy;
    }
    return null;
}

// ===== PWA SERVICE WORKER =====
function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
}

// ===== MENU SETUP =====
function setupMenuButtons() {
    document.getElementById('btnCreateGame').onclick = () => createGame();
    document.getElementById('btnJoinGame').onclick = () => showJoinSection();
    document.getElementById('btnSoloGame').onclick = () => startSoloGame();
    document.getElementById('btnCancelJoin').onclick = () => hideJoinSection();
    document.getElementById('btnCancelHost').onclick = () => cancelHost();
    document.getElementById('btnStartGame').onclick = () => {
        if (connections.length > 0 || isHost) startMultiplayerGame();
    };
    document.getElementById('btnCopyPin').onclick = () => copyPinToClipboard();
    document.getElementById('btnRestart').onclick = () => restartGame();
    document.getElementById('btnShareScore').onclick = () => shareScore();
    document.getElementById('btnConfirmJoin').onclick = () => {
        const pin = document.getElementById('pinInput').value;
        if (pin && pin.length === 6) joinGame(pin);
    };
    
    document.querySelectorAll('.emoji-btn').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('.emoji-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            player.emoji = btn.dataset.emoji;
        };
    });
    
    document.getElementById('playerName').oninput = (e) => {
        player.name = e.target.value || 'Joueur';
    };
}

// ===== NETWORKING =====
function generatePIN() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function createGame() {
    roomPin = generatePIN();
    myPeerId = roomPin;
    peer = new Peer(myPeerId);
    
    peer.on('open', (id) => {
        console.log('Host ID:', id);
        showHostSection(roomPin);
        isHost = true;
        gameMode = 'host';
    });
    
    peer.on('connection', (conn) => handleIncomingConnection(conn));
    peer.on('error', (err) => {
        console.error('Peer error:', err);
        alert('Erreur de connexion: ' + err.type);
    });
}

function handleIncomingConnection(conn) {
    if (connections.length >= CONFIG.MAX_PLAYERS - 1) {
        conn.close();
        return;
    }
    connections.push(conn);
    
    conn.on('open', () => {
        console.log('Player connected:', conn.peer);
        updateConnectedPlayers();
        conn.send({ t: 'init', p: { ...player } });
    });
    
    conn.on('data', (data) => handleHostMessage(data, conn));
    conn.on('close', () => {
        connections = connections.filter(c => c !== conn);
        delete remotePlayers[conn.peer];
        updateConnectedPlayers();
    });
}

function handleHostMessage(data, conn) {
    if (data.t === 'pi') { // player info
        remotePlayers[conn.peer] = {
            ...data.p,
            id: conn.peer,
            lu: Date.now(),
            ix: data.p.x,
            iy: data.p.y
        };
    } else if (data.t === 'sh') { // shoot
        if (gameState === 'playing') {
            const remotePlayer = remotePlayers[conn.peer];
            if (remotePlayer) {
                createProjectile(remotePlayer.x, remotePlayer.y, data.a, remotePlayer);
            }
        }
    } else if (data.t === 'png') { // ping
        conn.send({ t: 'pong', ts: data.ts });
    }
}

function joinGame(pin) {
    if (pin.length !== 6) return;
    peer = new Peer();
    
    peer.on('open', (id) => {
        myPeerId = id;
        hostConnection = peer.connect(pin);
        
        hostConnection.on('open', () => {
            console.log('Connected to host');
            gameMode = 'client';
            hideJoinSection();
            sendPlayerInfo();
            startPingMonitor();
        });
        
        hostConnection.on('data', (data) => handleClientMessage(data));
        hostConnection.on('close', () => {
            console.log('Disconnected from host');
            if (gameState === 'playing') endGame();
        });
    });
    
    peer.on('error', (err) => {
        console.error('Peer error:', err);
        alert('Impossible de rejoindre la partie.');
    });
}

function handleClientMessage(data) {
    if (data.t === 'init') {
        // Init
    } else if (data.t === 'gs') { // game start
        startMultiplayerGame();
    } else if (data.t === 'st') { // state
        updateEnemiesFromHost(data.e);
        updateGemsFromHost(data.g);
        updateRemotePlayersFromHost(data.p);
    } else if (data.t === 'pong') {
        networkPing = Date.now() - data.ts;
    }
}

function updateEnemiesFromHost(hostEnemies) {
    if (!hostEnemies) return;
    hostEnemies.forEach(he => {
        let localEnemy = enemies.find(e => e.id === he.i);
        if (!localEnemy) {
            const typeData = ENEMY_TYPES[he.ty] || ENEMY_TYPES.zombie;
            enemies.push({
                id: he.i,
                x: he.x,
                y: he.y,
                health: he.h,
                maxHealth: he.mh,
                type: he.ty,
                emoji: typeData.emoji,
                speed: he.s,
                damage: he.d,
                size: he.sz,
                color: typeData.color,
                ix: he.x,
                iy: he.y,
                lu: Date.now()
            });
        } else {
            // INTERPOLATION FLUIDE
            localEnemy.tx = he.x;
            localEnemy.ty = he.y;
            localEnemy.health = he.h;
            localEnemy.lu = Date.now();
        }
    });
    enemies = enemies.filter(e => hostEnemies.find(he => he.i === e.id));
}

function updateGemsFromHost(hostGems) {
    if (!hostGems) return;
    hostGems.forEach(hg => {
        let localGem = gems.find(g => g.id === hg.i);
        if (!localGem) {
            gems.push({
                id: hg.i,
                x: hg.x,
                y: hg.y,
                xp: hg.xp,
                size: 8,
                ix: hg.x,
                iy: hg.y
            });
        } else {
            localGem.tx = hg.x;
            localGem.ty = hg.y;
        }
    });
    gems = gems.filter(g => hostGems.find(hg => hg.i === g.id));
}

function updateRemotePlayersFromHost(players) {
    if (!players) return;
    Object.keys(players).forEach(id => {
        if (id !== myPeerId) {
            if (!remotePlayers[id]) {
                remotePlayers[id] = { 
                    ...players[id], 
                    ix: players[id].x, 
                    iy: players[id].y 
                };
            } else {
                remotePlayers[id].tx = players[id].x;
                remotePlayers[id].ty = players[id].y;
                remotePlayers[id].health = players[id].h;
                remotePlayers[id].score = players[id].sc;
            }
        }
    });
}

function sendPlayerInfo() {
    if (hostConnection && hostConnection.open) {
        hostConnection.send({
            t: 'pi',
            p: {
                x: player.x,
                y: player.y,
                n: player.name,
                e: player.emoji,
                h: player.health,
                sc: player.score
            }
        });
    }
}

function broadcastGameState() {
    if (!isHost) return;
    const state = {
        t: 'st',
        e: enemies.map(e => ({
            i: e.id,
            x: Math.round(e.x),
            y: Math.round(e.y),
            h: Math.round(e.health),
            mh: e.maxHealth,
            ty: e.type,
            s: e.speed,
            d: e.damage,
            sz: e.size
        })),
        g: gems.map(g => ({
            i: g.id,
            x: Math.round(g.x),
            y: Math.round(g.y),
            xp: g.xp
        })),
        p: {
            [myPeerId]: {
                x: Math.round(player.x),
                y: Math.round(player.y),
                n: player.name,
                e: player.emoji,
                h: Math.round(player.health),
                sc: player.score
            },
            ...Object.keys(remotePlayers).reduce((acc, id) => {
                acc[id] = remotePlayers[id];
                return acc;
            }, {})
        }
    };
    connections.forEach(conn => {
        if (conn.open) conn.send(state);
    });
}

function startPingMonitor() {
    setInterval(() => {
        if (hostConnection && hostConnection.open) {
            hostConnection.send({ t: 'png', ts: Date.now() });
        }
    }, 2000);
}

function showHostSection(pin) {
    document.getElementById('hostPinCode').textContent = pin;
    document.querySelector('.customization-compact').style.display = 'none';
    document.querySelector('.menu-buttons').style.display = 'none';
    document.getElementById('hostSection').classList.remove('hidden');
}

function showJoinSection() {
    document.querySelector('.customization-compact').style.display = 'none';
    document.querySelector('.menu-buttons').style.display = 'none';
    document.getElementById('joinSection').classList.remove('hidden');
    setTimeout(() => document.getElementById('pinInput').focus(), 100);
}

function hideJoinSection() {
    document.querySelector('.customization-compact').style.display = 'flex';
    document.querySelector('.menu-buttons').style.display = 'flex';
    document.getElementById('joinSection').classList.add('hidden');
}

function cancelHost() {
    if (peer) peer.destroy();
    connections = [];
    remotePlayers = {};
    document.querySelector('.customization-compact').style.display = 'flex';
    document.querySelector('.menu-buttons').style.display = 'flex';
    document.getElementById('hostSection').classList.add('hidden');
}

function updateConnectedPlayers() {
    const container = document.getElementById('connectedPlayers');
    container.innerHTML = '';
    Object.values(remotePlayers).forEach(p => {
        const tag = document.createElement('div');
        tag.className = 'player-tag';
        tag.textContent = `${p.e} ${p.n}`;
        container.appendChild(tag);
    });
    const count = connections.length + 1;
    document.getElementById('btnStartGame').textContent = `🚀 Démarrer (${count}/${CONFIG.MAX_PLAYERS})`;
}

function copyPinToClipboard() {
    navigator.clipboard.writeText(roomPin).then(() => {
        const btn = document.getElementById('btnCopyPin');
        btn.textContent = '✓ Copié !';
        setTimeout(() => { btn.textContent = '📋 Copier'; }, 2000);
    });
}

// ===== GAME START =====
function startSoloGame() {
    gameMode = 'solo';
    initGame();
    startGame();
}

function startMultiplayerGame() {
    if (isHost) {
        connections.forEach(conn => {
            if (conn.open) conn.send({ t: 'gs' });
        });
    }
    initGame();
    startGame();
}

function initGame() {
    // VIDER TOUS LES TABLEAUX
    enemies.length = 0;
    projectiles.length = 0;
    gems.length = 0;
    particles.length = 0;
    damageNumbers.length = 0;
    obstacles.length = 0;
    
    // Reset player
    player.x = CONFIG.WORLD_SIZE / 2;
    player.y = CONFIG.WORLD_SIZE / 2;
    player.vx = 0;
    player.vy = 0;
    player.health = 100;
    player.maxHealth = 100;
    player.damage = 10;
    player.fireRate = 500;
    player.lastShot = 0;
    player.xp = 0;
    player.level = 1;
    player.xpToLevel = 100;
    player.score = 0;
    player.kills = 0;
    player.bonuses = {
        speedBonus: 0,
        damageBonus: 0,
        fireRateBonus: 0,
        healthBonus: 0
    };
    
    gameStats = {
        startTime: Date.now(),
        survivalTime: 0,
        totalDamage: 0,
        killsByType: {},
        difficultyLevel: 1,
        lastDifficultyIncrease: Date.now()
    };
    
    specialAbility = { ready: true, cooldown: 0, lastUse: 0 };
    currentWave = 1;
    maxEnemies = 20;
    spawnRate = 2000;
    camera = { x: 0, y: 0, shake: 0, shakeX: 0, shakeY: 0 };
    
    generateObstacles();
}

function startGame() {
    document.getElementById('customizationScreen').classList.remove('active');
    document.getElementById('gameUI').classList.remove('hidden');
    if (isMobile) document.getElementById('joystickContainer').classList.remove('hidden');
    if (gameMode !== 'solo') document.getElementById('onlineIndicator').style.display = 'flex';
    gameState = 'playing';
    updateUI();
}

// ===== GÉNÉRATION STRUCTURES AVEC SEED =====
function generateObstacles() {
    const rng = new SeededRandom(CONFIG.STRUCTURE_SEED);
    for (let i = 0; i < 80; i++) {
        const typeRoll = rng.next();
        let emoji, width, height, solid;
        
        if (typeRoll < 0.25) {
            emoji = '🧱'; // Mur
            width = 60 + rng.next() * 40;
            height = 60 + rng.next() * 40;
            solid = true;
        } else if (typeRoll < 0.5) {
            emoji = '📦'; // Caisse
            width = 50 + rng.next() * 30;
            height = 50 + rng.next() * 30;
            solid = true;
        } else if (typeRoll < 0.75) {
            emoji = '🏠'; // Maison
            width = 100 + rng.next() * 50;
            height = 100 + rng.next() * 50;
            solid = true;
        } else {
            emoji = '🌳'; // Arbre
            width = 40 + rng.next() * 30;
            height = 40 + rng.next() * 30;
            solid = false;
        }
        
        obstacles.push({
            x: rng.next() * CONFIG.WORLD_SIZE,
            y: rng.next() * CONFIG.WORLD_SIZE,
            width,
            height,
            emoji,
            solid
        });
    }
}

// ===== COLLISION AABB (RÉACTIVÉE) =====
function checkObstacleCollision(entity) {
    for (let obs of obstacles) {
        if (!obs.solid) continue;
        
        const entityLeft = entity.x - entity.size;
        const entityRight = entity.x + entity.size;
        const entityTop = entity.y - entity.size;
        const entityBottom = entity.y + entity.size;
        
        const obsLeft = obs.x - obs.width / 2;
        const obsRight = obs.x + obs.width / 2;
        const obsTop = obs.y - obs.height / 2;
        const obsBottom = obs.y + obs.height / 2;
        
        if (entityRight > obsLeft && entityLeft < obsRight &&
            entityBottom > obsTop && entityTop < obsBottom) {
            
            const overlapX = Math.min(entityRight - obsLeft, obsRight - entityLeft);
            const overlapY = Math.min(entityBottom - obsTop, obsBottom - entityTop);
            
            if (overlapX < overlapY) {
                entity.x += entity.x < obs.x ? -overlapX : overlapX;
                entity.vx = 0;
            } else {
                entity.y += entity.y < obs.y ? -overlapY : overlapY;
                entity.vy = 0;
            }
            return true;
        }
    }
    return false;
}

// ===== INPUT =====
function setupInput() {
    window.addEventListener('keydown', (e) => {
        keys[e.key.toLowerCase()] = true;
        if (e.key === ' ' && gameState === 'playing') {
            e.preventDefault();
            useSpecialAbility();
        }
    });
    
    window.addEventListener('keyup', (e) => {
        keys[e.key.toLowerCase()] = false;
    });
    
    const joystickOuter = document.getElementById('joystickOuter');
    const joystickInner = document.getElementById('joystickInner');
    const joystickContainer = document.getElementById('joystickContainer');
    
    const handleJoystickStart = (e) => {
        e.preventDefault();
        const touch = e.touches ? e.touches[0] : e;
        const rect = joystickOuter.getBoundingClientRect();
        joystick.startX = rect.left + rect.width / 2;
        joystick.startY = rect.top + rect.height / 2;
        joystick.active = true;
        joystickContainer.classList.add('active');
    };
    
    const handleJoystickMove = (e) => {
        if (!joystick.active) return;
        e.preventDefault();
        const touch = e.touches ? e.touches[0] : e;
        const dx = touch.clientX - joystick.startX;
        const dy = touch.clientY - joystick.startY;
        const distance = Math.min(40, Math.sqrt(dx * dx + dy * dy));
        const angle = Math.atan2(dy, dx);
        joystick.x = Math.cos(angle) * distance;
        joystick.y = Math.sin(angle) * distance;
        joystickInner.style.transform = `translate(-50%, -50%) translate(${joystick.x}px, ${joystick.y}px)`;
    };
    
    const handleJoystickEnd = (e) => {
        e.preventDefault();
        joystick.active = false;
        joystick.x = 0;
        joystick.y = 0;
        joystickInner.style.transform = 'translate(-50%, -50%)';
        joystickContainer.classList.remove('active');
    };
    
    joystickOuter.addEventListener('touchstart', handleJoystickStart, { passive: false });
    document.addEventListener('touchmove', handleJoystickMove, { passive: false });
    document.addEventListener('touchend', handleJoystickEnd, { passive: false });
    document.addEventListener('touchcancel', handleJoystickEnd, { passive: false });
    document.getElementById('abilityBtn').onclick = () => useSpecialAbility();
}

// ===== GAME LOOP =====
let lastTime = 0;
let lastSyncTime = 0;
let lastSpawnTime = 0;

function gameLoop(currentTime) {
    const deltaTime = Math.min(currentTime - lastTime, 100);
    lastTime = currentTime;
    
    if (gameState === 'playing') {
        update(deltaTime);
        render();
        
        if (gameMode === 'client' && currentTime - lastSyncTime > 100) {
            sendPlayerInfo();
            lastSyncTime = currentTime;
        }
        
        if (isHost && currentTime - lastSyncTime > CONFIG.ENEMY_SYNC_RATE) {
            broadcastGameState();
            lastSyncTime = currentTime;
        }
    }
    
    requestAnimationFrame(gameLoop);
}

function update(deltaTime) {
    gameStats.survivalTime = Date.now() - gameStats.startTime;
    updatePlayer(deltaTime);
    updateCamera();
    updateAbilityCooldown();
    
    // DIFFICULTÉ CROISSANTE (10% toutes les 30s)
    if (gameMode !== 'client' && Date.now() - gameStats.lastDifficultyIncrease > CONFIG.DIFFICULTY_INCREASE_INTERVAL) {
        gameStats.difficultyLevel += CONFIG.DIFFICULTY_INCREASE_RATE;
        maxEnemies = Math.floor(20 * gameStats.difficultyLevel);
        spawnRate = Math.max(500, 2000 / gameStats.difficultyLevel);
        gameStats.lastDifficultyIncrease = Date.now();
    }
    
    if (gameMode !== 'client') spawnEnemies();
    
    updateEnemies(deltaTime);
    updateProjectiles(deltaTime);
    updateGems(deltaTime);
    updateParticles(deltaTime);
    updateDamageNumbers(deltaTime);
    interpolateRemotePlayers(deltaTime);
    if (gameMode !== 'client') checkCollisions();
    updateUI();
    checkTrophies();
}

function updatePlayer(deltaTime) {
    let moveX = 0, moveY = 0;
    
    if (isMobile && joystick.active) {
        moveX = joystick.x / 40;
        moveY = joystick.y / 40;
    } else {
        if (keys['z'] || keys['w'] || keys['arrowup']) moveY -= 1;
        if (keys['s'] || keys['arrowdown']) moveY += 1;
        if (keys['q'] || keys['a'] || keys['arrowleft']) moveX -= 1;
        if (keys['d'] || keys['arrowright']) moveX += 1;
    }
    
    const mag = Math.sqrt(moveX * moveX + moveY * moveY);
    if (mag > 0) {
        moveX /= mag;
        moveY /= mag;
    }
    
    // BONUS CUMULABLES
    const effectiveSpeed = player.speed + player.bonuses.speedBonus;
    player.vx = moveX * effectiveSpeed;
    player.vy = moveY * effectiveSpeed;
    
    player.x += player.vx;
    player.y += player.vy;
    
    checkObstacleCollision(player);
    
    player.x = Math.max(50, Math.min(CONFIG.WORLD_SIZE - 50, player.x));
    player.y = Math.max(50, Math.min(CONFIG.WORLD_SIZE - 50, player.y));
    
    if (gameMode !== 'client') {
        autoShoot();
    } else {
        autoShootClient();
    }
    
    if (player.health < player.maxHealth) player.health += 0.01;
}

function autoShoot() {
    const effectiveFireRate = Math.max(100, player.fireRate - player.bonuses.fireRateBonus);
    if (Date.now() - player.lastShot < effectiveFireRate) return;
    
    let nearest = null;
    let nearestDist = Infinity;
    
    enemies.forEach(enemy => {
        const dist = Math.hypot(enemy.x - player.x, enemy.y - player.y);
        if (dist < nearestDist && dist < 400) {
            nearest = enemy;
            nearestDist = dist;
        }
    });
    
    if (nearest) {
        const angle = Math.atan2(nearest.y - player.y, nearest.x - player.x);
        createProjectile(player.x, player.y, angle, player);
        player.lastShot = Date.now();
    }
}

function autoShootClient() {
    const effectiveFireRate = Math.max(100, player.fireRate - player.bonuses.fireRateBonus);
    if (Date.now() - player.lastShot < effectiveFireRate) return;
    
    let nearest = null;
    let nearestDist = Infinity;
    
    enemies.forEach(enemy => {
        const dist = Math.hypot(enemy.x - player.x, enemy.y - player.y);
        if (dist < nearestDist && dist < 400) {
            nearest = enemy;
            nearestDist = dist;
        }
    });
    
    if (nearest) {
        const angle = Math.atan2(nearest.y - player.y, nearest.x - player.x);
        createProjectile(player.x, player.y, angle, player);
        if (hostConnection && hostConnection.open) {
            hostConnection.send({ t: 'sh', a: angle });
        }
        player.lastShot = Date.now();
    }
}

function createProjectile(x, y, angle, owner) {
    const effectiveDamage = player.damage + player.bonuses.damageBonus;
    projectiles.push({
        x, y,
        vx: Math.cos(angle) * 8,
        vy: Math.sin(angle) * 8,
        damage: effectiveDamage,
        size: 4,
        owner: owner.id || 'player'
    });
}

function spawnEnemies() {
    if (Date.now() - lastSpawnTime < spawnRate) return;
    if (enemies.length >= maxEnemies) return;
    
    const types = ['zombie', 'zombie', 'ghost', 'alien'];
    const typeIndex = Math.floor(Math.random() * types.length);
    const type = types[typeIndex];
    const typeData = ENEMY_TYPES[type];
    
    const angle = Math.random() * Math.PI * 2;
    const distance = 600;
    
    enemies.push({
        id: 'e_' + Date.now() + '_' + Math.random(),
        x: player.x + Math.cos(angle) * distance,
        y: player.y + Math.sin(angle) * distance,
        vx: 0, vy: 0,
        health: typeData.health * gameStats.difficultyLevel,
        maxHealth: typeData.health * gameStats.difficultyLevel,
        type,
        emoji: typeData.emoji,
        speed: typeData.speed,
        damage: typeData.damage * gameStats.difficultyLevel,
        size: typeData.size,
        color: typeData.color,
        score: typeData.score,
        isBoss: typeData.isBoss || false,
        ix: 0,
        iy: 0,
        tx: 0,
        ty: 0
    });
    
    lastSpawnTime = Date.now();
}

function updateEnemies(deltaTime) {
    enemies.forEach(enemy => {
        if (gameMode !== 'client') {
            // L'hôte calcule les positions
            const dx = player.x - enemy.x;
            const dy = player.y - enemy.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            
            if (dist > 0) {
                enemy.vx = (dx / dist) * enemy.speed;
                enemy.vy = (dy / dist) * enemy.speed;
                enemy.x += enemy.vx;
                enemy.y += enemy.vy;
                checkObstacleCollision(enemy);
            }
        } else {
            // Client: INTERPOLATION FLUIDE vers position cible
            if (enemy.tx !== undefined && enemy.ty !== undefined) {
                enemy.x += (enemy.tx - enemy.x) * CONFIG.INTERPOLATION_SPEED;
                enemy.y += (enemy.ty - enemy.y) * CONFIG.INTERPOLATION_SPEED;
            }
        }
    });
}

function updateProjectiles(deltaTime) {
    projectiles = projectiles.filter(proj => {
        proj.x += proj.vx;
        proj.y += proj.vy;
        
        if (proj.x < 0 || proj.x > CONFIG.WORLD_SIZE || 
            proj.y < 0 || proj.y > CONFIG.WORLD_SIZE) {
            return false;
        }
        
        return true;
    });
}

function updateGems(deltaTime) {
    gems.forEach(gem => {
        if (gameMode === 'client') {
            // INTERPOLATION FLUIDE pour les gems
            if (gem.tx !== undefined && gem.ty !== undefined) {
                gem.x += (gem.tx - gem.x) * CONFIG.INTERPOLATION_SPEED;
                gem.y += (gem.ty - gem.y) * CONFIG.INTERPOLATION_SPEED;
            }
        }
        
        const dist = Math.hypot(gem.x - player.x, gem.y - player.y);
        if (dist < 100) {
            const angle = Math.atan2(player.y - gem.y, player.x - gem.x);
            gem.x += Math.cos(angle) * 3;
            gem.y += Math.sin(angle) * 3;
        }
        
        if (dist < 30) {
            player.xp += gem.xp;
            player.score += gem.xp * 10;
            gems = gems.filter(g => g !== gem);
            checkLevelUp();
        }
    });
}

function updateParticles(deltaTime) {
    particles = particles.filter(p => {
        p.x += p.vx;
        p.y += p.vy;
        p.life -= 0.02;
        return p.life > 0;
    });
}

function updateDamageNumbers(deltaTime) {
    damageNumbers = damageNumbers.filter(dn => {
        dn.y -= 1;
        dn.life -= 0.02;
        return dn.life > 0;
    });
}

function interpolateRemotePlayers(deltaTime) {
    Object.values(remotePlayers).forEach(p => {
        if (p.tx !== undefined && p.ty !== undefined) {
            p.x += (p.tx - p.x) * CONFIG.INTERPOLATION_SPEED;
            p.y += (p.ty - p.y) * CONFIG.INTERPOLATION_SPEED;
        }
    });
}

function checkCollisions() {
    projectiles.forEach(proj => {
        enemies.forEach(enemy => {
            const dist = Math.hypot(proj.x - enemy.x, proj.y - enemy.y);
            if (dist < enemy.size + proj.size) {
                enemy.health -= proj.damage;
                createDamageNumber(enemy.x, enemy.y, proj.damage);
                gameStats.totalDamage += proj.damage;
                projectiles = projectiles.filter(p => p !== proj);
                
                if (enemy.health <= 0) {
                    player.kills++;
                    player.score += enemy.score;
                    gameStats.killsByType[enemy.type] = (gameStats.killsByType[enemy.type] || 0) + 1;
                    createGem(enemy.x, enemy.y, 20);
                    createParticles(enemy.x, enemy.y, enemy.color);
                    enemies = enemies.filter(e => e !== enemy);
                    
                    if (player.kills === 1) unlockTrophy('first_blood');
                    if (player.kills >= 100) unlockTrophy('butcher_100');
                }
            }
        });
    });
    
    enemies.forEach(enemy => {
        const dist = Math.hypot(enemy.x - player.x, enemy.y - player.y);
        if (dist < enemy.size + player.size) {
            player.health -= 0.2;
            if (player.health <= 0) endGame();
        }
    });
}

function createGem(x, y, xp) {
    gems.push({
        id: 'g_' + Date.now() + '_' + Math.random(),
        x, y,
        xp,
        size: 8,
        ix: x,
        iy: y,
        tx: x,
        ty: y
    });
}

function createDamageNumber(x, y, damage) {
    damageNumbers.push({
        x, y,
        damage: Math.floor(damage),
        life: 1
    });
}

function createParticles(x, y, color) {
    for (let i = 0; i < 10; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 2 + Math.random() * 3;
        particles.push({
            x, y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            color,
            size: 3 + Math.random() * 5,
            life: 1
        });
    }
}

function checkLevelUp() {
    if (player.xp >= player.xpToLevel) {
        player.xp -= player.xpToLevel;
        player.level++;
        player.xpToLevel = Math.floor(player.xpToLevel * 1.5);
        showUpgradeMenu();
        if (player.level >= 10) unlockTrophy('lvl_10');
    }
}

function showUpgradeMenu() {
    gameState = 'upgrade';
    const menu = document.getElementById('upgradeMenu');
    const options = document.getElementById('upgradeOptions');
    options.innerHTML = '';
    
    const upgrades = [
        { icon: '🏃', name: 'Vitesse +', desc: '+1 Vitesse (permanent)', bonus: 'speedBonus', value: 1 },
        { icon: '⚔️', name: 'Dégâts +', desc: '+5 Dégâts (permanent)', bonus: 'damageBonus', value: 5 },
        { icon: '⚡', name: 'Cadence +', desc: '-50ms Cadence (permanent)', bonus: 'fireRateBonus', value: 50 },
        { icon: '❤️', name: 'HP Max +', desc: '+20 HP Max (permanent)', bonus: 'healthBonus', value: 20 }
    ];
    
    upgrades.forEach(upgrade => {
        const card = document.createElement('div');
        card.className = 'upgrade-card';
        card.innerHTML = `
            <div class="upgrade-icon">${upgrade.icon}</div>
            <div class="upgrade-name">${upgrade.name}</div>
            <div class="upgrade-desc">${upgrade.desc}</div>
        `;
        card.onclick = () => applyUpgrade(upgrade);
        options.appendChild(card);
    });
    
    menu.classList.remove('hidden');
}

function applyUpgrade(upgrade) {
    player.bonuses[upgrade.bonus] += upgrade.value;
    if (upgrade.bonus === 'healthBonus') {
        player.maxHealth += upgrade.value;
        player.health += upgrade.value;
    }
    document.getElementById('upgradeMenu').classList.add('hidden');
    gameState = 'playing';
}

function useSpecialAbility() {
    if (!specialAbility.ready) return;
    specialAbility.ready = false;
    specialAbility.lastUse = Date.now();
    
    enemies.forEach(enemy => {
        const dist = Math.hypot(enemy.x - player.x, enemy.y - player.y);
        if (dist < 200) {
            enemy.health -= 50;
            createDamageNumber(enemy.x, enemy.y, 50);
        }
    });
    
    createParticles(player.x, player.y, '#667eea');
    camera.shake = 10;
}

function updateAbilityCooldown() {
    if (!specialAbility.ready) {
        const elapsed = Date.now() - specialAbility.lastUse;
        const progress = elapsed / CONFIG.ABILITY_COOLDOWN;
        if (progress >= 1) {
            specialAbility.ready = true;
        }
        const circle = document.getElementById('cooldownCircle');
        const offset = 282.6 * (1 - progress);
        circle.style.strokeDashoffset = offset;
    } else {
        document.getElementById('cooldownCircle').style.strokeDashoffset = 0;
    }
}

function updateCamera() {
    const targetX = player.x - canvas.width / 2;
    const targetY = player.y - canvas.height / 2;
    camera.x += (targetX - camera.x) * CONFIG.CAMERA_SMOOTH;
    camera.y += (targetY - camera.y) * CONFIG.CAMERA_SMOOTH;
    
    if (camera.shake > 0) {
        camera.shakeX = (Math.random() - 0.5) * camera.shake;
        camera.shakeY = (Math.random() - 0.5) * camera.shake;
        camera.shake *= 0.9;
    } else {
        camera.shakeX = 0;
        camera.shakeY = 0;
    }
}

function updateUI() {
    document.getElementById('levelDisplay').textContent = `NIV. ${player.level}`;
    document.getElementById('xpDisplay').textContent = `${Math.floor(player.xp)} / ${player.xpToLevel} XP`;
    document.getElementById('xpFill').style.width = `${(player.xp / player.xpToLevel) * 100}%`;
    document.getElementById('playerEmoji').textContent = player.emoji;
    document.getElementById('playerNameDisplay').textContent = player.name;
    document.getElementById('healthDisplay').textContent = Math.floor(player.health);
    document.getElementById('damageDisplay').textContent = player.damage + player.bonuses.damageBonus;
    document.getElementById('killCount').textContent = player.kills;
    document.getElementById('scoreDisplay').textContent = player.score;
    document.getElementById('waveDisplay').textContent = `VAGUE ${currentWave}`;
    document.getElementById('enemyCount').textContent = `${enemies.length} ENNEMIS`;
    if (gameMode !== 'solo') {
        document.getElementById('playerCountDisplay').textContent = 1 + connections.length;
        document.getElementById('pingText').textContent = `${networkPing}ms`;
    }
    updateLeaderboard();
}

function updateLeaderboard() {
    const content = document.getElementById('leaderboardContent');
    content.innerHTML = '';
    const players = [
        { name: player.name, emoji: player.emoji, score: player.score, id: 'me' },
        ...Object.values(remotePlayers).map(p => ({ name: p.n, emoji: p.e, score: p.sc || 0, id: p.id }))
    ];
    players.sort((a, b) => b.score - a.score);
    players.slice(0, 10).forEach((p, i) => {
        const item = document.createElement('div');
        item.className = 'leaderboard-item';
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        item.innerHTML = `
            <span style="min-width: 25px;">${medal}</span>
            <span>${p.emoji}</span>
            <span style="flex: 1; font-size: 0.8rem;">${p.name}</span>
            <span style="color: #ffd700;">${p.score}</span>
        `;
        if (p.id === 'me') {
            item.style.background = 'rgba(102, 126, 234, 0.3)';
        }
        content.appendChild(item);
    });
}

function checkTrophies() {
    if (gameStats.survivalTime >= 300000) unlockTrophy('survivor_5min');
    if (player.score >= 10000) unlockTrophy('score_10k');
    if (currentWave >= 10) unlockTrophy('wave_10');
}

// ===== RENDERING =====
function render() {
    ctx.save();
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.translate(-camera.x + camera.shakeX, -camera.y + camera.shakeY);
    
    const viewLeft = camera.x - 100;
    const viewRight = camera.x + canvas.width + 100;
    const viewTop = camera.y - 100;
    const viewBottom = camera.y + canvas.height + 100;
    
    renderGrid(viewLeft, viewRight, viewTop, viewBottom);
    
    obstacles.forEach(obs => {
        if (obs.x >= viewLeft && obs.x <= viewRight && 
            obs.y >= viewTop && obs.y <= viewBottom) {
            renderObstacle(obs);
        }
    });
    
    gems.forEach(gem => {
        if (gem.x >= viewLeft && gem.x <= viewRight && 
            gem.y >= viewTop && gem.y <= viewBottom) {
            renderGem(gem);
        }
    });
    
    enemies.forEach(enemy => {
        if (enemy.x >= viewLeft && enemy.x <= viewRight && 
            enemy.y >= viewTop && enemy.y <= viewBottom) {
            renderEnemy(enemy);
        }
    });
    
    Object.values(remotePlayers).forEach(p => {
        if (p.x >= viewLeft && p.x <= viewRight && 
            p.y >= viewTop && p.y <= viewBottom) {
            renderPlayer(p);
        }
    });
    
    renderPlayer(player, true);
    
    projectiles.forEach(proj => {
        if (proj.x >= viewLeft && proj.x <= viewRight && 
            proj.y >= viewTop && proj.y <= viewBottom) {
            renderProjectile(proj);
        }
    });
    
    particles.forEach(p => {
        if (p.x >= viewLeft && p.x <= viewRight && 
            p.y >= viewTop && p.y <= viewBottom) {
            renderParticle(p);
        }
    });
    
    damageNumbers.forEach(dn => {
        if (dn.x >= viewLeft && dn.x <= viewRight && 
            dn.y >= viewTop && dn.y <= viewBottom) {
            renderDamageNumber(dn);
        }
    });
    
    ctx.restore();
    renderMinimap();
}

function renderGrid(left, right, top, bottom) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    const gridSize = 100;
    const startX = Math.floor(left / gridSize) * gridSize;
    const startY = Math.floor(top / gridSize) * gridSize;
    for (let x = startX; x < right; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.stroke();
    }
    for (let y = startY; y < bottom; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
    }
}

function renderObstacle(obs) {
    ctx.font = `${obs.width}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(obs.emoji, obs.x, obs.y);
}

function renderGem(gem) {
    const gradient = ctx.createRadialGradient(gem.x, gem.y, 0, gem.x, gem.y, gem.size * 2);
    gradient.addColorStop(0, 'rgba(255, 215, 0, 0.5)');
    gradient.addColorStop(1, 'rgba(255, 215, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(gem.x, gem.y, gem.size * 2, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.fillStyle = '#ffd700';
    ctx.beginPath();
    ctx.arc(gem.x, gem.y, gem.size, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.strokeStyle = '#ffed4e';
    ctx.lineWidth = 2;
    ctx.stroke();
}

function renderEnemy(enemy) {
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 5;
    
    ctx.font = `${enemy.size * 2}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(enemy.emoji, enemy.x, enemy.y);
    
    ctx.restore();
    
    const barWidth = enemy.size * 2;
    const barHeight = 4;
    const healthPercent = enemy.health / enemy.maxHealth;
    
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(enemy.x - barWidth / 2, enemy.y - enemy.size - 10, barWidth, barHeight);
    
    ctx.fillStyle = healthPercent > 0.5 ? '#43e97b' : healthPercent > 0.25 ? '#ffa500' : '#ff4444';
    ctx.fillRect(enemy.x - barWidth / 2, enemy.y - enemy.size - 10, barWidth * healthPercent, barHeight);
}

function renderPlayer(p, isLocal = false) {
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 5;
    
    ctx.fillStyle = isLocal ? '#667eea' : '#f093fb';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 25, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.stroke();
    
    ctx.restore();
    
    ctx.font = '30px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.emoji || p.e, p.x, p.y);
    
    ctx.font = 'bold 14px Arial';
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.strokeText(p.name || p.n, p.x, p.y - 40);
    ctx.fillText(p.name || p.n, p.x, p.y - 40);
    
    if (!isLocal || p.health < p.maxHealth) {
        const barWidth = 50;
        const barHeight = 6;
        const healthPercent = (p.health || p.h) / (p.maxHealth || 100);
        
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(p.x - barWidth / 2, p.y + 35, barWidth, barHeight);
        
        ctx.fillStyle = healthPercent > 0.5 ? '#43e97b' : healthPercent > 0.25 ? '#ffa500' : '#ff4444';
        ctx.fillRect(p.x - barWidth / 2, p.y + 35, barWidth * healthPercent, barHeight);
    }
}

function renderProjectile(proj) {
    const gradient = ctx.createRadialGradient(proj.x, proj.y, 0, proj.x, proj.y, proj.size * 2);
    gradient.addColorStop(0, 'rgba(255, 235, 59, 0.8)');
    gradient.addColorStop(1, 'rgba(255, 235, 59, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(proj.x, proj.y, proj.size * 2, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.fillStyle = '#ffeb3b';
    ctx.beginPath();
    ctx.arc(proj.x, proj.y, proj.size, 0, Math.PI * 2);
    ctx.fill();
}

function renderParticle(p) {
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
}

function renderDamageNumber(dn) {
    ctx.globalAlpha = dn.life;
    ctx.font = 'bold 16px Arial';
    ctx.fillStyle = '#ff4444';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.textAlign = 'center';
    ctx.strokeText(dn.damage, dn.x, dn.y);
    ctx.fillText(dn.damage, dn.x, dn.y);
    ctx.globalAlpha = 1;
}

function renderMinimap() {
    const minimapCanvas = document.getElementById('minimapCanvas');
    const mctx = minimapCanvas.getContext('2d');
    const scale = 150 / CONFIG.WORLD_SIZE;
    
    mctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    mctx.fillRect(0, 0, 150, 150);
    
    mctx.strokeStyle = '#fff';
    mctx.lineWidth = 2;
    mctx.strokeRect(0, 0, 150, 150);
    
    mctx.fillStyle = '#f5576c';
    enemies.forEach(e => {
        mctx.beginPath();
        mctx.arc(e.x * scale, e.y * scale, 2, 0, Math.PI * 2);
        mctx.fill();
    });
    
    mctx.fillStyle = '#43e97b';
    Object.values(remotePlayers).forEach(p => {
        mctx.beginPath();
        mctx.arc(p.x * scale, p.y * scale, 3, 0, Math.PI * 2);
        mctx.fill();
    });
    
    mctx.fillStyle = '#667eea';
    mctx.beginPath();
    mctx.arc(player.x * scale, player.y * scale, 4, 0, Math.PI * 2);
    mctx.fill();
}

// ===== GAME OVER =====
function endGame() {
    gameState = 'gameover';
    const currentCumulative = parseInt(localStorage.getItem('cumulativeKills') || '0');
    localStorage.setItem('cumulativeKills', (currentCumulative + player.kills).toString());
    const isNewHighScore = saveHighScore(player.score);
    if (player.health === player.maxHealth) unlockTrophy('perfect_health');
    
    const newTrophies = TROPHIES.filter(t => t.unlocked && !localStorage.getItem(`trophy_shown_${t.id}`));
    newTrophies.forEach(t => localStorage.setItem(`trophy_shown_${t.id}`, 'true'));
    
    document.getElementById('gameUI').classList.add('hidden');
    document.getElementById('joystickContainer').classList.add('hidden');
    
    const gameOverScreen = document.getElementById('gameOverScreen');
    gameOverScreen.classList.remove('hidden');
    document.getElementById('finalScore').textContent = player.score;
    
    if (isNewHighScore) {
        document.getElementById('newHighScore').classList.remove('hidden');
        document.getElementById('highScoreValue').textContent = player.score;
    } else {
        document.getElementById('newHighScore').classList.add('hidden');
    }
    
    const survivalMinutes = Math.floor(gameStats.survivalTime / 60000);
    const survivalSeconds = Math.floor((gameStats.survivalTime % 60000) / 1000);
    document.getElementById('timeSurvived').textContent = `${survivalMinutes}:${survivalSeconds.toString().padStart(2, '0')}`;
    document.getElementById('totalKills').textContent = player.kills;
    document.getElementById('totalDamage').textContent = gameStats.totalDamage.toFixed(0);
    
    const avgDPS = gameStats.survivalTime > 0 ? (gameStats.totalDamage / (gameStats.survivalTime / 1000)).toFixed(1) : 0;
    document.getElementById('avgDPS').textContent = avgDPS;
    document.getElementById('favoriteWeapon').textContent = 'Pistolet';
    document.getElementById('waveReached').textContent = currentWave;
    
    const killsContainer = document.getElementById('killsByType');
    killsContainer.innerHTML = '';
    Object.keys(gameStats.killsByType).forEach(type => {
        const item = document.createElement('div');
        item.className = 'kill-type-item';
        const typeData = ENEMY_TYPES[type];
        item.innerHTML = `
            <span class="kill-type-name">${typeData.emoji} ${type}</span>
            <span class="kill-type-count">${gameStats.killsByType[type]}</span>
        `;
        killsContainer.appendChild(item);
    });
    
    if (newTrophies.length > 0) {
        document.getElementById('unlockedTrophies').classList.remove('hidden');
        const list = document.getElementById('newTrophiesList');
        list.innerHTML = '';
        newTrophies.forEach(trophy => {
            const item = document.createElement('div');
            item.className = 'new-trophy-item';
            item.innerHTML = `
                <span class="new-trophy-icon">${trophy.icon}</span>
                <div class="new-trophy-name">${trophy.name}</div>
            `;
            list.appendChild(item);
        });
    } else {
        document.getElementById('unlockedTrophies').classList.add('hidden');
    }
    
    updateFinalLeaderboard();
    displayTrophies();
}

function updateFinalLeaderboard() {
    const content = document.getElementById('finalLeaderboardContent');
    content.innerHTML = '';
    const players = [
        { name: player.name, emoji: player.emoji, score: player.score, id: 'me' },
        ...Object.values(remotePlayers).map(p => ({ name: p.n, emoji: p.e, score: p.sc || 0, id: p.id }))
    ];
    players.sort((a, b) => b.score - a.score);
    players.forEach((p, i) => {
        const item = document.createElement('div');
        item.className = 'final-leaderboard-item';
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        item.innerHTML = `
            <span style="font-size: 1.5rem; min-width: 40px;">${medal}</span>
            <span style="font-size: 1.2rem;">${p.emoji}</span>
            <span style="flex: 1; font-weight: bold;">${p.name}</span>
            <span style="font-weight: bold; color: #ffd700;">${p.score}</span>
        `;
        if (p.id === 'me') {
            item.style.background = 'rgba(102, 126, 234, 0.3)';
            item.style.border = '2px solid #667eea';
        }
        content.appendChild(item);
    });
}

function shareScore() {
    const minutes = Math.floor(gameStats.survivalTime / 60000);
    const seconds = Math.floor((gameStats.survivalTime % 60000) / 1000);
    const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    const shareText = `🧟 J'ai survécu ${timeStr} à Survivor Massive !
🎯 Kills: ${player.kills}
⭐ Score: ${player.score}
🌊 Vague: ${currentWave}

🏆 Peux-tu faire mieux ?`;
    
    if (navigator.share) {
        navigator.share({
            title: 'Mon Score - Survivor Massive',
            text: shareText
        }).catch(() => copyToClipboard(shareText));
    } else {
        copyToClipboard(shareText);
    }
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('btnShareScore');
        btn.textContent = '✓ Copié !';
        setTimeout(() => { btn.textContent = '📤 Partager'; }, 2000);
    });
}

function restartGame() {
    if (peer) peer.destroy();
    connections = [];
    remotePlayers = {};
    hostConnection = null;
    document.getElementById('gameOverScreen').classList.add('hidden');
    document.getElementById('customizationScreen').classList.add('active');
    document.querySelector('.customization-compact').style.display = 'flex';
    document.querySelector('.menu-buttons').style.display = 'flex';
    document.getElementById('hostSection').classList.add('hidden');
    document.getElementById('joinSection').classList.add('hidden');
    gameState = 'menu';
    gameMode = 'solo';
    isHost = false;
}
