# UbicaFarma

Proof of concept for finding products inside a pharmacy branch. Search a product and see exactly where it sits on a 3D map of the store: zone, aisle, shelf and level. An admin mode lets each branch define its own layout and placements.

All data is simulated (`data/demo-data.js`); there is no ERP integration yet.

## Run

It is a static site with no build step. Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
```

Built with Three.js (3D scene, orbit controls, 2D labels) and Bootstrap.
