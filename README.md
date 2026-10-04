# Seerah Timeline

An editable timeline of the life of the Prophet Muhammad ﷺ. It is built to show
**what happened at the same time**, in his life, among his family and
companions, in the battles and treaties, and in the wider world (Byzantium,
Persia, China, India, Europe).

## Features

- **Timeline view.** Each category is a lane on one shared time axis, so events
  that happened together line up vertically. Events with a single date show as
  dots, and events that lasted a while show as bars. The axis shows CE years,
  the approximate Hijri year (AH, or BH for before the Hijrah), and the Meccan
  and Madinan periods.
- **"Around the same time".** Click any event to highlight a time window around
  it on the timeline and list every other event in that window, grouped by
  category. The window can be "overlapping in time", ±1 year, ±2 years or
  ±5 years.
- **Year-by-year view.** A table with one row per year and one column per
  category. Long events show as "↳ continuing" in every year they cover.
- **Add, edit and delete events.** Each event has a title, category, start and
  optional end (year with an optional month), an "approximate date" flag,
  location, description and sources. The form shows the Hijri year and the
  Prophet's age as you type.
- **Manage categories.** Add, rename, recolour, reorder and delete lanes.
- **Filters and search.** Click the category chips to show or hide lanes
  (Alt/⌘-click shows only that lane), and search by text across titles,
  locations, descriptions and sources.
- **Your data stays in your browser** (localStorage). Use **⋯ → Export** to
  download a JSON backup, and **Import** to load it on another device or share
  it. **Reset to sample data** brings back the starting set of about 75 events.
- Keyboard: **← / →** step through events in date order and **Esc** clears the
  selection. **Ctrl/⌘ + scroll** zooms the timeline, and **double-clicking**
  an event opens it for editing.

## Running it

The app is plain HTML, CSS and JavaScript with no build step and no
dependencies.

- Open `index.html` in a browser, or
- serve the folder locally, for example `python3 -m http.server`, then open
  <http://localhost:8000>, or
- host it for free on **GitHub Pages**: in the repo go to *Settings → Pages*,
  set *Deploy from a branch*, and choose the branch and `/ (root)`.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page layout and the add/edit dialogs |
| `css/styles.css` | Styles, with light and dark themes and a mobile layout |
| `js/app.js` | Rendering, editing, storage, import and export |
| `js/seed-data.js` | The sample events and categories |

## A note on dates

Many dates in the Seerah are approximate, and the classical sources sometimes
disagree, especially for the years before the Hijrah. The sample data follows
the commonly cited chronology and marks uncertain dates as approximate. Please
check it against the sources you rely on and edit it as needed. Hijri years are
calculated with the tabular Islamic calendar, so they can be off by a few days
at the edges of a year.

## Data format

The export is a JSON file with this shape:

```json
{
  "version": 1,
  "categories": [{ "id": "life", "name": "Prophet's Life", "color": "#0f766e" }],
  "events": [{
    "id": "e29",
    "title": "Battle of Badr",
    "category": "battles",
    "startYear": 624, "startMonth": 3,
    "endYear": null, "endMonth": null,
    "approximate": false,
    "location": "Badr",
    "description": "17 Ramadan, 2 AH…",
    "sources": ""
  }]
}
```
