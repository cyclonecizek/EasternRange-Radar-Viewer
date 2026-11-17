# LLCC Radar Workbench

**Experimental. Not for operational decisions.** A single-file, in-browser radar viewer built around
lightning launch commit criteria (LLCC) evaluation with the WSR (KPSB) Level II files from the RAD WSR API,
with KMLB/NEXRAD and MRMS for comparison.

Everything runs in the browser. There is no server and no Python. Trajectory files never leave the machine.

## Put it online (GitHub web upload)

1. Create a new repository.
2. Upload this whole folder (or at minimum `docs/index.html`).
3. Settings > Pages > Deploy from a branch > `main`, folder `/docs`.

`docs/index.html` also works opened straight from disk (double-click).

## First five minutes

1. **Data** tab > **Load latest** (or **Load last 30 min**, or drop Level II files / a range-download `.zip` on the page).
2. **Temps** tab > **Fetch model profile**. Until you do, a placeholder profile is used and flagged.
3. **Flight path** tab > choose a trajectory file (see `sample/`), or generate a notional path.
4. **LLCC** tab for the radar evidence table. **Cross-section** (or Shift-drag on the map) for a slice;
   pick *Along flight path* in the drawer for a curtain. **3-D** for the volume view.
5. Set **2 panels** and fetch KMLB or MRMS on the Data tab to compare.

Keys: left/right step time, up/down change tilt, space play/pause, Esc closes 3-D.

## If "Load latest" fails

The browser may be refused a direct connection to `codiapi-wsr.rad.spaceforce.mil` (CORS). Two ways round it:

* Download the file or zip in a browser tab (the links in the WSR API guide) and drop it on the page.
* Deploy `relay/worker.js` as a Cloudflare Worker and paste `https://<worker>.workers.dev/?url=` into
  Settings > Connections > Relay. The relay only forwards to the WSR API host.

## What it does

| Area | Detail |
|---|---|
| WSR ingest | latest, last N minutes, archive window, live polling (60 s), local files, range zip. Files that hold only one or two tilts are assembled into volumes from the newest sweep at each elevation (window set in Settings). |
| Moments | REF (QC'd and raw), VEL, SW, ZDR, RhoHV, PhiDP, estimated attenuation (PIA), QC flags |
| Derived products | composite, echo top / base at any dBZ, CAPPI at a height or temperature, layer max, thickness, cloud-top temperature, VIL, height of max Z, VAHIRR. Build your own on the Products tab. |
| Cross-sections | any line, or along the flight path; isotherms; interpolated or beams-only (shows scan gaps) |
| 3-D | dBZ isosurfaces, isotherm planes, flight path, standoff tubes, cross-section curtain |
| Colour tables | editor, GR-style `.pal` import and export |
| QC | speckle, radial spikes, RhoHV, Z/ZDR texture, vertical continuity, second trip, minimum dBZ, PhiDP attenuation correction |
| Comparison | any NEXRAD site from the AWS archive; MRMS 33-level MergedReflectivityQC mosaic |
| Temperatures | Open-Meteo pressure-level profile for the radar time, or paste a sounding (height, temperature) |

## LLCC panel: what it is and is not

It reports **radar evidence** for the cloud-geometry parts of the rules along the uploaded flight path:
flight through radar cloud, nearest radar cloud edge (slant distance) against 3 / 5 / 10 nmi, cumulus
top-temperature classes (-20 C : 10 nmi, -10 C : 5 nmi, -5 C : through), moderate precipitation within
5 nmi, max VAHIRR within 1 nmi of the path against +10 dBZ-km, thick layers (4,500 ft with any part between
0 and -20 C), and cloud colder than -10 C on the path below 3,000 ft/s.

It is **not** a GO / NO-GO. Radar echo is not the visible cloud edge, cloud type is a human call, and
lightning, field-mill and time-since-lightning conditions are not evaluated. VAHIRR follows the published
definition (mean dBZ of grid points at or above 0 dBZ times average cloud thickness in the specified
volume: 5.5 km N/E/S/W of the point, 0 C level to cloud top). **All thresholds are editable defaults;
verify each against the current NASA-STD-4010 revision before relying on them.**

QC caution: over-filtering is the unsafe direction for LLCC. Thin anvil near 0 dBZ can fail dual-pol tests.
The default preset is Light (speckle + spikes only).

## Trajectory files

Text or CSV with a header row. Columns are found by name (time, lat, lon, alt/height, optional speed/velocity)
and units are read from the header (`ft`, `kft`, `m`, `km`; `ft/s`, `m/s`, `kt`). Lines starting with `#` are ignored.

## Test status

Tested: the Level II decoder (byte-exact bzip2 against the system tool) on public NEXRAD files; per-tilt
file assembly, two-radar comparison and the MRMS path against a local mock; GRIB2 PNG decoding against
eccodes-written files; all UI tabs, cross-sections and 3-D in headless Chromium.

Also tested on one real KPSB file (17 Nov 2026 1910Z: 9 tilts 0.5 to 6.4 deg, 1 deg x 252 m, six moments).

Not yet tested: the live WSR API from a browser, multi-file loops, live AWS NEXRAD / MRMS fetches, and the
Open-Meteo profile fetch.

## Rebuild

Edit files in `src/`, then `python build.py` rewrites `docs/index.html`. three.js (MIT licence) is vendored in `vendor/`.
