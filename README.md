# 🎮 SURVIVOR.IO — Arcade Edition

<div align="center">

![Version](https://img.shields.io/badge/version-ARCADE--EDITION-ff6b6b?style=for-the-badge&logo=gamepad)
![Players](https://img.shields.io/badge/joueurs-jusqu'à%2010-667eea?style=for-the-badge&logo=people)
![PWA](https://img.shields.io/badge/PWA-prêt-2ecc71?style=for-the-badge&logo=pwa)
![P2P](https://img.shields.io/badge/réseau-PeerJS%20P2P-f093fb?style=for-the-badge&logo=webrtc)
![License](https://img.shields.io/badge/license-MIT-ffd700?style=for-the-badge)

**Jeu de survie multijoueur massif — Canvas HTML5 — 60 FPS — Zéro serveur**

[Jouer](https://votre-lien.com) · [Signaler un Bug](https://github.com/votre/repo/issues) · [Contribuer](https://github.com/votre/repo/pulls)

</div>

---

## ✨ Arcade Edition — Nouveautés

### 🎨 Personnalisation Avancée
- **16 avatars emoji** : Combattants, animaux, créatures mythiques (🥷🐺🦊🐉🧛👹💀🦁…)
- **8 couleurs d'aura** : Indigo, Rose, Vert, Bleu, Or, Rouge, Orange, Cyan — persistées en localStorage
- **Profil sauvegardé** : Pseudo, emoji et couleur rechargés automatiquement à chaque visite

### 🏅 Onglet Succès & Scores
- **Record absolu** : Score max, vague atteinte, temps de survie record
- **Stats cumulées** : Total kills, morts, XP ramassé, parties jouées — sur toutes les parties
- **Grille de badges** : 8+ succès avec icônes colorées (débloqués) ou grisées (verrouillées)

### 💥 Game Feel — Effets Visuels
| Effet | Déclencheur | Description |
|---|---|---|
| **Screen Shake** 📷 | Dégâts reçus / Boss mort | Tremblement du canvas calibré par intensité |
| **Impact Flash** ⚡ | Coup ennemi | Flash blanc sur l'ennemi touché (fondu 0.3s) |
| **Particules colorées** 🎇 | Mort ennemi | Explosion utilisant la couleur propre du type |
| **Aura dynamique** 🌟 | En permanence | Halo pulsant autour du joueur (couleur choisie) |

### 🗂️ Interface à Onglets
```
[ 🎮 JOUER ] — Personnalisation + matchmaking
[ 🏅 SUCCÈS ] — Records, stats cumulées, badges
[ ⚙️ PARAMS ] — Performance, FPS, diagnostics
```

---

## 🚀 Installation

```bash
# 1. Clone ou télécharge les fichiers
git clone https://github.com/votre/survivor-io.git
cd survivor-io

# 2. Lance un serveur local (Node.js)
npx serve .
# ou Python
python3 -m http.server 8080

# 3. Ouvre dans le navigateur
# http://localhost:8080
```

> **💡 Conseil mobile** : Sur Chrome/Safari, utilise "Ajouter à l'écran d'accueil" pour l'expérience PWA fullscreen.

---

## 🎮 Comment Jouer

### Démarrage rapide
1. Saisis ton pseudo et choisis ton avatar + couleur d'aura
2. **Solo** → Lance directement · **Héberger** → Partage le code PIN · **Rejoindre** → Entre le PIN à 6 chiffres

### Contrôles
| Plateforme | Déplacement | Compétence |
|---|---|---|
| **PC** | `ZQSD` / `WASD` / Flèches | `Espace` |
| **Mobile** | Joystick tactile (bas gauche) | Toucher (droite) ou bouton 💥 |

### Système de Jeu
- **Tir automatique** vers l'ennemi le plus proche dans un rayon de 420px
- **Montée de niveau** via XP → Menu de 3 bonus aléatoires à choisir
- **14 bonus cumulables** : Vitesse, Dégâts, Cadence, HP, Aura, Ricochet, Drones, Vampirisme, Aimant, Multi-tir, Mur, Mines, Bottes, Recyclage
- **Difficulté +15%** toutes les 30 secondes (HP et vitesse ennemis)

---

## 🧟 Types d'Ennemis

| Emoji | Nom | HP | Vitesse | Particularité |
|---|---|---|---|---|
| 🧟 | Zombie | 30 | Normale | Standard |
| 👻 | Fantôme | 15 | ×2.4 | Semi-transparent |
| 👾 | Alien | 120 | Lente | Tire des projectiles |
| 🐂 | Minotaure | 200 | ×1.7 | Charge violente |
| 🍄 | Fungus | 60 | Très lente | Nuage toxique |
| 🕷️ | Araignée | 45 | Rapide | Ralentit le joueur |

---

## 🏆 Succès Disponibles

| Badge | Nom | Condition |
|---|---|---|
| 🩸 | Premier Sang | Tuer 1 ennemi |
| ⏱️ | Survivant 5min | Survivre 5 minutes |
| 🔪 | Boucher | Tuer 100 ennemis |
| ⚔️ | Massacreur | 1000 kills cumulés |
| 🔟 | Niveau 10 | Atteindre le niveau 10 |
| 💯 | 10K Points | Atteindre 10 000 points |
| 🌊 | Vague 10 | Atteindre la vague 10 |
| 💚 | Santé Parfaite | Finir avec 100% HP |

---

## ⚡ Architecture Technique

### Performance (60 FPS cible)
- **Object Pool** : 600 particules + 100 dommages — zéro GC en hot path
- **Spatial Grid** : Détection collisions O(1) — obstacles statique, ennemis dynamique
- **Frustum Culling** : Rendu uniquement des entités dans le viewport + marge
- **Batch Rendering** : `ctx.font` défini une fois par type pour 600 ennemis
- **Mode Performance** : Désactive ombres, simplifie géométries

### Réseau P2P (PeerJS)
- **30Hz** broadcast état du monde (ennemis + positions)
- **Interpolation Lerp 0.15** : Mouvement fluide des objets distants
- **Zéro sync visuelle** : Particules générées localement, jamais envoyées
- **Seed déterministe** : Monde identique garanti pour tous (seed envoyée au démarrage)

### Persistance (localStorage)
| Clé | Contenu |
|---|---|
| `sio_name` | Pseudo joueur |
| `sio_emoji` | Avatar choisi |
| `sio_aura` | Couleur d'aura |
| `sio_hs` | Record de score |
| `sio_bestWave` | Meilleure vague |
| `sio_bestTime` | Meilleur temps de survie |
| `sio_cumKills` | Total kills cumulés |
| `sio_cumDeaths` | Total morts |
| `sio_cumXP` | Total XP ramassé |
| `sio_cumGames` | Nombre de parties |

---

## 📁 Fichiers

```
📦 survivor-io/
├── 🎮 index.html      — Structure + UI (tabs, achievements, aura picker)
├── 🎨 style.css       — Design glassmorphism, tabs, badges
├── ⚙️ script.js       — Logique complète (game loop, réseau, rendu)
├── 📋 manifest.json   — PWA metadata
├── 🔧 sw.js           — Service Worker (cache offline)
└── 📖 README.md       — Ce fichier
```

---

## 🔧 Configuration Rapide

```javascript
// Dans script.js → const CFG = { ... }
CFG.WORLD          = 5000      // Taille de la carte
CFG.MAX_PLAYERS    = 10        // Joueurs simultanés
CFG.SYNC_RATE      = 33        // Hz réseau (33ms = ~30Hz)
CFG.ABILITY_CD     = 10000     // Cooldown compétence (ms)
CFG.DIFF_RATE      = 0.15      // Scaling difficulté par vague (+15%)
CFG.MAX_ENEMY_CAP  = 600       // Cap absolu d'ennemis
CFG.SHOOT_RANGE    = 420       // Portée de tir auto
```

---

## 🤝 Compatibilité

| Navigateur | Solo | Multi | PWA |
|---|---|---|---|
| Chrome 90+ | ✅ | ✅ | ✅ |
| Edge 90+ | ✅ | ✅ | ✅ |
| Firefox 88+ | ✅ | ✅ | ❌ |
| Safari 15+ | ✅ | ✅ | ✅ |
| Mobile Chrome | ✅ | ✅ | ✅ |
| Mobile Safari | ✅ | ✅ | ✅ |

> Le mode multijoueur nécessite une connexion internet (serveur de signaling PeerJS).

---

<div align="center">

Fait avec ❤️ · Canvas HTML5 · PeerJS WebRTC · Zero dependencies sauf PeerJS

</div>
