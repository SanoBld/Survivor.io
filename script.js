// ===== CONFIGURATION & CONSTANTES =====
const CONFIG = {
    WORLD_SIZE: 4000,
    CAMERA_SMOOTH: 0.1,
    ENEMY_SYNC_RATE: 33, // 30Hz (1000ms / 30)
    INTERPOLATION_SPEED: 0.15,
    MAX_PLAYERS: 10,
    ABILITY_COOLDOWN: 10000,
    DAY_NIGHT_CYCLE: 120000,
    STRUCTURE_SEED: 42
};

// ===== VARIABLES GLOBALES =====
let canvas, ctx;
let gameState = 'menu';
let gameMode = 'solo';
let isHost = false;

// PeerJS
let peer = null;
let connections = [];
let hostConnection = null;
let myPeerId = '';
let roomPin = '';
let networkPing = 0;
let lastPingTime = 0;

// Joueur local
let player = {
    x: CONFIG.WORLD_SIZE / 2,
    y: CONFIG.WORLD_SIZE / 2,
    vx: 0,
    vy: 0,
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
    weapons: ['pistol'],
    currentWeapon: 'pistol'
};

// Statistiques
let gameStats = {
    startTime: 0,
    survivalTime: 0,
    totalDamage: 0,
    killsByType: {},
    weaponKills: {}
};

// Compétence spéciale
let specialAbility = {
    ready: true,
    cooldown: 0,
    lastUse: 0
};

// Camera & Shake
let camera = { x: 0, y: 0, shake: 0, shakeX: 0, shakeY: 0 };

// Cycle jour/nuit
let dayNightCycle = 0;
let timeOfDay = 0;

// Entities
let enemies = [];
let projectiles = [];
let gems = [];
let particles = [];
let damageNumbers = [];
let obstacles = [];

// Remote players
let remotePlayers = {};

// Input
let keys = {};
let joystick = { active: false, x: 0, y: 0, startX: 0, startY: 0 };
let isMobile = /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent);

// Wave system
let currentWave = 1;
let enemiesInWave = 10;
let enemiesSpawned = 0;

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

// Armes
const WEAPONS = {
    pistol: { name: 'Pistolet', damage: 10, fireRate: 500, speed: 8, size: 4, icon: '🔫' },
    shotgun: { name: 'Fusil à Pompe', damage: 8, fireRate: 1000, speed: 6, size: 5, spread: 3, icon: '🔫' },
    sniper: { name: 'Sniper', damage: 30, fireRate: 1500, speed: 15, size: 3, pierce: true, icon: '🎯' },
    machinegun: { name: 'Mitraillette', damage: 7, fireRate: 150, speed: 10, size: 3, icon: '🔫' },
    laser: { name: 'Laser', damage: 15, fireRate: 300, speed: 20, size: 2, trail: true, icon: '⚡' }
};

// ===== SEEDED RANDOM =====
class SeededRandom {
    constructor(seed) {
        this.seed = seed;
    }
    
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
};

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

function loadHighScore() {
    const saved = localStorage.getItem('survivorHighScore');
    if (saved) {
        document.getElementById('highScoreValue').textContent = saved;
    }
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
            if (unlocked.includes(trophy.id)) {
                trophy.unlocked = true;
            }
        });
    }
    
    const cumulativeKills = parseInt(localStorage.getItem('cumulativeKills') || '0');
    if (cumulativeKills >= 1000) {
        unlockTrophy('butcher_1000');
    }
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
    
    setupNumpad();
}

function setupNumpad() {
    let pinInput = '';
    const digits = document.querySelectorAll('.pin-digit');
    
    document.querySelectorAll('.numpad-btn').forEach(btn => {
        btn.onclick = () => {
            const num = btn.dataset.num;
            
            if (num === 'clear') {
                pinInput = '';
                updatePinDisplay(pinInput, digits);
            } else if (num === 'ok') {
                if (pinInput.length === 6) {
                    joinGame(pinInput);
                }
            } else {
                if (pinInput.length < 6) {
                    pinInput += num;
                    updatePinDisplay(pinInput, digits);
                }
            }
        };
    });
}

function updatePinDisplay(pin, digits) {
    for (let i = 0; i < 6; i++) {
        if (i < pin.length) {
            digits[i].textContent = pin[i];
            digits[i].classList.add('filled');
        } else {
            digits[i].textContent = '-';
            digits[i].classList.remove('filled');
        }
    }
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
    
    peer.on('connection', (conn) => {
        handleIncomingConnection(conn);
    });
    
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
        
        conn.send({
            t: 'init',
            p: { ...player }
        });
    });
    
    conn.on('data', (data) => {
        handleHostMessage(data, conn);
    });
    
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
            lu: Date.now(), // last update
            ix: data.p.x, // interpolate x
            iy: data.p.y  // interpolate y
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
        
        hostConnection.on('data', (data) => {
            handleClientMessage(data);
        });
        
        hostConnection.on('close', () => {
            console.log('Disconnected from host');
            if (gameState === 'playing') {
                endGame();
            }
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
        updateRemotePlayersFromHost(data.p);
    } else if (data.t === 'pong') {
        networkPing = Date.now() - data.ts;
    }
}

function updateEnemiesFromHost(hostEnemies) {
    hostEnemies.forEach(he => {
        let localEnemy = enemies.find(e => e.id === he.i);
        if (!localEnemy) {
            enemies.push({
                id: he.i,
                x: he.x,
                y: he.y,
                health: he.h,
                maxHealth: he.mh,
                type: he.ty,
                speed: he.s || 1,
                damage: he.d || 15,
                size: he.sz || 20,
                color: he.c || '#95e1d3',
                ix: he.x,
                iy: he.y,
                lu: Date.now()
            });
        } else {
            localEnemy.ix = localEnemy.x;
            localEnemy.iy = localEnemy.y;
            localEnemy.tx = he.x; // target x
            localEnemy.ty = he.y; // target y
            localEnemy.health = he.h;
            localEnemy.lu = Date.now();
        }
    });
    
    enemies = enemies.filter(e => hostEnemies.find(he => he.i === e.id));
}

function updateRemotePlayersFromHost(players) {
    Object.keys(players).forEach(id => {
        if (id !== myPeerId) {
            if (!remotePlayers[id]) {
                remotePlayers[id] = { 
                    ...players[id], 
                    ix: players[id].x, 
                    iy: players[id].y 
                };
            } else {
                remotePlayers[id].ix = remotePlayers[id].x;
                remotePlayers[id].iy = remotePlayers[id].y;
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
            sz: e.size,
            c: e.color
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
        if (conn.open) {
            conn.send(state);
        }
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
        setTimeout(() => {
            btn.textContent = '📋 Copier';
        }, 2000);
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
            if (conn.open) {
                conn.send({ t: 'gs' });
            }
        });
    }
    initGame();
    startGame();
}

function initGame() {
    // Clear arrays
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
    player.weapons = ['pistol'];
    player.currentWeapon = 'pistol';
    
    // Reset stats
    gameStats = {
        startTime: Date.now(),
        survivalTime: 0,
        totalDamage: 0,
        killsByType: {},
        weaponKills: {}
    };
    
    // Reset ability
    specialAbility = { ready: true, cooldown: 0, lastUse: 0 };
    
    // Reset wave
    currentWave = 1;
    enemiesInWave = 10;
    enemiesSpawned = 0;
    
    // Reset camera
    camera = { x: 0, y: 0, shake: 0, shakeX: 0, shakeY: 0 };
    
    // Reset day/night
    dayNightCycle = 0;
    timeOfDay = 0;
    
    // Generate obstacles
    generateObstacles();
}

function startGame() {
    document.getElementById('customizationScreen').classList.remove('active');
    document.getElementById('gameUI').classList.remove('hidden');
    
    if (isMobile) {
        document.getElementById('joystickContainer').classList.remove('hidden');
    }
    
    // Show online indicator if multiplayer
    if (gameMode !== 'solo') {
        document.getElementById('onlineIndicator').style.display = 'flex';
    }
    
    gameState = 'playing';
    updateUI();
}

function generateObstacles() {
    const rng = new SeededRandom(CONFIG.STRUCTURE_SEED);
    
    for (let i = 0; i < 60; i++) {
        const typeRoll = rng.next();
        let type, width, height;
        
        if (typeRoll < 0.3) {
            type = 'container';
            width = 80 + rng.next() * 40;
            height = 60 + rng.next() * 30;
        } else if (typeRoll < 0.6) {
            type = 'ruins';
            width = 100 + rng.next() * 50;
            height = 100 + rng.next() * 50;
        } else if (typeRoll < 0.8) {
            type = 'rock';
            width = 40 + rng.next() * 60;
            height = 40 + rng.next() * 60;
        } else {
            type = 'debris';
            width = 30 + rng.next() * 30;
            height = 30 + rng.next() * 30;
        }
        
        obstacles.push({
            x: rng.next() * CONFIG.WORLD_SIZE,
            y: rng.next() * CONFIG.WORLD_SIZE,
            width,
            height,
            type,
            solid: type !== 'debris'
        });
    }
}

// ===== COLLISION DETECTION =====
function checkObstacleCollision(entity) {
    for (let obs of obstacles) {
        if (!obs.solid) continue;
        
        const entityLeft = entity.x - (entity.size || 25);
        const entityRight = entity.x + (entity.size || 25);
        const entityTop = entity.y - (entity.size || 25);
        const entityBottom = entity.y + (entity.size || 25);
        
        const obsLeft = obs.x - obs.width / 2;
        const obsRight = obs.x + obs.width / 2;
        const obsTop = obs.y - obs.height / 2;
        const obsBottom = obs.y + obs.height / 2;
        
        if (entityRight > obsLeft && entityLeft < obsRight &&
            entityBottom > obsTop && entityTop < obsBottom) {
            
            // Calculate overlap
            const overlapX = Math.min(entityRight - obsLeft, obsRight - entityLeft);
            const overlapY = Math.min(entityBottom - obsTop, obsBottom - entityTop);
            
            // Push out on smallest overlap
            if (overlapX < overlapY) {
                if (entity.x < obs.x) {
                    entity.x -= overlapX;
                } else {
                    entity.x += overlapX;
                }
                entity.vx = 0;
            } else {
                if (entity.y < obs.y) {
                    entity.y -= overlapY;
                } else {
                    entity.y += overlapY;
                }
                entity.vy = 0;
            }
            
            return true;
        }
    }
    
    // Check debris (slow down)
    for (let obs of obstacles) {
        if (obs.type === 'debris') {
            const dist = Math.hypot(entity.x - obs.x, entity.y - obs.y);
            if (dist < obs.width) {
                if (entity.speed) entity.speed *= 0.5;
                return false;
            }
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
    
    // Mobile joystick
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

function gameLoop(currentTime) {
    const deltaTime = Math.min(currentTime - lastTime, 100);
    lastTime = currentTime;
    
    if (gameState === 'playing') {
        update(deltaTime);
        render();
        
        // Network sync
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
    
    dayNightCycle += deltaTime;
    timeOfDay = (Math.sin(dayNightCycle / CONFIG.DAY_NIGHT_CYCLE * Math.PI * 2) + 1) / 2;
    
    updatePlayer(deltaTime);
    updateCamera();
    updateAbilityCooldown();
    
    if (gameMode !== 'client') {
        spawnEnemies();
    }
    
    updateEnemies(deltaTime);
    updateProjectiles(deltaTime);
    updateGems(deltaTime);
    updateParticles(deltaTime);
    updateDamageNumbers(deltaTime);
    
    interpolateRemotePlayers(deltaTime);
    
    if (gameMode !== 'client') {
        checkCollisions();
    }
    
    updateUI();
    checkTrophies();
}

function updatePlayer(deltaTime) {
    let moveX = 0;
    let moveY = 0;
    
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
    
    player.vx = moveX * player.speed;
    player.vy = moveY * player.speed;
    
    const oldX = player.x;
    const oldY = player.y;
    
    player.x += player.vx;
    player.y += player.vy;
    
    // Collision check
    if (checkObstacleCollision(player)) {
        // Already pushed out by checkObstacleCollision
    }
    
    player.x = Math.max(50, Math.min(CONFIG.WORLD_SIZE - 50, player.x));
    player.y = Math.max(50, Math.min(CONFIG.WORLD_SIZE - 50, player.y));
    
    if (gameMode !== 'client') {
        autoShoot();
    } else {
        autoShootClient();
    }
    
    if (player.health < player.maxHealth) {
        player.health += 0.01;
    }
}

function autoShoot() {
    if (Date.now() - player.lastShot < getWeaponStat('fireRate')) return;
    
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
        
        if (getWeaponStat('spread')) {
            const spread = getWeaponStat('spread');
            for (let i = -1; i <= 1; i++) {
                createProjectile(player.x, player.y, angle + i * 0.3, player);
            }
        } else {
            createProjectile(player.x, player.y, angle, player);
        }
        
        player.lastShot = Date.now();
    }
}

function autoShootClient() {
    if (Date.now() - player.lastShot < getWeaponStat('fireRate')) return;
    
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
        createLocalProjectile(player.x, player.y, angle);
        
        if (hostConnection && hostConnection.open) {
            hostConnection.send({ t: 'sh', a: angle });
        }
        
        player.lastShot = Date.now();
    }
}

function createProjectile(x, y, angle, owner) {
    const weapon = WEAPONS[player.currentWeapon];
    projectiles.push({
        x,
        y,
        vx: Math.cos(angle) * weapon.speed,
        vy: Math.sin(angle) * weapon.speed,
        damage: owner.damage || player.damage,
        size: weapon.size,
        pierce: weapon.pierce || false,
        trail: weapon.trail || false,
        owner: owner.id || 'player',
        pierced: 0
    });
}

function createLocalProjectile(x, y, angle) {
    const weapon = WEAPONS[player.currentWeapon];
    projectiles.push({
        x,
        y,
        vx: Math.cos(angle) * weapon.speed,
        vy: Math.sin(angle) * weapon.speed,
        damage: player.damage,
        size: weapon.size,
        local: true,
        owner: 'player'
    });
}

function getWeaponStat(stat) {
    const weapon = WEAPONS[player.currentWeapon];
    return weapon[stat] || WEAPONS.pistol[stat];
}

function useSpecialAbility() {
    if (!specialAbility.ready) return;
    
    specialAbility.ready = false;
    specialAbility.lastUse = Date.now();
    camera.shake = 20;
    
    enemies.forEach(enemy => {
        const dist = Math.hypot(enemy.x - player.x, enemy.y - player.y);
        if (dist < 200) {
            const angle = Math.atan2(enemy.y - player.y, enemy.x - player.x);
            enemy.vx = Math.cos(angle) * 10;
            enemy.vy = Math.sin(angle) * 10;
            enemy.health -= player.damage * 3;
            createDamageNumber(enemy.x, enemy.y, player.damage * 3);
        }
    });
    
    for (let i = 0; i < 50; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 5 + Math.random() * 5;
        particles.push({
            x: player.x,
            y: player.y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            life: 1,
            size: 3 + Math.random() * 5,
            color: `hsl(${Math.random() * 60 + 300}, 100%, 50%)`
        });
    }
}

function updateAbilityCooldown() {
    if (!specialAbility.ready) {
        const elapsed = Date.now() - specialAbility.lastUse;
        specialAbility.cooldown = Math.max(0, CONFIG.ABILITY_COOLDOWN - elapsed);
        
        if (specialAbility.cooldown === 0) {
            specialAbility.ready = true;
        }
        
        const progress = 1 - (specialAbility.cooldown / CONFIG.ABILITY_COOLDOWN);
        const circumference = 2 * Math.PI * 45;
        const offset = circumference * (1 - progress);
        document.getElementById('cooldownCircle').style.strokeDashoffset = offset;
        
        const btn = document.getElementById('abilityBtn');
        if (specialAbility.ready) {
            btn.classList.remove('on-cooldown');
        } else {
            btn.classList.add('on-cooldown');
        }
    }
}

function updateCamera() {
    camera.x += (player.x - camera.x) * CONFIG.CAMERA_SMOOTH;
    camera.y += (player.y - camera.y) * CONFIG.CAMERA_SMOOTH;
    
    if (camera.shake > 0) {
        camera.shakeX = (Math.random() - 0.5) * camera.shake;
        camera.shakeY = (Math.random() - 0.5) * camera.shake;
        camera.shake *= 0.9;
        if (camera.shake < 0.5) {
            camera.shake = 0;
            camera.shakeX = 0;
            camera.shakeY = 0;
        }
    }
}

function spawnEnemies() {
    if (enemiesSpawned < enemiesInWave) {
        if (Math.random() < 0.02) {
            spawnEnemy();
            enemiesSpawned++;
        }
    } else if (enemies.length === 0) {
        currentWave++;
        enemiesInWave += 5;
        enemiesSpawned = 0;
    }
}

function spawnEnemy() {
    const angle = Math.random() * Math.PI * 2;
    const distance = 600 + Math.random() * 200;
    
    const types = ['zombie', 'fast', 'tank'];
    const type = types[Math.floor(Math.random() * types.length)];
    
    let health, speed, damage, size, color;
    
    switch (type) {
        case 'fast':
            health = 30;
            speed = 2;
            damage = 10;
            size = 15;
            color = '#ff6b6b';
            break;
        case 'tank':
            health = 100;
            speed = 0.5;
            damage = 30;
            size = 30;
            color = '#4ecdc4';
            break;
        default:
            health = 50;
            speed = 1;
            damage = 15;
            size = 20;
            color = '#95e1d3';
    }
    
    enemies.push({
        id: Date.now() + Math.random(),
        x: player.x + Math.cos(angle) * distance,
        y: player.y + Math.sin(angle) * distance,
        vx: 0,
        vy: 0,
        health,
        maxHealth: health,
        speed,
        damage,
        size,
        type,
        color,
        ix: 0,
        iy: 0,
        lu: Date.now()
    });
}

function updateEnemies(deltaTime) {
    enemies.forEach(enemy => {
        if (gameMode !== 'client') {
            // Host AI
            const dx = player.x - enemy.x;
            const dy = player.y - enemy.y;
            const dist = Math.hypot(dx, dy);
            
            if (dist > 0) {
                enemy.vx = (dx / dist) * enemy.speed;
                enemy.vy = (dy / dist) * enemy.speed;
                
                const oldX = enemy.x;
                const oldY = enemy.y;
                
                enemy.x += enemy.vx;
                enemy.y += enemy.vy;
                
                checkObstacleCollision(enemy);
            }
        } else {
            // Client interpolation
            if (enemy.tx !== undefined) {
                enemy.x += (enemy.tx - enemy.x) * CONFIG.INTERPOLATION_SPEED;
                enemy.y += (enemy.ty - enemy.y) * CONFIG.INTERPOLATION_SPEED;
            }
        }
        
        if (enemy.health <= 0) {
            onEnemyDeath(enemy);
        }
    });
    
    enemies = enemies.filter(e => e.health > 0);
}

function onEnemyDeath(enemy) {
    player.kills++;
    player.score += 10;
    gameStats.killsByType[enemy.type] = (gameStats.killsByType[enemy.type] || 0) + 1;
    gameStats.weaponKills[player.currentWeapon] = (gameStats.weaponKills[player.currentWeapon] || 0) + 1;
    
    const numGems = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < numGems; i++) {
        gems.push({
            x: enemy.x + (Math.random() - 0.5) * 30,
            y: enemy.y + (Math.random() - 0.5) * 30,
            value: 10,
            size: 8
        });
    }
    
    for (let i = 0; i < 20; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 2 + Math.random() * 4;
        particles.push({
            x: enemy.x,
            y: enemy.y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            life: 1,
            size: 3 + Math.random() * 5,
            color: enemy.color
        });
    }
}

function updateProjectiles(deltaTime) {
    projectiles.forEach(proj => {
        proj.x += proj.vx;
        proj.y += proj.vy;
        
        if (proj.trail && Math.random() < 0.3) {
            particles.push({
                x: proj.x,
                y: proj.y,
                vx: 0,
                vy: 0,
                life: 0.5,
                size: proj.size,
                color: '#ffeb3b'
            });
        }
    });
    
    projectiles = projectiles.filter(p =>
        p.x > 0 && p.x < CONFIG.WORLD_SIZE &&
        p.y > 0 && p.y < CONFIG.WORLD_SIZE
    );
}

function updateGems(deltaTime) {
    gems.forEach(gem => {
        const dist = Math.hypot(gem.x - player.x, gem.y - player.y);
        if (dist < 150) {
            const angle = Math.atan2(player.y - gem.y, player.x - gem.x);
            const speed = 5;
            gem.x += Math.cos(angle) * speed;
            gem.y += Math.sin(angle) * speed;
        }
        
        if (dist < 30) {
            player.xp += gem.value;
            gem.collected = true;
            
            particles.push({
                x: gem.x,
                y: gem.y,
                vx: 0,
                vy: -2,
                life: 1,
                size: 10,
                color: '#ffd700'
            });
        }
    });
    
    gems = gems.filter(g => !g.collected);
    
    while (player.xp >= player.xpToLevel) {
        player.xp -= player.xpToLevel;
        player.level++;
        player.xpToLevel = Math.floor(player.xpToLevel * 1.5);
        showUpgradeMenu();
    }
}

function updateParticles(deltaTime) {
    particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.1;
        p.life -= deltaTime / 1000;
    });
    
    particles = particles.filter(p => p.life > 0);
}

function updateDamageNumbers(deltaTime) {
    damageNumbers.forEach(dn => {
        dn.y -= 1;
        dn.life -= deltaTime / 1000;
    });
    
    damageNumbers = damageNumbers.filter(dn => dn.life > 0);
}

function interpolateRemotePlayers(deltaTime) {
    Object.values(remotePlayers).forEach(p => {
        if (p.tx !== undefined) {
            p.x += (p.tx - p.x) * CONFIG.INTERPOLATION_SPEED;
            p.y += (p.ty - p.y) * CONFIG.INTERPOLATION_SPEED;
        }
    });
}

function checkCollisions() {
    projectiles.forEach(proj => {
        if (proj.local) return;
        
        enemies.forEach(enemy => {
            const dist = Math.hypot(proj.x - enemy.x, proj.y - enemy.y);
            if (dist < enemy.size + proj.size) {
                enemy.health -= proj.damage;
                gameStats.totalDamage += proj.damage;
                createDamageNumber(enemy.x, enemy.y, proj.damage);
                
                if (!proj.pierce) {
                    proj.dead = true;
                } else {
                    proj.pierced++;
                    if (proj.pierced > 3) proj.dead = true;
                }
            }
        });
    });
    
    projectiles = projectiles.filter(p => !p.dead);
    
    enemies.forEach(enemy => {
        const dist = Math.hypot(enemy.x - player.x, enemy.y - player.y);
        if (dist < enemy.size + 25) {
            player.health -= enemy.damage * 0.01;
            camera.shake = 10;
            
            if (player.health <= 0) {
                endGame();
            }
        }
    });
}

function createDamageNumber(x, y, damage) {
    damageNumbers.push({
        x,
        y: y - 20,
        damage: Math.floor(damage),
        life: 1
    });
}

function showUpgradeMenu() {
    gameState = 'paused';
    const menu = document.getElementById('upgradeMenu');
    const options = document.getElementById('upgradeOptions');
    menu.classList.remove('hidden');
    options.innerHTML = '';
    
    const upgrades = [
        { name: 'Fusil à Pompe', desc: 'Tire en cône', icon: '🔫', action: () => { player.currentWeapon = 'shotgun'; player.weapons.push('shotgun'); } },
        { name: 'Sniper', desc: 'Dégâts élevés, perfore', icon: '🎯', action: () => { player.currentWeapon = 'sniper'; player.weapons.push('sniper'); } },
        { name: 'Mitraillette', desc: 'Tir rapide', icon: '🔫', action: () => { player.currentWeapon = 'machinegun'; player.weapons.push('machinegun'); } },
        { name: 'Laser', desc: 'Très rapide', icon: '⚡', action: () => { player.currentWeapon = 'laser'; player.weapons.push('laser'); } },
        { name: '+20 HP Max', desc: 'Augmente PV max', icon: '❤️', action: () => { player.maxHealth += 20; player.health = player.maxHealth; } },
        { name: '+10 Dégâts', desc: 'Plus de dégâts', icon: '⚔️', action: () => { player.damage += 10; } },
        { name: '+0.5 Vitesse', desc: 'Plus rapide', icon: '⚡', action: () => { player.speed += 0.5; } }
    ];
    
    const selected = [];
    while (selected.length < 3) {
        const upgrade = upgrades[Math.floor(Math.random() * upgrades.length)];
        if (!selected.includes(upgrade)) {
            selected.push(upgrade);
        }
    }
    
    selected.forEach(upgrade => {
        const card = document.createElement('div');
        card.className = 'upgrade-card';
        card.innerHTML = `
            <div class="upgrade-icon">${upgrade.icon}</div>
            <div class="upgrade-name">${upgrade.name}</div>
            <div class="upgrade-desc">${upgrade.desc}</div>
        `;
        card.onclick = () => {
            upgrade.action();
            menu.classList.add('hidden');
            gameState = 'playing';
        };
        options.appendChild(card);
    });
}

function checkTrophies() {
    if (player.kills >= 1) unlockTrophy('first_blood');
    if (gameStats.survivalTime >= 300000) unlockTrophy('survivor_5min');
    if (player.kills >= 100) unlockTrophy('butcher_100');
    if (player.level >= 10) unlockTrophy('lvl_10');
    if (player.score >= 10000) unlockTrophy('score_10k');
    if (currentWave >= 10) unlockTrophy('wave_10');
}

function updateUI() {
    // Online indicator
    if (gameMode !== 'solo') {
        const playerCount = 1 + Object.keys(remotePlayers).length;
        document.getElementById('playerCountDisplay').textContent = playerCount;
        document.getElementById('pingText').textContent = networkPing + 'ms';
    }
    
    // XP
    document.getElementById('levelDisplay').textContent = `NIV. ${player.level}`;
    document.getElementById('xpDisplay').textContent = `${Math.floor(player.xp)} / ${player.xpToLevel} XP`;
    const xpPercent = (player.xp / player.xpToLevel) * 100;
    document.getElementById('xpFill').style.width = xpPercent + '%';
    
    // Stats
    document.getElementById('playerEmoji').textContent = player.emoji;
    document.getElementById('playerNameDisplay').textContent = player.name;
    document.getElementById('healthDisplay').textContent = Math.floor(player.health);
    document.getElementById('damageDisplay').textContent = player.damage;
    document.getElementById('killCount').textContent = player.kills;
    document.getElementById('scoreDisplay').textContent = player.score;
    
    // Wave
    document.getElementById('waveDisplay').textContent = `VAGUE ${currentWave}`;
    document.getElementById('enemyCount').textContent = `${enemies.length} ENNEMIS`;
    
    updateLeaderboard();
}

function updateLeaderboard() {
    const content = document.getElementById('leaderboardContent');
    content.innerHTML = '';
    
    const players = [
        { name: player.name, emoji: player.emoji, score: player.score, id: 'me' },
        ...Object.values(remotePlayers).map(p => ({ name: p.n, emoji: p.e, score: p.sc, id: p.id }))
    ];
    
    players.sort((a, b) => b.score - a.score);
    
    players.slice(0, 10).forEach((p, i) => {
        const item = document.createElement('div');
        item.className = 'leaderboard-item';
        
        let rankClass = '';
        if (i === 0) rankClass = 'gold';
        else if (i === 1) rankClass = 'silver';
        else if (i === 2) rankClass = 'bronze';
        
        item.innerHTML = `
            <span class="rank ${rankClass}">${i + 1}</span>
            <span class="player-emoji">${p.emoji}</span>
            <span class="player-name">${p.name}</span>
            <span class="player-score">${p.score}</span>
        `;
        
        if (p.id === 'me') {
            item.style.background = 'rgba(102, 126, 234, 0.3)';
        }
        
        content.appendChild(item);
    });
}

// ===== RENDER =====
function render() {
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.save();
    
    ctx.translate(
        canvas.width / 2 - camera.x + camera.shakeX,
        canvas.height / 2 - camera.y + camera.shakeY
    );
    
    renderDayNight();
    
    const viewLeft = camera.x - canvas.width / 2 - 100;
    const viewRight = camera.x + canvas.width / 2 + 100;
    const viewTop = camera.y - canvas.height / 2 - 100;
    const viewBottom = camera.y + canvas.height / 2 + 100;
    
    renderGrid(viewLeft, viewRight, viewTop, viewBottom);
    
    obstacles.forEach(obs => {
        if (isInView(obs.x, obs.y, viewLeft, viewRight, viewTop, viewBottom)) {
            renderObstacle(obs);
        }
    });
    
    gems.forEach(gem => {
        if (isInView(gem.x, gem.y, viewLeft, viewRight, viewTop, viewBottom)) {
            renderGem(gem);
        }
    });
    
    enemies.forEach(enemy => {
        if (isInView(enemy.x, enemy.y, viewLeft, viewRight, viewTop, viewBottom)) {
            renderEnemy(enemy);
        }
    });
    
    Object.values(remotePlayers).forEach(p => {
        if (isInView(p.x, p.y, viewLeft, viewRight, viewTop, viewBottom)) {
            renderPlayer(p);
        }
    });
    
    renderPlayer(player, true);
    
    projectiles.forEach(proj => {
        if (isInView(proj.x, proj.y, viewLeft, viewRight, viewTop, viewBottom)) {
            renderProjectile(proj);
        }
    });
    
    particles.forEach(p => {
        if (isInView(p.x, p.y, viewLeft, viewRight, viewTop, viewBottom)) {
            renderParticle(p);
        }
    });
    
    damageNumbers.forEach(dn => {
        if (isInView(dn.x, dn.y, viewLeft, viewRight, viewTop, viewBottom)) {
            renderDamageNumber(dn);
        }
    });
    
    ctx.restore();
    
    renderMinimap();
}

function isInView(x, y, left, right, top, bottom) {
    return x >= left && x <= right && y >= top && y <= bottom;
}

function renderDayNight() {
    ctx.fillStyle = `rgba(0, 0, 50, ${timeOfDay * 0.5})`;
    ctx.fillRect(
        camera.x - canvas.width,
        camera.y - canvas.height,
        canvas.width * 3,
        canvas.height * 3
    );
    
    const gradient = ctx.createRadialGradient(player.x, player.y, 0, player.x, player.y, 200);
    gradient.addColorStop(0, `rgba(255, 255, 200, ${timeOfDay * 0.3})`);
    gradient.addColorStop(1, 'rgba(255, 255, 200, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(player.x - 200, player.y - 200, 400, 400);
}

function renderGrid(left, right, top, bottom) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
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
    ctx.save();
    ctx.translate(obs.x, obs.y);
    
    if (obs.type === 'container') {
        // Container avec dégradé métallique
        const gradient = ctx.createLinearGradient(-obs.width/2, -obs.height/2, obs.width/2, obs.height/2);
        gradient.addColorStop(0, '#666');
        gradient.addColorStop(0.5, '#999');
        gradient.addColorStop(1, '#555');
        ctx.fillStyle = gradient;
        ctx.fillRect(-obs.width/2, -obs.height/2, obs.width, obs.height);
        
        // Rayures
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 2;
        for (let i = 0; i < 3; i++) {
            const y = -obs.height/2 + (obs.height / 4) * (i + 1);
            ctx.beginPath();
            ctx.moveTo(-obs.width/2, y);
            ctx.lineTo(obs.width/2, y);
            ctx.stroke();
        }
        
        ctx.strokeStyle = '#aaa';
        ctx.lineWidth = 2;
        ctx.strokeRect(-obs.width/2, -obs.height/2, obs.width, obs.height);
        
    } else if (obs.type === 'ruins') {
        // Ruines en forme de L
        const gradient = ctx.createLinearGradient(-obs.width/2, -obs.height/2, obs.width/2, obs.height/2);
        gradient.addColorStop(0, '#8B7355');
        gradient.addColorStop(0.5, '#A0826D');
        gradient.addColorStop(1, '#6B5A4D');
        ctx.fillStyle = gradient;
        
        // Partie horizontale
        ctx.fillRect(-obs.width/2, obs.height/4, obs.width, obs.height/4);
        // Partie verticale
        ctx.fillRect(-obs.width/2, -obs.height/2, obs.width/3, obs.height);
        
        // Fissures
        ctx.strokeStyle = '#4a3f35';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-obs.width/4, -obs.height/2);
        ctx.lineTo(-obs.width/4 + 10, 0);
        ctx.lineTo(-obs.width/4, obs.height/2);
        ctx.stroke();
        
    } else if (obs.type === 'debris') {
        // Débris (petits blocs)
        ctx.fillStyle = '#666';
        for (let i = 0; i < 5; i++) {
            const size = obs.width / 5;
            const x = (Math.random() - 0.5) * obs.width * 0.8;
            const y = (Math.random() - 0.5) * obs.height * 0.8;
            ctx.fillRect(x - size/2, y - size/2, size, size);
        }
        
    } else {
        // Rock par défaut
        const gradient = ctx.createLinearGradient(-obs.width/2, -obs.height/2, obs.width/2, obs.height/2);
        gradient.addColorStop(0, '#666');
        gradient.addColorStop(0.5, '#555');
        gradient.addColorStop(1, '#444');
        ctx.fillStyle = gradient;
        ctx.fillRect(-obs.width/2, -obs.height/2, obs.width, obs.height);
        
        ctx.strokeStyle = '#888';
        ctx.lineWidth = 2;
        ctx.strokeRect(-obs.width/2, -obs.height/2, obs.width, obs.height);
    }
    
    ctx.restore();
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
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.beginPath();
    ctx.ellipse(enemy.x, enemy.y + enemy.size * 0.8, enemy.size * 0.8, enemy.size * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.fillStyle = enemy.color;
    ctx.beginPath();
    ctx.arc(enemy.x, enemy.y, enemy.size, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    
    const barWidth = enemy.size * 2;
    const barHeight = 4;
    const healthPercent = enemy.health / enemy.maxHealth;
    
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(enemy.x - barWidth / 2, enemy.y - enemy.size - 10, barWidth, barHeight);
    
    ctx.fillStyle = healthPercent > 0.5 ? '#43e97b' : healthPercent > 0.25 ? '#ffa500' : '#ff4444';
    ctx.fillRect(enemy.x - barWidth / 2, enemy.y - enemy.size - 10, barWidth * healthPercent, barHeight);
}

function renderPlayer(p, isLocal = false) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y + 30, 20, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.fillStyle = isLocal ? '#667eea' : '#f093fb';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 25, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.stroke();
    
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
    
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();
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
    newTrophies.forEach(t => {
        localStorage.setItem(`trophy_shown_${t.id}`, 'true');
    });
    
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
    
    let favoriteWeapon = 'Pistolet';
    let maxKills = 0;
    Object.keys(gameStats.weaponKills).forEach(weapon => {
        if (gameStats.weaponKills[weapon] > maxKills) {
            maxKills = gameStats.weaponKills[weapon];
            favoriteWeapon = WEAPONS[weapon].name;
        }
    });
    document.getElementById('favoriteWeapon').textContent = favoriteWeapon;
    document.getElementById('waveReached').textContent = currentWave;
    
    const killsContainer = document.getElementById('killsByType');
    killsContainer.innerHTML = '';
    Object.keys(gameStats.killsByType).forEach(type => {
        const item = document.createElement('div');
        item.className = 'kill-type-item';
        const typeNames = { zombie: 'Zombie', fast: 'Rapide', tank: 'Tank' };
        item.innerHTML = `
            <span class="kill-type-name">${typeNames[type] || type}</span>
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
        ...Object.values(remotePlayers).map(p => ({ name: p.n, emoji: p.e, score: p.sc, id: p.id }))
    ];
    
    players.sort((a, b) => b.score - a.score);
    
    players.forEach((p, i) => {
        const item = document.createElement('div');
        item.className = 'final-leaderboard-item';
        
        let medal = '';
        if (i === 0) medal = '🥇';
        else if (i === 1) medal = '🥈';
        else if (i === 2) medal = '🥉';
        else medal = `${i + 1}.`;
        
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
        }).catch(() => {
            copyToClipboard(shareText);
        });
    } else {
        copyToClipboard(shareText);
    }
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('btnShareScore');
        btn.textContent = '✓ Copié !';
        setTimeout(() => {
            btn.textContent = '📤 Partager';
        }, 2000);
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
