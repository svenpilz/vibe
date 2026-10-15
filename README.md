# Berlin Micromapping Visualizer

A TypeScript app that renders Geofabrik's Berlin osm.pbf with a focus on area:highway micromapping.

## Quick start

```bash
npm install
npm run data     # downloads berlin-latest.osm.pbf (~100 MB) + extracts data/map.jsonl
npm run dev      # serves the app at http://localhost:5173
```

Scroll to zoom, drag to pan, click any feature to inspect its tags.
