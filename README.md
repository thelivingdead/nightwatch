# Night Watch

Night Watch is a static website for walking home in London after dark. It plots street-level crime from [police.uk](https://data.police.uk/) on a Leaflet map, then scores walking routes so you can choose a faster path or a quieter one. The city sleeps. We don't.

The main site is `index.html`. A companion page, `details.html`, covers how the watch is meant to work. This repository is the static map itself: HTML, CSS and vanilla JavaScript, with no npm build.

## Features

- **Crime layers** — dots coloured by type, a heatmap when zoomed in, hex areas when zoomed out. Optional DBSCAN hotspots run in the browser.
- **Route planner** — search a place (Photon / OpenStreetMap), pick start and end, and compare **Fastest**, **Balanced** and **Safest** walks from FOSSGIS OSRM. Incidents within about 40 m of the path count toward the score.
- **London overview** — borough ranking for the current month.
- **London's Darkest Streets** — ranked street list from `data/darkest-streets.json`, filterable by borough and crime type.
- **Insights** — sidebar panel from `js/data/insights.js`: crime mix, concentration on a 200 m grid (including a Lorenz curve and Gini), Getis-Ord Gi\* violent-crime hot cells (off the map by default), borough location quotients, and a PCA scatter of similar boroughs. Figures are computed from the loaded month, not hardcoded.
- **Details page** — ingest, scoring, routing and clustering notes, plus a sketched production stack and schema. The running site does not use that backend.



```bash
git clone <repository-url>
cd nightswatch
python3 -m http.server 8137
```

Open [http://127.0.0.1:8137/](http://127.0.0.1:8137/). Serve from the project root so `css/`, `js/`, `data/` and `media/` resolve.

Routing, geocoding and map tiles are loaded from the public services below, so the planner needs a network connection.

## Project layout

```
index.html              Map, planner and Insights
details.html            How it works, stack notes, data model
css/styles.css
js/app.js               Hero, clock, tonight's watch
js/map.js               Map, layers, routing, darkest streets
js/insights.js          Insights sidebar (reads precomputed data)
js/intro.js             Intro cover
js/details.js           Details page
js/sheet-resize.js      Planner panel width
js/data/london.js       Snapped crime points and borough totals
js/data/boroughs.js     Borough outlines
js/data/insights.js     Precomputed Insights payload
data/london.json        Full street-level records (used for raw dots)
data/darkest-streets.json
scripts/update-london.mjs
scripts/rank-streets.mjs
scripts/build_london.py
scripts/build_insights.py
media/                  Intro video, poster, mark and favicon
```

## Data

Street-level crime comes from the [police.uk API](https://data.police.uk/docs/). The refresh scripts take the month from police.uk (`crime-last-updated` in the Node updater; `crimes-street-dates` in the Python builder). Locations are the approximate snap points police.uk publishes, not exact addresses. Records typically arrive about a month late. Night Watch shows what has been reported, not what will happen tonight.

Borough outlines are Local Authority Districts (ONS) for the 33 London areas, including the City of London.




## Credits

Crime data from [police.uk](https://data.police.uk/), containing public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, basemap © [Esri](https://www.esri.com/). Walking routes by [FOSSGIS OSRM](https://routing.openstreetmap.de/about.html).
