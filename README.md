# Pancartes vélo sur tracé GPX

Page web autonome qui détecte chaque entrée de commune le long d'un tracé GPX et ajoute un waypoint « Entrée [Commune] » à chaque frontière. On peut aussi ajouter une alerte quelques centaines de mètres avant.

Tout tourne dans le navigateur, sans installation. Le géocodage inverse passe par l'API publique [Nominatim](https://nominatim.org/) (OpenStreetMap), limitée à environ 1 requête par seconde.

## Utilisation

1. Ouvrir `index.html` dans un navigateur, ou la version en ligne via GitHub Pages.
2. Charger un fichier `.gpx` (trace `trkpt` ou itinéraire `rtept`).
3. Régler le pas d'échantillonnage et la distance d'alerte, puis lancer l'analyse.
4. Vérifier les pancartes sur la carte et télécharger le GPX enrichi.

Le fichier exporté reprend tout le GPX d'origine (horodatages, waypoints existants, extensions), avec en plus les waypoints de pancarte (`sym` City) et d'alerte (`sym` Waypoint-caution).

## Limites

- Si un passage dans une commune est plus court que le pas d'échantillonnage, il peut ne pas être détecté.
- Un tracé de 100 km avec un pas de 400 m demande environ 5 minutes d'analyse.
