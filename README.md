# Pancartes vélo sur tracé GPX

Page web autonome qui détecte chaque entrée de commune le long d'un tracé GPX et ajoute un waypoint « Entrée [Commune] » à chaque frontière. On peut aussi ajouter une alerte quelques centaines de mètres avant.

Tout tourne dans le navigateur, sans installation, avec les données OpenStreetMap.

## Utilisation

1. Ouvrir `index.html` dans un navigateur, ou la version en ligne via GitHub Pages.
2. Charger un fichier `.gpx` (trace `trkpt` ou itinéraire `rtept`).
3. Choisir la méthode, le style des noms et la distance d'alerte, puis lancer l'analyse.
4. Vérifier les pancartes sur la carte, puis télécharger le GPX enrichi, le CSV ou imprimer le roadbook.

Le fichier exporté reprend tout le GPX d'origine (horodatages, waypoints existants, extensions), avec en plus les waypoints de pancarte (`sym` City (Small)) et d'alerte (`sym` Danger Area). Chaque waypoint a une description `<desc>` qui donne le kilomètre et la commune précédente.

## Méthodes

| | Rapide (par défaut) | Lente |
|---|---|---|
| Source | Limites communales OSM via l'API [Overpass](https://wiki.openstreetmap.org/wiki/Overpass_API) | Géocodage inverse [Nominatim](https://nominatim.org/) |
| Durée pour 100 km | quelques secondes | ~5 min (1 requête/s) |
| Précision | ~1 m, passages courts détectés | ~10 m, passages plus courts que le pas parfois ratés |

La méthode rapide essaie plusieurs serveurs Overpass. Si aucun ne répond, l'outil passe automatiquement à la méthode lente.

## Noms pour compteurs GPS

Le style **GPS compact** produit des noms ASCII, abrégés (Saint → St, -sur- → -s/) et limités à 15 caractères, la limite des course points Garmin :

| Complet | Compact |
|---|---|
| Entrée Saint-Sébastien-sur-Loire | St-Sebastien |
| ⚠ 500m avant : Couëron | 500m Coueron |

## Options avancées

- **Passage minimal** : les incursions plus courtes (par défaut 50 m) sont ignorées, par exemple une route qui longe une limite communale.
- **Niveau administratif OSM** : `8` correspond aux communes en France, Belgique, Suisse, Italie, Espagne…

## Développement

La logique (géométrie, limites, détection, noms) est dans `core.js`, testable sans navigateur. `index.html` gère l'interface.

```sh
npm test                  # tests unitaires (hors ligne)
npm run test:integration  # requête Overpass réelle
npm run test:e2e          # page complète dans Chrome/Edge headless
```

Aucune dépendance npm : il suffit d'avoir Node.js 22 ou plus récent.
