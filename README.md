# Aldilà — expérience narrative

Expérience web en 3D pour ordinateur et casque compatible WebXR. La scène utilise Three.js et SparkJS, chargés depuis leurs CDN via la carte d’import HTML.

## Lancer le projet

Le projet doit être servi en HTTP ou HTTPS. Depuis ce dossier, démarrez par exemple le serveur Python intégré :

```bash
python3 -m http.server 8000
```

Ouvrez ensuite <http://localhost:8000>. Pour accéder à la caméra ou à WebXR depuis un autre appareil, utilisez une connexion HTTPS.

## Organisation

- `index.html` : écran d’accueil, éléments de l’interface et carte d’import.
- `css/styles.css` : règles globales et couche de rendu.
- `css/home.css` : écran d’accueil et choix de langue.
- `css/experience.css` : chargement, détection du marqueur et commandes XR.
- `js/home.js` : point d’entrée de l’accueil.
- `js/home/fog.js` et `js/home/language.js` : brume interactive et traductions.
- `js/main.js` : orchestration du chargement de scène, du rendu et des modes PC/AR.
- `js/scene.js` : caméra, renderer Three.js et limites de déplacement.
- `js/audio.js` : musique, ambiances et sons associés aux interactions.
- `js/interactions.js` : sélection des objets, contrôleurs XR et mains.
- `js/marker-detection.js` : caméra et détection de la carte `assets/images/Carte_Berger.jpg`.
- `js/model-materials.js` : matériaux, textures et lueur des modèles.
- `data/scene.json` : manifeste de scène, modèles, sons et transformations.
- `assets/` : images, modèles, sons et scène Gaussian splat.

## Modes et commandes

- **PC** : lance directement l’expérience sur ordinateur.
- **VR** : active le mode caméra et attend la détection du marqueur avant l’entrée en AR.
- **Casque** : pointez le contrôleur ou une main vers la sacoche et utilisez la gâchette pour déclencher la révélation du berger.
- Le bouton de musique permet d’activer ou de couper les sons après le démarrage de l’expérience.

Le mode PC peut aussi être ouvert directement avec `?pc`. L’accès caméra et WebXR dépend du navigateur et de l’appareil.
