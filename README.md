# Pancartes vélo sur tracé GPX

Page web autonome qui repère les **panneaux d'entrée d'agglomération** le long d'un tracé GPX, par exemple pour préparer des sprints à la pancarte. Elle ajoute au GPX un waypoint « Entrée [Lieu] » à chaque pancarte, et en option une alerte quelques centaines de mètres avant.

Tout tourne dans le navigateur, sans installation, avec les données OpenStreetMap.

## D'où viennent les positions ?

1. **Pancartes réelles** : les panneaux `traffic_sign=city_limit` (ou `FR:EB10`/`FR:EB20`) cartographiés dans OpenStreetMap à moins de 25 m du tracé. L'outil détermine si c'est une entrée ou une sortie, dans cet ordre de préférence :
   - l'orientation du panneau (`direction` en degrés ou point cardinal, `forward`/`backward` par rapport à la route) ;
   - le côté de la route pour un panneau simple face (`city_limit=begin|end`) : à droite, il s'adresse à nous ;
   - la position du centre du lieu du même nom : si on s'en rapproche, c'est une entrée ;
   - en dernier recours, l'alternance entrée/sortie entre panneaux du même nom, signalée « (?) ».

   Les panneaux d'une route qui croise le tracé sont écartés.
2. **Limites de commune (estimation)** : pour une commune traversée sans pancarte cartographiée, un waypoint « Limite [Commune] » est placé à la frontière administrative. La vraie pancarte est souvent plus loin, à l'entrée du bourg, et une commune traversée en rase campagne n'en a parfois aucune.

La couverture OSM des panneaux varie selon les secteurs. Une pancarte manque ? [Ajoute-la dans OpenStreetMap](https://wiki.openstreetmap.org/wiki/FR:Tag:traffic_sign%3Dcity_limit) : elle sera prise en compte à l'analyse suivante.

## Utilisation

1. Ouvrir la version en ligne (GitHub Pages), ou `index.html` directement dans un navigateur. En local (`file://`), la carte utilise le fond OSM France : les serveurs de tuiles d'openstreetmap.org refusent les pages locales. Le sélecteur en haut à droite de la carte permet de changer de fond, dont CyclOSM, orienté vélo.
2. Charger un fichier `.gpx` (trace `trkpt` ou itinéraire `rtept`).
3. Choisir la méthode, le style des noms et la distance d'alerte, puis lancer l'analyse.
4. Vérifier les pancartes sur la carte, puis télécharger le GPX enrichi, le CSV ou imprimer le roadbook.

Le fichier exporté reprend tout le GPX d'origine (horodatages, waypoints existants, extensions), avec en plus les waypoints de pancarte (`sym` City (Small)), de limite estimée (`sym` Flag, Blue) et d'alerte (`sym` Danger Area). Chaque waypoint a une description `<desc>` qui précise le kilomètre et l'origine de la position.

## Méthodes

| | Rapide (par défaut) | Lente |
|---|---|---|
| Source | Panneaux et limites communales OSM via l'API [Overpass](https://wiki.openstreetmap.org/wiki/Overpass_API) | Géocodage inverse [Nominatim](https://nominatim.org/) |
| Résultat | Pancartes réelles + limites estimées | Limites de commune seulement |
| Durée pour 100 km | quelques secondes | ~5 min (1 requête/s) |
| Précision | ~1 m, passages courts détectés | ~10 m, passages plus courts que le pas parfois ratés |

La méthode rapide essaie plusieurs serveurs Overpass. Si aucun ne répond, l'outil passe automatiquement à la méthode lente.

## Noms pour compteurs GPS

Le style **GPS compact** produit des noms ASCII, abrégés (Saint → St, -sur- → -s/) et limités à 15 caractères, la limite des course points Garmin :

| Complet | Compact |
|---|---|
| Entrée Saint-Sébastien-sur-Loire | St-Sebastien |
| Limite Couëron | ~Coueron |
| ⚠ 500m avant : Couëron | 500m Coueron |

## Options avancées

- **Limites de commune sans pancarte** : décocher pour ne garder que les pancartes réelles.
- **Distance panneau–tracé max** : 25 m par défaut.
- **Passage minimal** : les incursions plus courtes (par défaut 150 m) sont ignorées, par exemple une route qui longe une limite communale.
- **Niveau administratif OSM** : `8` correspond aux communes en France, Belgique, Suisse, Italie, Espagne…

## Développement

La logique (géométrie, limites, détection, noms) est dans `core.js`, testable sans navigateur. `index.html` gère l'interface.

```sh
npm test                  # tests unitaires, dont un parcours réel figé (hors ligne)
npm run test:integration  # requête Overpass réelle
npm run test:e2e          # page complète dans Chrome/Edge headless
```

Aucune dépendance npm : il suffit d'avoir Node.js 22 ou plus récent.
