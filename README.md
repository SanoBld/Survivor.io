# 🎮 SURVIVOR.IO MASSIVE - JEU MULTIJOUEUR OPTIMISÉ (BETA)

## ✨ NOUVEAUTÉS ET OPTIMISATIONS

### 🚀 SYNCHRONISATION & FLUIDITÉ ZÉRO LAG
- **Mouvement Prédictif** : Le joueur local bouge instantanément sans attendre le réseau
- **Interpolation Fluide (Lerp 0.15)** : Tous les objets distants (joueurs, monstres, XP) utilisent une interpolation linéaire pour éliminer les micro-saccades
- **Fréquence Réseau 30Hz** : L'hôte diffuse les données toutes les 33ms avec compression JSON
- **Visibilité Mondiale** : L'hôte envoie les positions de TOUS les monstres et orbes d'XP à tous les clients

### 🧟 MONSTRES AVEC EMOJIS
- **🧟 Zombie** : Monstre standard (30 HP, vitesse normale)
- **👻 Fantôme** : Rapide mais fragile (15 HP, vitesse x2)
- **👾 Alien** : Boss massif (100 HP, puissant, 50 points)

### 🏗️ PHYSIQUE & STRUCTURES
- **Collisions AABB Réactivées** : Les joueurs et monstres ne peuvent plus traverser les obstacles
- **Génération par Seed Fixe (42)** : Structures identiques pour tous (🧱 Murs, 📦 Caisses, 🏠 Maisons, 🌳 Arbres)
- **Carte 5000x5000** : Monde massif pour 10 joueurs simultanés

### 📈 DIFFICULTÉ CROISSANTE
- **+10% toutes les 30 secondes** : Le nombre max de monstres et le taux d'apparition augmentent progressivement
- **Système de Vagues** : Difficulté exponentielle pour des hordes massives

### ⚡ SYSTÈME DE BONUS CUMULABLES
- **🏃 Vitesse +** : Bonus permanent de +1 vitesse par niveau
- **⚔️ Dégâts +** : Bonus permanent de +5 dégâts par niveau
- **⚡ Cadence +** : Réduction permanente de -50ms du cooldown par niveau
- **❤️ HP Max +** : Augmentation permanente de +20 HP max par niveau

### 📱 INTERFACE OPTIMISÉE
- **Zéro Scroll** : 100vh, pas de barre de défilement
- **Lobby Dynamique** : Liste en temps réel des joueurs connectés avec emoji et pseudo
- **Input Numérique Natif** : Utilise `<input type="number">` pour forcer le clavier numérique mobile (iOS/Android)
- **Joystick Tactile** : Contrôles fluides sur mobile

### 🎨 RENDU SANS "TRUCS GRIS"
- Tous les éléments visuels utilisent des emojis ou des dégradés avec ombre portée (`shadowBlur`)
- Monstres : Emojis animés avec barres de vie
- Structures : Emojis au lieu de rectangles gris
- Particules et effets visuels colorés

### 📦 PWA READY
- **manifest.json** : Métadonnées pour installation
- **Service Worker** : Cache pour utilisation hors ligne
- **Icônes** : Support pour installation sur écran d'accueil

## 🎯 FONCTIONNALITÉS DU JEU

### Mode Solo
- Combat contre des hordes infinies de zombies
- Système de progression avec niveaux et upgrades
- 8 trophées déblocables

### Mode Multijoueur (jusqu'à 10 joueurs)
- **Héberger une partie** : Génère un code PIN à 6 chiffres
- **Rejoindre une partie** : Entre le code PIN avec clavier natif
- Synchronisation P2P via PeerJS
- Leaderboard en temps réel

### Système de Combat
- Tir automatique vers l'ennemi le plus proche
- Compétence spéciale (Espace) : Explosion de zone
- Régénération passive de HP
- Orbes d'XP magnétiques

### Progression
- Gain d'XP en tuant des monstres
- Montée de niveau avec menu d'amélioration
- 4 types de bonus cumulables à l'infini
- Score basé sur kills et temps de survie

## 📋 FICHIERS INCLUS

1. **index.html** : Structure HTML avec input natif pour PIN
2. **style.css** : Design responsive, glassmorphism, sans scroll
3. **script.js** : Logique complète avec interpolation, collisions, P2P
4. **manifest.json** : Configuration PWA
5. **sw.js** : Service Worker pour cache
6. **README.md** : Ce fichier

## 🚀 INSTALLATION

1. Héberge tous les fichiers sur un serveur web (local ou distant)
2. Ouvre `index.html` dans un navigateur moderne
3. Sur mobile, ajoute le jeu à l'écran d'accueil pour une expérience PWA

## 🎮 CONTRÔLES

### PC
- **ZQSD / WASD / Flèches** : Déplacement
- **Espace** : Compétence spéciale
- **Tir automatique** : Vers l'ennemi le plus proche

### Mobile
- **Joystick** : Déplacement tactile (bas gauche)
- **Bouton 💥** : Compétence spéciale (bas gauche)
- **Tir automatique** : Vers l'ennemi le plus proche

## 🏆 TROPHÉES

- 🩸 Premier Sang : Tue ton premier zombie
- ⏱️ Survivant 5min : Survis 5 minutes
- 🔪 Boucher : Tue 100 zombies
- ⚔️ Massacreur : Tue 1000 zombies (cumulé)
- 🔟 Niveau 10 : Atteins le niveau 10
- 💯 10K Points : Atteins 10000 points
- 🌊 Vague 10 : Atteins la vague 10
- 💚 Santé Parfaite : Termine avec 100% HP

## 🔧 CONFIGURATION TECHNIQUE

### Paramètres Réseau
- **ENEMY_SYNC_RATE** : 33ms (30Hz)
- **INTERPOLATION_SPEED** : 0.15 (lerp fluide)
- **MAX_PLAYERS** : 10

### Paramètres Monde
- **WORLD_SIZE** : 5000x5000
- **STRUCTURE_SEED** : 42 (génération déterministe)

### Paramètres Difficulté
- **DIFFICULTY_INCREASE_INTERVAL** : 30000ms (30 secondes)
- **DIFFICULTY_INCREASE_RATE** : 0.1 (10%)

## 💡 NOTES IMPORTANTES

- Le jeu nécessite une connexion internet pour le mode multijoueur (PeerJS)
- Les données de sauvegarde (high score, trophées) sont stockées en localStorage
- Le mode PWA fonctionne hors ligne une fois les fichiers en cache
- Pour une meilleure performance, utilise Chrome ou Edge sur desktop, Safari sur iOS

## 🐛 BUGS CORRIGÉS

✅ Micro-saccades des objets distants (interpolation ajoutée)
✅ Collisions désactivées (AABB réactivé)
✅ Structures différentes entre joueurs (seed fixe)
✅ Clavier numérique ne s'ouvre pas (input natif)
✅ Scroll sur mobile (100vh strict)
✅ Éléments "gris" (remplacés par emojis)
✅ Tableaux non vidés entre parties (`.length = 0`)
✅ Bonus non cumulables (système de bonuses)
✅ Monstres sans emoji (types avec emojis)
✅ Orbes XP non visibles pour clients (broadcast ajouté)